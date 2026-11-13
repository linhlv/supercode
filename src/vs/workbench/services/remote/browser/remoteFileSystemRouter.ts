/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { newWriteableStream, ReadableStreamEvents } from '../../../../base/common/stream.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { DiskFileSystemProviderClient } from '../../../../platform/files/common/diskFileSystemProviderClient.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileAtomicReadOptions, IFileChange, IFileDeleteOptions, IFileOpenOptions, IFileOverwriteOptions, IFileReadStreamOptions, IFileRealpathOptions, IFileSystemProviderWithFileAtomicReadCapability, IFileSystemProviderWithFileAtomicRenameCapability, IFileSystemProviderWithFileCloneCapability, IFileSystemProviderWithFileFolderCopyCapability, IFileSystemProviderWithFileReadStreamCapability, IFileSystemProviderWithFileReadWriteCapability, IFileSystemProviderWithOpenReadWriteCloseCapability, IFileWriteOptions, IStat, IWatchOptions } from '../../../../platform/files/common/files.js';
import { IMultiRemoteService, IRemoteHostConnection } from '../common/multiRemoteService.js';
import { RemoteFileSystemProviderClient } from '../common/remoteFileSystemProviderClient.js';

interface IHostClient {
	readonly connection: IRemoteHostConnection['connection'];
	readonly client: DiskFileSystemProviderClient;
	readonly store: DisposableStore;
	/** Active watchers on this client, keyed by watch id. */
	readonly watchers: Map<number, IDisposable>;
}

interface IWatchRequest {
	readonly authority: string;
	readonly resource: URI;
	readonly opts: IWatchOptions;
}

/**
 * A single `vscode-remote` file system provider that routes every call to the
 * remote host identified by the authority of the resource, so that a local
 * window can work with folders from several hosts at once.
 */
export class RemoteFileSystemRouter extends Disposable implements
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithOpenReadWriteCloseCapability,
	IFileSystemProviderWithFileReadStreamCapability,
	IFileSystemProviderWithFileFolderCopyCapability,
	IFileSystemProviderWithFileAtomicReadCapability,
	IFileSystemProviderWithFileAtomicRenameCapability,
	IFileSystemProviderWithFileCloneCapability {

	readonly onDidChangeCapabilities = Event.None;

	readonly capabilities: FileSystemProviderCapabilities =
		FileSystemProviderCapabilities.FileReadWrite |
		FileSystemProviderCapabilities.FileOpenReadWriteClose |
		FileSystemProviderCapabilities.FileReadStream |
		FileSystemProviderCapabilities.FileFolderCopy |
		FileSystemProviderCapabilities.FileWriteUnlock |
		FileSystemProviderCapabilities.FileAtomicRead |
		FileSystemProviderCapabilities.FileAtomicWrite |
		FileSystemProviderCapabilities.FileAtomicDelete |
		FileSystemProviderCapabilities.FileAtomicRename |
		FileSystemProviderCapabilities.FileAppend |
		FileSystemProviderCapabilities.FileClone |
		FileSystemProviderCapabilities.FileRealpath |
		FileSystemProviderCapabilities.PathCaseSensitive;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private readonly _onDidWatchError = this._register(new Emitter<string>());
	readonly onDidWatchError = this._onDidWatchError.event;

	/** Keyed by lowercased authority. */
	private readonly clients = new Map<string, IHostClient>();
	private readonly watches = new Map<number, IWatchRequest>();
	private readonly fds = new Map<number, { readonly host: IHostClient; readonly innerFd: number }>();
	private nextFd = 1;
	private nextWatchId = 1;

	constructor(
		private readonly multiRemoteService: IMultiRemoteService,
		private readonly createClient: (host: IRemoteHostConnection) => DiskFileSystemProviderClient = h => RemoteFileSystemProviderClient.create(h.environment, h.connection),
		private readonly getHostLabel: (authority: string) => string = authority => authority
	) {
		super();

		this._register(this.multiRemoteService.onDidChangeHostState(status => this.syncHost(status.authority.toLowerCase())));
		this._register(toDisposable(() => {
			for (const key of [...this.clients.keys()]) {
				this.dropClient(key);
			}
		}));
	}

	//#region Routing

	private unavailable(authority: string): Error {
		return createFileSystemProviderError(localize('hostNotConnected', "{0} is not connected yet.", this.getHostLabel(authority)), FileSystemProviderErrorCode.Unavailable);
	}

	/** Starts connecting a host that was never touched before. */
	private connectIfUntouched(authority: string): void {
		if (this.multiRemoteService.getState(authority) === undefined) {
			this.multiRemoteService.connect(authority).catch(() => { /* surfaced through host state */ });
		}
	}

	/** Makes the held client match the host's current connection and returns it, if connected. */
	private syncHost(key: string): IHostClient | undefined {
		const connected = this.multiRemoteService.getConnected(key);
		const existing = this.clients.get(key);

		if (existing && existing.connection === connected?.connection) {
			return existing;
		}
		if (existing) {
			this.dropClient(key);
		}
		if (!connected) {
			return undefined;
		}

		const store = new DisposableStore();
		const client = store.add(this.createClient(connected));
		store.add(client.onDidChangeFile(e => this._onDidChangeFile.fire(e)));
		store.add(client.onDidWatchError(e => this._onDidWatchError.fire(e)));
		const host: IHostClient = { connection: connected.connection, client, store, watchers: new Map() };
		this.clients.set(key, host);

		for (const [id, request] of this.watches) {
			if (request.authority === key) {
				host.watchers.set(id, client.watch(request.resource, request.opts));
			}
		}

		return host;
	}

	private dropClient(key: string): void {
		const host = this.clients.get(key);
		if (host) {
			this.clients.delete(key);
			for (const [fd, entry] of this.fds) {
				if (entry.host === host) {
					this.fds.delete(fd);
				}
			}
			// The connection is gone, so unwatch calls on it are skipped.
			host.store.dispose();
		}
	}

	private getHost(resource: URI): IHostClient {
		const key = resource.authority.toLowerCase();
		const host = this.syncHost(key);
		if (host) {
			return host;
		}

		this.connectIfUntouched(key);
		throw this.unavailable(resource.authority);
	}

	private getClient(resource: URI): DiskFileSystemProviderClient {
		return this.getHost(resource).client;
	}

	private checkSameHost(resource: URI, target: URI): void {
		if (resource.authority.toLowerCase() !== target.authority.toLowerCase()) {
			throw createFileSystemProviderError(localize('crossHost', "Moving or copying between different remote machines isn't supported yet."), FileSystemProviderErrorCode.Unavailable);
		}
	}

	private getFd(fd: number): { readonly host: IHostClient; readonly innerFd: number } {
		const entry = this.fds.get(fd);
		if (!entry) {
			throw createFileSystemProviderError(localize('staleHandle', "The file handle is no longer valid."), FileSystemProviderErrorCode.Unavailable);
		}
		return entry;
	}

	//#endregion

	//#region File Metadata Resolving

	async stat(resource: URI): Promise<IStat> {
		return this.getClient(resource).stat(resource);
	}

	async realpath(resource: URI, options?: IFileRealpathOptions): Promise<string> {
		return this.getClient(resource).realpath(resource, options);
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		return this.getClient(resource).readdir(resource);
	}

	//#endregion

	//#region File Reading/Writing

	async readFile(resource: URI, opts?: IFileAtomicReadOptions): Promise<Uint8Array> {
		return this.getClient(resource).readFile(resource, opts);
	}

	readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		try {
			return this.getClient(resource).readFileStream(resource, opts, token);
		} catch (error) {
			const stream = newWriteableStream<Uint8Array>(data => data[0]);
			stream.error(error);
			stream.end();
			return stream;
		}
	}

	async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		return this.getClient(resource).writeFile(resource, content, opts);
	}

	async open(resource: URI, opts: IFileOpenOptions): Promise<number> {
		const host = this.getHost(resource);
		const innerFd = await host.client.open(resource, opts);
		const fd = this.nextFd++;
		this.fds.set(fd, { host, innerFd });
		return fd;
	}

	async close(fd: number): Promise<void> {
		const { host, innerFd } = this.getFd(fd);
		this.fds.delete(fd);
		return host.client.close(innerFd);
	}

	async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const { host, innerFd } = this.getFd(fd);
		return host.client.read(innerFd, pos, data, offset, length);
	}

	async write(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const { host, innerFd } = this.getFd(fd);
		return host.client.write(innerFd, pos, data, offset, length);
	}

	//#endregion

	//#region Move/Copy/Delete/Create Folder

	async mkdir(resource: URI): Promise<void> {
		return this.getClient(resource).mkdir(resource);
	}

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		return this.getClient(resource).delete(resource, opts);
	}

	async rename(resource: URI, target: URI, opts: IFileOverwriteOptions): Promise<void> {
		this.checkSameHost(resource, target);
		return this.getClient(resource).rename(resource, target, opts);
	}

	async renameFileAtomic(resource: URI, target: URI, opts: IFileOverwriteOptions): Promise<void> {
		this.checkSameHost(resource, target);
		return this.getClient(resource).renameFileAtomic(resource, target, opts);
	}

	async copy(resource: URI, target: URI, opts: IFileOverwriteOptions): Promise<void> {
		this.checkSameHost(resource, target);
		return this.getClient(resource).copy(resource, target, opts);
	}

	async cloneFile(resource: URI, target: URI): Promise<void> {
		this.checkSameHost(resource, target);
		return this.getClient(resource).cloneFile(resource, target);
	}

	//#endregion

	//#region File Watching

	watch(resource: URI, opts: IWatchOptions): IDisposable {
		const id = this.nextWatchId++;
		const key = resource.authority.toLowerCase();
		this.watches.set(id, { authority: key, resource, opts });

		// Establishes the watcher right away when connected; otherwise it is
		// established once the host connects (see `syncHost`).
		const existing = this.clients.get(key);
		const host = this.syncHost(key);
		if (host && host === existing) {
			host.watchers.set(id, host.client.watch(resource, opts));
		} else if (!host) {
			this.connectIfUntouched(key);
		}

		return toDisposable(() => {
			this.watches.delete(id);
			const current = this.clients.get(key);
			const watcher = current?.watchers.get(id);
			current?.watchers.delete(id);
			try {
				watcher?.dispose();
			} catch (error) {
				onUnexpectedError(error);
			}
		});
	}

	//#endregion
}

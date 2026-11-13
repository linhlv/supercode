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
import { IMultiRemoteService, IRemoteHostConnection, RemoteHostState } from '../common/multiRemoteService.js';
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

		this._register(this.multiRemoteService.onDidChangeHostState(status => this.syncHost(status.authority)));
		this._register(toDisposable(() => {
			for (const key of [...this.clients.keys()]) {
				this.dropClient(key);
			}
		}));
	}

	//#region Routing

	private unavailable(authority: string): Error {
		const state = this.multiRemoteService.getState(authority);
		const message = state === RemoteHostState.Connecting || state === RemoteHostState.Reconnecting
			? localize('hostNotConnected', "{0} is not connected yet.", this.getHostLabel(authority))
			: localize('hostUnavailable', "{0} is unavailable.", this.getHostLabel(authority));
		return createFileSystemProviderError(message, FileSystemProviderErrorCode.Unavailable);
	}

	/** Starts connecting a host that was never touched before. The authority is passed on exactly as written. */
	private connectIfUntouched(authority: string): void {
		if (this.multiRemoteService.getState(authority) === undefined) {
			this.multiRemoteService.connect(authority).catch(() => { /* surfaced through host state */ });
		}
	}

	/**
	 * Makes the held client match the host's current connection and returns it, if connected.
	 * While the host is reconnecting on the same connection, the client (with its file
	 * descriptors and watchers) is kept so it keeps working once the connection is back.
	 */
	private syncHost(authority: string): IHostClient | undefined {
		const key = authority.toLowerCase();
		const connected = this.multiRemoteService.getConnected(authority);
		let host = this.clients.get(key);

		if (host && connected && host.connection !== connected.connection) {
			this.dropClient(key);
			host = undefined;
		}

		if (!connected) {
			const state = this.multiRemoteService.getState(authority);
			if (host && state !== RemoteHostState.Reconnecting && state !== RemoteHostState.Connecting) {
				this.dropClient(key);
			}
			return undefined;
		}

		if (!host) {
			const store = new DisposableStore();
			const client = store.add(this.createClient(connected));
			store.add(client.onDidChangeFile(e => this._onDidChangeFile.fire(e)));
			store.add(client.onDidWatchError(e => this._onDidWatchError.fire(e)));
			host = { connection: connected.connection, client, store, watchers: new Map() };
			this.clients.set(key, host);
		}

		// Issue watches that are not yet active on this client
		for (const [id, request] of this.watches) {
			if (request.authority === key && !host.watchers.has(id)) {
				host.watchers.set(id, host.client.watch(request.resource, request.opts));
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
			// The connection is gone or replaced, so unwatch calls on it are skipped.
			host.store.dispose();
		}
	}

	private getHost(resource: URI): IHostClient {
		const host = this.syncHost(resource.authority);
		if (host) {
			return host;
		}

		this.connectIfUntouched(resource.authority);
		throw this.unavailable(resource.authority);
	}

	/**
	 * Runs a call on the client of the resource's host. A call that the host dropping
	 * cut off fails like a call to a host that is not connected.
	 */
	private async callHost<T>(resource: URI, call: (client: DiskFileSystemProviderClient) => Promise<T>): Promise<T> {
		const host = this.getHost(resource);
		try {
			return await call(host.client);
		} catch (error) {
			if (this.clients.get(resource.authority.toLowerCase()) !== host) {
				throw this.unavailable(resource.authority);
			}
			throw error;
		}
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
		return this.callHost(resource, client => client.stat(resource));
	}

	async realpath(resource: URI, options?: IFileRealpathOptions): Promise<string> {
		return this.callHost(resource, client => client.realpath(resource, options));
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		return this.callHost(resource, client => client.readdir(resource));
	}

	//#endregion

	//#region File Reading/Writing

	async readFile(resource: URI, opts?: IFileAtomicReadOptions): Promise<Uint8Array> {
		return this.callHost(resource, client => client.readFile(resource, opts));
	}

	readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		try {
			return this.getHost(resource).client.readFileStream(resource, opts, token);
		} catch (error) {
			const stream = newWriteableStream<Uint8Array>(data => data[0]);
			stream.error(error);
			stream.end();
			return stream;
		}
	}

	async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		return this.callHost(resource, client => client.writeFile(resource, content, opts));
	}

	async open(resource: URI, opts: IFileOpenOptions): Promise<number> {
		const host = this.getHost(resource);
		const innerFd = await this.callHost(resource, client => client.open(resource, opts));
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
		return this.callHost(resource, client => client.mkdir(resource));
	}

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		return this.callHost(resource, client => client.delete(resource, opts));
	}

	async rename(resource: URI, target: URI, opts: IFileOverwriteOptions): Promise<void> {
		this.checkSameHost(resource, target);
		return this.callHost(resource, client => client.rename(resource, target, opts));
	}

	async renameFileAtomic(resource: URI, target: URI, opts: IFileOverwriteOptions): Promise<void> {
		this.checkSameHost(resource, target);
		return this.callHost(resource, client => client.renameFileAtomic(resource, target, opts));
	}

	async copy(resource: URI, target: URI, opts: IFileOverwriteOptions): Promise<void> {
		this.checkSameHost(resource, target);
		return this.callHost(resource, client => client.copy(resource, target, opts));
	}

	async cloneFile(resource: URI, target: URI): Promise<void> {
		this.checkSameHost(resource, target);
		return this.callHost(resource, client => client.cloneFile(resource, target));
	}

	//#endregion

	//#region File Watching

	watch(resource: URI, opts: IWatchOptions): IDisposable {
		const id = this.nextWatchId++;
		const key = resource.authority.toLowerCase();
		this.watches.set(id, { authority: key, resource, opts });

		// Establishes the watcher right away when connected; otherwise it is
		// established once the host connects (see `syncHost`).
		if (!this.syncHost(resource.authority)) {
			this.connectIfUntouched(resource.authority);
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

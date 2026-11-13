/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DiskFileSystemProviderClient } from '../../../../../platform/files/common/diskFileSystemProviderClient.js';
import { createFileSystemProviderError, FileChangeType, FileSystemProviderCapabilities, FileSystemProviderErrorCode, IFileChange, IStat, IWatchOptions, FileType, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { IRemoteAgentEnvironment } from '../../../../../platform/remote/common/remoteAgentEnvironment.js';
import { RemoteFileSystemRouter } from '../../browser/remoteFileSystemRouter.js';
import { IMultiRemoteService, IRemoteHostConnection, IRemoteHostStatus, RemoteHostState } from '../../common/multiRemoteService.js';
import { IRemoteAgentConnection } from '../../common/remoteAgentService.js';

class FakeClient extends mock<DiskFileSystemProviderClient>() {
	readonly calls: string[] = [];
	readonly watches: { resource: URI; opts: IWatchOptions }[] = [];
	readonly changeEmitter = new Emitter<readonly IFileChange[]>();
	override readonly onDidChangeFile = this.changeEmitter.event;
	override readonly onDidWatchError = new Emitter<string>().event;
	disposed = false;
	/** When set, `readFile` settles with this promise. */
	readFileResult: Promise<Uint8Array> | undefined;

	constructor(private readonly fd = 1) {
		super();
	}

	override async stat(resource: URI): Promise<IStat> {
		this.calls.push(`stat ${resource.path}`);
		return { type: FileType.File, ctime: 0, mtime: 0, size: 0 };
	}
	override async readFile(resource: URI): Promise<Uint8Array> {
		this.calls.push(`readFile ${resource.path}`);
		return this.readFileResult ?? new Uint8Array();
	}
	override async open(): Promise<number> {
		this.calls.push('open');
		return this.fd;
	}
	override async read(fd: number): Promise<number> {
		this.calls.push(`read ${fd}`);
		return 0;
	}
	override async close(fd: number): Promise<void> {
		this.calls.push(`close ${fd}`);
	}
	override async rename(): Promise<void> {
		this.calls.push('rename');
	}
	override async copy(): Promise<void> {
		this.calls.push('copy');
	}
	override watch(resource: URI, opts: IWatchOptions): IDisposable {
		this.watches.push({ resource, opts });
		return { dispose: () => { } };
	}
	override dispose(): void {
		this.disposed = true;
		this.changeEmitter.dispose();
	}
}

class FakeConnection extends mock<IRemoteAgentConnection>() { }

class StubMultiRemoteService extends mock<IMultiRemoteService>() {
	override readonly isEnabled = true;
	readonly connected = new Map<string, IRemoteHostConnection>();
	readonly states = new Map<string, RemoteHostState>();
	connectCalls: string[] = [];
	readonly emitter = new Emitter<IRemoteHostStatus>();
	override readonly onDidChangeHostState = this.emitter.event;

	setConnected(authority: string, connection = new FakeConnection()): void {
		this.states.set(authority.toLowerCase(), RemoteHostState.Connected);
		this.connected.set(authority.toLowerCase(), { authority, connection, environment: {} as IRemoteAgentEnvironment });
	}
	override getState(authority: string): RemoteHostState | undefined {
		return this.states.get(authority.toLowerCase());
	}
	override getConnected(authority: string): IRemoteHostConnection | undefined {
		return this.connected.get(authority.toLowerCase());
	}
	override async connect(authority: string): Promise<IRemoteHostConnection> {
		this.connectCalls.push(authority);
		throw new Error('connect failed');
	}
}

suite('RemoteFileSystemRouter', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const A = 'ssh-remote+a';
	const B = 'ssh-remote+b';
	const uri = (authority: string, path = '/srv/app') => URI.from({ scheme: 'vscode-remote', authority, path });

	let service: StubMultiRemoteService;
	let clients: FakeClient[];
	let byConnection: Map<IRemoteAgentConnection, FakeClient>;
	let fds: number[];

	function create(): RemoteFileSystemRouter {
		return store.add(new RemoteFileSystemRouter(service, host => {
			const client = new FakeClient(fds.shift() ?? 1);
			clients.push(client);
			byConnection.set(host.connection, client);
			return client;
		}));
	}

	function clientOf(authority: string): FakeClient {
		return byConnection.get(service.getConnected(authority)!.connection)!;
	}

	setup(() => {
		service = new StubMultiRemoteService();
		store.add(service.emitter);
		clients = [];
		byConnection = new Map();
		fds = [];
	});

	test('routes each call to the client of the URI authority', async () => {
		service.setConnected(A);
		service.setConnected(B);
		const router = create();

		await router.stat(uri(A));
		await router.stat(uri(B, '/other'));

		assert.deepStrictEqual({ a: clientOf(A).calls, b: clientOf(B).calls }, { a: ['stat /srv/app'], b: ['stat /other'] });
	});

	test('capabilities include PathCaseSensitive and exclude Trash', () => {
		const router = create();
		assert.strictEqual(!!(router.capabilities & FileSystemProviderCapabilities.PathCaseSensitive), true);
		assert.strictEqual(!!(router.capabilities & FileSystemProviderCapabilities.Trash), false);
	});

	test('authority match is case-insensitive', async () => {
		service.setConnected(A);
		const router = create();

		await router.stat(uri('ssh-remote+A'));

		assert.deepStrictEqual(clientOf(A).calls, ['stat /srv/app']);
	});

	test('unconnected host fails fast with Unavailable', async () => {
		const router = create();

		await assert.rejects(router.readFile(uri(A)), (e: Error) => {
			assert.strictEqual(toFileSystemProviderErrorCode(e), FileSystemProviderErrorCode.Unavailable);
			assert.ok(e.message.includes(A));
			return true;
		});
		assert.deepStrictEqual(service.connectCalls, [A]);
	});

	test('a host that may not connect automatically is never connected by a file call or watch', async () => {
		const allowed = [A];
		const router = store.add(new RemoteFileSystemRouter(service, undefined, undefined, authority => allowed.includes(authority)));

		const message = await router.stat(uri(B)).then(() => undefined, (e: Error) => e.message);
		store.add(router.watch(uri(B), { recursive: false, excludes: [] }));
		await assert.rejects(router.stat(uri(A)));

		assert.deepStrictEqual({ message, connectCalls: service.connectCalls }, { message: `${B} is unavailable.`, connectCalls: [A] });
	});

	test('failed host fails fast without reconnecting', async () => {
		service.states.set(A, RemoteHostState.Failed);
		const router = create();

		await assert.rejects(router.readFile(uri(A)), (e: Error) => toFileSystemProviderErrorCode(e) === FileSystemProviderErrorCode.Unavailable);
		assert.deepStrictEqual(service.connectCalls, []);
	});

	test('a failed or disconnected host is unavailable, a connecting one is not connected yet', async () => {
		const C = 'ssh-remote+c';
		service.states.set(A, RemoteHostState.Failed);
		service.states.set(B, RemoteHostState.Disconnected);
		service.states.set(C, RemoteHostState.Connecting);
		const router = store.add(new RemoteFileSystemRouter(service, undefined, authority => `SSH: ${authority.substring('ssh-remote+'.length)}@box`));
		const messageOf = (authority: string) => router.stat(uri(authority)).then(() => undefined, (e: Error) => e.message);

		assert.deepStrictEqual([await messageOf(A), await messageOf(B), await messageOf(C)], [
			'SSH: a@box is unavailable.',
			'SSH: b@box is unavailable.',
			'SSH: c@box is not connected yet.'
		]);
	});

	test('a call cut off by the host failing fails with Unavailable naming the host', async () => {
		service.setConnected(A);
		service.setConnected(B);
		const router = create();
		await router.stat(uri(A));
		await router.stat(uri(B));
		const inFlightA = new DeferredPromise<Uint8Array>();
		clientOf(A).readFileResult = inFlightA.p;
		const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (e: Error) => ({ code: toFileSystemProviderErrorCode(e), namesHost: e.message.includes(A) }));

		const readingA = errorOf(router.readFile(uri(A)));
		service.connected.delete(A);
		service.states.set(A, RemoteHostState.Failed);
		service.emitter.fire({ authority: A, state: RemoteHostState.Failed });
		inFlightA.error(new CancellationError()); // what the closed connection does to pending requests
		const a = await readingA;
		clientOf(B).readFileResult = Promise.reject(createFileSystemProviderError('missing', FileSystemProviderErrorCode.FileNotFound));
		const b = await errorOf(router.readFile(uri(B)));

		assert.deepStrictEqual({ a, b }, {
			a: { code: FileSystemProviderErrorCode.Unavailable, namesHost: true },
			b: { code: FileSystemProviderErrorCode.FileNotFound, namesHost: false }
		});
	});

	test('rename and copy across hosts fail without touching either host', async () => {
		service.setConnected(A);
		service.setConnected(B);
		const router = create();
		const isCrossHost = (e: Error) => e.message.includes('different remote machines');

		await assert.rejects(router.rename(uri(A), uri(B), { overwrite: false }), isCrossHost);
		await assert.rejects(router.copy(uri(A), uri(B), { overwrite: false }), isCrossHost);

		assert.deepStrictEqual(clients.map(c => c.calls), []);
	});

	test('file descriptors from two hosts never collide', async () => {
		service.setConnected(A);
		service.setConnected(B);
		const router = create();

		const fdA = await router.open(uri(A), { create: false });
		const fdB = await router.open(uri(B), { create: false });
		await router.read(fdB, 0, new Uint8Array(1), 0, 1);
		await router.close(fdB);

		assert.notStrictEqual(fdA, fdB);
		assert.deepStrictEqual({ a: clientOf(A).calls, b: clientOf(B).calls }, { a: ['open'], b: ['open', 'read 1', 'close 1'] });
		await assert.rejects(router.read(fdB, 0, new Uint8Array(1), 0, 1));
	});

	test('watches are re-established when a host reconnects', async () => {
		service.setConnected(A);
		const router = create();
		const opts: IWatchOptions = { recursive: true, excludes: ['x'] };

		store.add(router.watch(uri(A), opts));
		const first = clientOf(A);
		service.setConnected(A);
		service.emitter.fire({ authority: A, state: RemoteHostState.Connected });

		const second = clientOf(A);
		assert.notStrictEqual(first, second);
		assert.deepStrictEqual({ first: first.watches, second: second.watches, disposed: first.disposed }, {
			first: [{ resource: uri(A), opts }],
			second: [{ resource: uri(A), opts }],
			disposed: true
		});
	});

	test('a brief reconnect on the same connection keeps the client, fds and watches', async () => {
		service.setConnected(A);
		const router = create();
		const fd = await router.open(uri(A), { create: false });
		store.add(router.watch(uri(A), { recursive: false, excludes: [] }));
		const client = clientOf(A);
		const connection = service.getConnected(A)!.connection;

		service.connected.delete(A);
		service.states.set(A, RemoteHostState.Reconnecting);
		service.emitter.fire({ authority: A, state: RemoteHostState.Reconnecting });
		const code = await router.stat(uri(A)).then(() => undefined, e => toFileSystemProviderErrorCode(e));
		const disposedWhileReconnecting = client.disposed;

		service.setConnected(A, connection);
		service.emitter.fire({ authority: A, state: RemoteHostState.Connected });
		await router.read(fd, 0, new Uint8Array(1), 0, 1);

		assert.deepStrictEqual({ code, disposedWhileReconnecting, clients: clients.length, calls: client.calls, watches: client.watches.length }, {
			code: FileSystemProviderErrorCode.Unavailable,
			disposedWhileReconnecting: false,
			clients: 1,
			calls: ['open', 'read 1'],
			watches: 1
		});
	});

	test('connect receives the authority exactly as written', async () => {
		const router = create();

		await assert.rejects(router.stat(uri('ssh-remote+DevBox', '/x')));

		assert.deepStrictEqual(service.connectCalls, ['ssh-remote+DevBox']);
	});

	test('file change events from all hosts are forwarded', async () => {
		service.setConnected(A);
		service.setConnected(B);
		const router = create();
		const events: IFileChange[] = [];
		store.add(router.onDidChangeFile(e => events.push(...e)));

		await router.stat(uri(A));
		await router.stat(uri(B));
		const changeA = { type: FileChangeType.ADDED, resource: uri(A, '/x') };
		const changeB = { type: FileChangeType.DELETED, resource: uri(B, '/y') };
		clientOf(A).changeEmitter.fire([changeA]);
		clientOf(B).changeEmitter.fire([changeB]);

		assert.deepStrictEqual(events, [changeA, changeB]);
	});
});

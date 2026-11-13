/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ConnectionGainEvent, ConnectionLostEvent, PersistentConnectionEvent, ReconnectionPermanentFailureEvent } from '../../../../../platform/remote/common/remoteAgentConnection.js';
import { IRemoteAgentEnvironment } from '../../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IRemoteAuthorityResolverService } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { IExtensionService } from '../../../extensions/common/extensions.js';
import { IUserDataProfileService } from '../../../userDataProfile/common/userDataProfile.js';
import { MultiRemoteService } from '../../browser/multiRemoteService.js';
import { IRemoteHostStatus } from '../../common/multiRemoteService.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../common/remoteAgentService.js';
import { IRemoteSocketFactoryService } from '../../../../../platform/remote/common/remoteSocketFactoryService.js';
import { ISignService } from '../../../../../platform/sign/common/sign.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';

class FakeConnection extends mock<IRemoteAgentConnection>() {
	readonly stateEmitter = new Emitter<PersistentConnectionEvent>();
	readonly reconnectingEmitter = new Emitter<void>();
	override readonly onDidStateChange = this.stateEmitter.event;
	override readonly onReconnecting = this.reconnectingEmitter.event;
	endCalls = 0;
	graceTimes: number[] = [];
	disposed = false;

	constructor(override readonly remoteAuthority: string) {
		super();
	}

	override updateGraceTime(graceTime: number): void {
		this.graceTimes.push(graceTime);
	}

	override async end(): Promise<void> {
		this.endCalls++;
	}

	override dispose(): void {
		this.disposed = true;
		this.stateEmitter.dispose();
		this.reconnectingEmitter.dispose();
	}
}

class TestMultiRemoteService extends MultiRemoteService {
	readonly created: FakeConnection[] = [];

	protected override _createConnection(authority: string): IRemoteAgentConnection {
		const connection = new FakeConnection(authority);
		this.created.push(connection);
		return connection;
	}

	protected override async _fetchEnvironment(): Promise<IRemoteAgentEnvironment> {
		return { userHome: URI.file('/home/a'), reconnectionGraceTime: 1234 } as IRemoteAgentEnvironment;
	}
}

suite('MultiRemoteService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(options: { primary?: string; failFor?: string; holdResolve?: DeferredPromise<void> } = {}) {
		const resolved: string[] = [];
		const cleared: string[] = [];
		const primaryEnvironment = { userHome: URI.file('/primary') } as IRemoteAgentEnvironment;
		const service = store.add(new TestMultiRemoteService(
			new class extends mock<IWorkbenchEnvironmentService>() { override remoteAuthority = options.primary; }(),
			new class extends mock<IRemoteAgentService>() { override async getEnvironment() { return primaryEnvironment; } }(),
			new class extends mock<IExtensionService>() {
				override async resolveRemoteAuthority(authority: string) {
					resolved.push(authority);
					if (options.holdResolve) {
						await options.holdResolve.p;
					}
					if (authority === options.failFor) {
						throw new Error('resolver says no');
					}
				}
			}(),
			new class extends mock<IRemoteAuthorityResolverService>() { override _clearResolvedAuthority(authority: string) { cleared.push(authority); } }(),
			new class extends mock<IRemoteSocketFactoryService>() { }(),
			new class extends mock<ISignService>() { }(),
			new class extends mock<IProductService>() { }(),
			new class extends mock<IUserDataProfileService>() { }(),
			new NullLogService()
		));
		const states: string[] = [];
		store.add(service.onDidChangeHostState((s: IRemoteHostStatus) => states.push(s.state)));
		return { service, resolved, cleared, states, primaryEnvironment };
	}

	test('is disabled in a remote window', async () => {
		const { service } = create({ primary: 'ssh-remote+primary' });
		await assert.rejects(() => service.connect('ssh-remote+b'));
		assert.strictEqual(service.isEnabled, false);
	});

	test('connect goes connecting → connected and returns the environment', async () => {
		const { service, states } = create();
		const result = await service.connect('ssh-remote+a');
		assert.deepStrictEqual({ states, home: result.environment.userHome.path, graceTimes: service.created[0].graceTimes }, { states: ['connecting', 'connected'], home: '/home/a', graceTimes: [1234] });
	});

	test('concurrent connect calls share one connection', async () => {
		const { service } = create();
		const [a, b] = await Promise.all([service.connect('ssh-remote+a'), service.connect('ssh-remote+a')]);
		assert.deepStrictEqual({ created: service.created.length, same: a === b }, { created: 1, same: true });
	});

	test('authority keys are case-insensitive', async () => {
		const { service } = create();
		await service.connect('ssh-remote+DevBox');
		assert.deepStrictEqual({ connected: !!service.getConnected('ssh-remote+devbox'), created: service.created.length }, { connected: true, created: 1 });
	});

	test('resolver failure marks only that host failed', async () => {
		const { service } = create({ failFor: 'ssh-remote+b' });
		await service.connect('ssh-remote+a');
		await assert.rejects(() => service.connect('ssh-remote+b'));
		assert.deepStrictEqual(service.getHosts().map(h => ({ authority: h.authority, state: h.state, failed: h.error?.includes('resolver says no') })), [
			{ authority: 'ssh-remote+a', state: 'connected', failed: undefined },
			{ authority: 'ssh-remote+b', state: 'failed', failed: true },
		]);
	});

	test('connection lost → reconnecting → connected', async () => {
		const { service, cleared, resolved } = create();
		await service.connect('ssh-remote+a');
		const connection = service.created[0];
		connection.stateEmitter.fire(new ConnectionLostEvent('t', 0));
		const lost = service.getState('ssh-remote+a');
		connection.reconnectingEmitter.fire();
		connection.stateEmitter.fire(new ConnectionGainEvent('t', 0, 1));
		assert.deepStrictEqual({ lost, cleared, resolved, after: service.getState('ssh-remote+a') }, {
			lost: 'reconnecting', cleared: ['ssh-remote+a'], resolved: ['ssh-remote+a', 'ssh-remote+a'], after: 'connected'
		});
	});

	test('permanent failure then connect creates a new connection', async () => {
		const { service } = create();
		await service.connect('ssh-remote+a');
		service.created[0].stateEmitter.fire(new ReconnectionPermanentFailureEvent('t', 0, 3, false));
		const failed = service.getState('ssh-remote+a');
		await service.connect('ssh-remote+a');
		assert.deepStrictEqual({ failed, created: service.created.length, state: service.getState('ssh-remote+a') }, { failed: 'failed', created: 2, state: 'connected' });
	});

	test('getEnvironment delegates to the primary for undefined', async () => {
		const { service, primaryEnvironment } = create();
		assert.strictEqual(await service.getEnvironment(undefined), primaryEnvironment);
	});

	test('disconnect ends and disposes the connection', async () => {
		const { service } = create();
		await service.connect('ssh-remote+a');
		await service.disconnect('ssh-remote+a');
		assert.deepStrictEqual({ end: service.created[0].endCalls, disposed: service.created[0].disposed, state: service.getState('ssh-remote+a') }, { end: 1, disposed: true, state: 'disconnected' });
	});

	test('disconnect while connecting cancels and allows a fresh connect', async () => {
		const hold = new DeferredPromise<void>();
		const { service } = create({ holdResolve: hold });
		const pending = service.connect('ssh-remote+a');
		const rejection = pending.then(() => 'resolved', error => isCancellationError(error) ? 'cancelled' : 'other');
		await service.disconnect('ssh-remote+a');
		const state = service.getState('ssh-remote+a');
		hold.complete();
		const outcome = await rejection;
		const fresh = await service.connect('ssh-remote+a');
		assert.deepStrictEqual({ state, outcome, created: service.created.length, freshState: service.getState('ssh-remote+a'), freshHome: fresh.environment.userHome.path }, {
			state: 'disconnected', outcome: 'cancelled', created: 1, freshState: 'connected', freshHome: '/home/a'
		});
	});
});

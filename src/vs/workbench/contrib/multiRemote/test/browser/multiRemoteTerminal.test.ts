/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ITerminalBackend, ITerminalBackendRegistry, TerminalExtensions } from '../../../../../platform/terminal/common/terminal.js';
import { IMultiRemoteService, IRemoteHostConnection, IRemoteHostStatus, RemoteHostState } from '../../../../services/remote/common/multiRemoteService.js';
import { IRemoteAgentConnection } from '../../../../services/remote/common/remoteAgentService.js';
import { ITerminalInstanceService, ITerminalService } from '../../../terminal/browser/terminal.js';
import { MultiRemoteTerminalContribution, NewTerminalOnRemoteHostAction } from '../../browser/multiRemoteTerminal.js';

const AUTHORITY = 'ssh-remote+b';

suite('MultiRemoteTerminal', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IFakeBackend { readonly id: number; readyCalls: number; disposed: boolean; remoteAuthority: string }

	let stateEmitter: Emitter<IRemoteHostStatus>;
	let connections: Map<string, IRemoteAgentConnection>;
	let backends: IFakeBackend[];
	let registeredAtNotify: (IFakeBackend | undefined)[];
	let enabled: boolean;

	const registry = () => Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend);
	const current = () => registry().getTerminalBackend(AUTHORITY) as unknown as IFakeBackend | undefined;
	const newConnection = () => ({ getChannel: () => ({}) } as unknown as IRemoteAgentConnection);

	function fire(state: RemoteHostState): void {
		stateEmitter.fire({ authority: AUTHORITY, state });
	}

	function create(): MultiRemoteTerminalContribution {
		const multiRemoteService = {
			isEnabled: enabled,
			onDidChangeHostState: stateEmitter.event,
			getHosts: () => [],
			getConnected: (authority: string) => {
				const connection = connections.get(authority);
				return connection ? { authority, connection } as IRemoteHostConnection : undefined;
			}
		} as Partial<IMultiRemoteService> as IMultiRemoteService;
		const instantiationService = {
			createInstance: (ctor: { name: string }, authority: string) => {
				if (ctor.name !== 'RemoteTerminalBackend') {
					return {}; // the channel client
				}
				const backend: IFakeBackend = { id: backends.length, readyCalls: 0, disposed: false, remoteAuthority: authority };
				(backend as unknown as { setReady(): void }).setReady = () => { backend.readyCalls++; };
				(backend as unknown as { dispose(): void }).dispose = () => { backend.disposed = true; };
				backends.push(backend);
				return backend;
			}
		} as unknown as IInstantiationService;
		const terminalInstanceService = {
			didRegisterBackend: (backend: ITerminalBackend) => {
				registeredAtNotify.push(registry().getTerminalBackend(backend.remoteAuthority) as unknown as IFakeBackend | undefined);
			}
		} as Partial<ITerminalInstanceService> as ITerminalInstanceService;
		return store.add(new MultiRemoteTerminalContribution(multiRemoteService, instantiationService, terminalInstanceService));
	}

	setup(() => {
		stateEmitter = store.add(new Emitter<IRemoteHostStatus>());
		connections = new Map();
		backends = [];
		registeredAtNotify = [];
		enabled = true;
	});

	teardown(() => {
		registry().unregisterTerminalBackend(AUTHORITY);
	});

	test('backend lifecycle follows the host connection', () => {
		create();
		const a = newConnection();
		connections.set(AUTHORITY, a);

		fire(RemoteHostState.Connected);
		const first = current();
		// Registered, announced and ready synchronously inside the Connected event
		assert.deepStrictEqual({ registered: first?.id, announced: registeredAtNotify.map(b => b?.id), ready: first?.readyCalls }, { registered: 0, announced: [0], ready: 1 });

		// Same connection again: no-op
		fire(RemoteHostState.Connected);
		assert.deepStrictEqual({ registered: current()?.id, created: backends.length }, { registered: 0, created: 1 });

		// Brief network drop: backend survives Reconnecting and the following Connected
		connections.delete(AUTHORITY);
		fire(RemoteHostState.Reconnecting);
		connections.set(AUTHORITY, a);
		fire(RemoteHostState.Connected);
		assert.deepStrictEqual({ registered: current()?.id, disposed: first?.disposed, created: backends.length }, { registered: 0, disposed: false, created: 1 });

		// New connection object: backend replaced
		connections.set(AUTHORITY, newConnection());
		fire(RemoteHostState.Connected);
		assert.deepStrictEqual({ registered: current()?.id, oldDisposed: first?.disposed, announced: registeredAtNotify.map(b => b?.id) }, { registered: 1, oldDisposed: true, announced: [0, 1] });

		// Failed: unregistered and disposed
		const second = current();
		fire(RemoteHostState.Failed);
		assert.deepStrictEqual({ registered: current(), disposed: second?.disposed }, { registered: undefined, disposed: true });
	});

	test('keeps the backend while reconnecting', () => {
		create();
		connections.set(AUTHORITY, newConnection());
		fire(RemoteHostState.Connected);
		fire(RemoteHostState.Reconnecting);
		assert.deepStrictEqual({ registered: current()?.id, disposed: backends[0].disposed }, { registered: 0, disposed: false });
	});

	test('Disconnected unregisters the backend and allows a fresh one', () => {
		create();
		connections.set(AUTHORITY, newConnection());
		fire(RemoteHostState.Connected);
		fire(RemoteHostState.Disconnected);
		assert.strictEqual(current(), undefined);
		connections.set(AUTHORITY, newConnection());
		fire(RemoteHostState.Connected);
		assert.strictEqual(current()?.id, 1);
	});

	test('does nothing when multi-remote is disabled', () => {
		enabled = false;
		create();
		connections.set(AUTHORITY, newConnection());
		fire(RemoteHostState.Connected);
		assert.strictEqual(current(), undefined);
	});

	test('New Terminal on Remote Host does nothing for a host when multi-remote is disabled', async () => {
		const calls: string[] = [];
		const services = new Map<unknown, unknown>([
			[IMultiRemoteService, { isEnabled: false, getEnvironment: async () => { calls.push('getEnvironment'); return null; } } as Partial<IMultiRemoteService>],
			[ITerminalService, { createTerminal: async () => { calls.push('createTerminal'); return undefined!; } } as Partial<ITerminalService>],
		]);
		const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;

		await new NewTerminalOnRemoteHostAction().run(accessor, AUTHORITY);

		assert.deepStrictEqual(calls, []);
	});
});

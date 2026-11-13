/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITerminalBackend, ITerminalBackendRegistry, ITerminalProfile, TerminalExtensions } from '../../../../../platform/terminal/common/terminal.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IMultiRemoteService, IRemoteHostConnection } from '../../../../services/remote/common/multiRemoteService.js';
import { ITerminalInstanceService } from '../../browser/terminal.js';
import { TerminalInstanceService } from '../../browser/terminalInstanceService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';

suite('Workbench - TerminalInstanceService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let terminalInstanceService: ITerminalInstanceService;

	let connectCalls: string[];
	let secondaryEnabled: boolean;

	setup(async () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		connectCalls = [];
		secondaryEnabled = true;
		instantiationService.stub(IMultiRemoteService, {
			isSecondary: (authority: string | undefined) => secondaryEnabled && authority !== undefined,
			connect: async (authority: string) => {
				connectCalls.push(authority);
				const backend = { remoteAuthority: authority } as ITerminalBackend;
				Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).registerTerminalBackend(backend);
				terminalInstanceService.didRegisterBackend(backend);
				return {} as IRemoteHostConnection;
			}
		} as Partial<IMultiRemoteService> as IMultiRemoteService);
		terminalInstanceService = store.add(instantiationService.createInstance(TerminalInstanceService));
	});

	teardown(() => {
		Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).unregisterTerminalBackend('ssh-remote+b');
	});

	suite('getBackend', () => {
		test('getBackend connects a secondary host on demand', async () => {
			const backend = await terminalInstanceService.getBackend('ssh-remote+b');
			deepStrictEqual({ authority: backend?.remoteAuthority, connectCalls }, { authority: 'ssh-remote+b', connectCalls: ['ssh-remote+b'] });
		});
		test('getBackend does not connect when multi-remote is disabled', async () => {
			secondaryEnabled = false;
			const backend = await terminalInstanceService.getBackend('ssh-remote+b');
			deepStrictEqual({ backend, connectCalls }, { backend: undefined, connectCalls: [] });
		});
	});

	suite('TerminalBackendRegistry', () => {
		test('unregisterTerminalBackend allows re-registering the same authority', () => {
			const registry = Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend);
			const backend = { remoteAuthority: 'ssh-remote+a' } as ITerminalBackend;
			registry.registerTerminalBackend(backend);
			registry.unregisterTerminalBackend('SSH-REMOTE+A');
			strictEqual(registry.getTerminalBackend('ssh-remote+a'), undefined);
			registry.registerTerminalBackend(backend);
			registry.unregisterTerminalBackend('ssh-remote+a');
		});
	});

	suite('convertProfileToShellLaunchConfig', () => {
		test('should return an empty shell launch config when undefined is provided', () => {
			deepStrictEqual(terminalInstanceService.convertProfileToShellLaunchConfig(), {});
			deepStrictEqual(terminalInstanceService.convertProfileToShellLaunchConfig(undefined), {});
		});
		test('should return the same shell launch config when provided', () => {
			deepStrictEqual(
				terminalInstanceService.convertProfileToShellLaunchConfig({}),
				{}
			);
			deepStrictEqual(
				terminalInstanceService.convertProfileToShellLaunchConfig({ executable: '/foo' }),
				{ executable: '/foo' }
			);
			deepStrictEqual(
				terminalInstanceService.convertProfileToShellLaunchConfig({ executable: '/foo', cwd: '/bar', args: ['a', 'b'] }),
				{ executable: '/foo', cwd: '/bar', args: ['a', 'b'] }
			);
			deepStrictEqual(
				terminalInstanceService.convertProfileToShellLaunchConfig({ executable: '/foo' }, '/bar'),
				{ executable: '/foo', cwd: '/bar' }
			);
			deepStrictEqual(
				terminalInstanceService.convertProfileToShellLaunchConfig({ executable: '/foo', cwd: '/bar' }, '/baz'),
				{ executable: '/foo', cwd: '/baz' }
			);
		});
		test('should convert a provided profile to a shell launch config', () => {
			deepStrictEqual(
				terminalInstanceService.convertProfileToShellLaunchConfig({
					profileName: 'abc',
					path: '/foo',
					isDefault: true
				}),
				{
					args: undefined,
					color: undefined,
					cwd: undefined,
					env: undefined,
					executable: '/foo',
					icon: undefined,
					name: undefined
				}
			);
			const icon = URI.file('/icon');
			deepStrictEqual(
				terminalInstanceService.convertProfileToShellLaunchConfig({
					profileName: 'abc',
					path: '/foo',
					isDefault: true,
					args: ['a', 'b'],
					color: 'color',
					env: { test: 'TEST' },
					icon
				} as ITerminalProfile, '/bar'),
				{
					args: ['a', 'b'],
					color: 'color',
					cwd: '/bar',
					env: { test: 'TEST' },
					executable: '/foo',
					icon,
					name: undefined
				}
			);
		});
		test('should respect overrideName in profile', () => {
			deepStrictEqual(
				terminalInstanceService.convertProfileToShellLaunchConfig({
					profileName: 'abc',
					path: '/foo',
					isDefault: true,
					overrideName: true
				}),
				{
					args: undefined,
					color: undefined,
					cwd: undefined,
					env: undefined,
					executable: '/foo',
					icon: undefined,
					name: 'abc'
				}
			);
		});
	});
});

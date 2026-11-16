/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IMultiRemoteService, IRemoteHostConnection, RemoteHostState } from '../../../../services/remote/common/multiRemoteService.js';
import { IHostDemandService } from '../../browser/hostDemand.js';
import { MultiRemoteOpener } from '../../browser/multiRemoteOpener.js';

suite('MultiRemoteOpener', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const collapsed = 'ssh-remote+collapsed';
	const expanded = 'ssh-remote+expanded';
	const rootless = 'ssh-remote+rootless';

	let calls: string[];
	let states: Map<string, RemoteHostState>;
	let trusted: boolean;
	let connection: DeferredPromise<IRemoteHostConnection>;

	const file = (authority: string) => URI.from({ scheme: Schemas.vscodeRemote, authority, path: '/w/file.txt' });

	function create(): MultiRemoteOpener {
		const multiRemoteService = {
			getState: (authority: string) => states.get(authority.toLowerCase()),
			connect: (authority: string) => { calls.push(`connect ${authority}`); return connection.p; }
		} as Partial<IMultiRemoteService> as IMultiRemoteService;
		const hostDemandService = {
			hasRoots: (authority: string) => authority.toLowerCase() !== rootless,
			isWanted: (authority: string) => authority.toLowerCase() === expanded
		} as Partial<IHostDemandService> as IHostDemandService;
		const trustService = { isWorkspaceTrusted: () => trusted } as Partial<IWorkspaceTrustManagementService> as IWorkspaceTrustManagementService;
		return new MultiRemoteOpener(multiRemoteService, hostDemandService, trustService);
	}

	setup(() => {
		calls = [];
		states = new Map();
		trusted = true;
		connection = new DeferredPromise<IRemoteHostConnection>();
	});

	test('connects the host of a collapsed group before the default openers run', async () => {
		const opener = create();
		let settled = false;
		const result = opener.open(file('ssh-remote+Collapsed')).then(handled => { settled = true; return handled; });
		await Promise.resolve();
		const settledWhileConnecting = settled;
		connection.complete(undefined!);
		assert.deepStrictEqual({ calls, settledWhileConnecting, handled: await result }, { calls: ['connect ssh-remote+Collapsed'], settledWhileConnecting: false, handled: false });
	});

	test('a failed connection lets the default openers report it', async () => {
		connection.error(new Error('no route'));
		assert.deepStrictEqual({ handled: await create().open(`${file(collapsed).toString()}#L3`), calls }, { handled: false, calls: [`connect ${collapsed}`] });
	});

	test('leaves everything else to the default openers', async () => {
		const opener = create();
		states.set('ssh-remote+connected', RemoteHostState.Connected);
		const results = [
			await opener.open(file('ssh-remote+connected')),
			await opener.open(file(expanded)),
			await opener.open(file(rootless)),
			await opener.open(URI.file('/local/file.txt')),
			await opener.open(file(collapsed), { openExternal: true })
		];
		trusted = false;
		results.push(await opener.open(file(collapsed)));
		assert.deepStrictEqual({ results, calls }, { results: [false, false, false, false, false, false], calls: [] });
	});
});

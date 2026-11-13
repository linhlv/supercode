/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRemoteAuthorityResolverService } from '../../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IProcessDataEvent, ITerminalLogService } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { IMultiRemoteService } from '../../../../services/remote/common/multiRemoteService.js';
import { IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { RemotePty } from '../../browser/remotePty.js';
import { RemoteTerminalBackend } from '../../browser/remoteTerminalBackend.js';
import { RemoteTerminalChannelClient } from '../../common/remote/remoteTerminalChannel.js';

suite('RemoteTerminalBackend', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a lost host ends every terminal with a message naming the host', async () => {
		const logService = new NullLogService() as unknown as ITerminalLogService;
		const multiRemoteService = {} as IMultiRemoteService;
		// Every `on…` event of the channel (and pty host controller) is silent; attaching always works
		const channel = new Proxy({ attachToProcess: async () => { } }, {
			get: (target, property) => typeof property === 'string' && property.startsWith('on') ? Event.None : (target as Record<string | symbol, unknown>)[property]
		}) as unknown as RemoteTerminalChannelClient;
		const instantiationService = {
			createInstance: (_ctor: unknown, id: number, shouldPersist: boolean, authority: string, client: RemoteTerminalChannelClient) => new RemotePty(id, shouldPersist, authority, client, multiRemoteService, logService)
		} as unknown as IInstantiationService;
		const backend = store.add(new RemoteTerminalBackend('ssh-remote+b', channel, multiRemoteService, instantiationService, logService,
			{} as ICommandService, {} as IStorageService, {} as IRemoteAuthorityResolverService, {} as IWorkspaceContextService,
			{} as IConfigurationResolverService, {} as IHistoryService, {} as IConfigurationService, {} as IStatusbarService));
		const events: string[] = [];
		for (const id of [1, 2]) {
			const pty = (await backend.attachToProcess(id))!;
			store.add(pty.onProcessData(e => events.push(`${id} data ${typeof e === 'string' ? e : (e as IProcessDataEvent).data}`.replace(/\x1b\[[0-9;]*m|\r|\n/g, ''))));
			store.add(pty.onProcessExit(code => events.push(`${id} exit ${code}`)));
		}

		const closed = backend.handleHostUnavailable('The connection to SSH: b@box was lost.');
		const closedAgain = backend.handleHostUnavailable('again');

		assert.deepStrictEqual({ closed, closedAgain, events }, {
			closed: 2,
			closedAgain: 0,
			events: [
				'1 data  *  The connection to SSH: b@box was lost. ', '1 exit undefined',
				'2 data  *  The connection to SSH: b@box was lost. ', '2 exit undefined',
			]
		});
	});
});

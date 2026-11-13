/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRemoteAgentEnvironment } from '../../../../../platform/remote/common/remoteAgentEnvironment.js';
import { ITerminalLogService } from '../../../../../platform/terminal/common/terminal.js';
import { IMultiRemoteService } from '../../../../services/remote/common/multiRemoteService.js';
import { RemotePty } from '../../browser/remotePty.js';
import { RemoteTerminalChannelClient } from '../../common/remote/remoteTerminalChannel.js';

suite('RemotePty', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('start checks the environment of its own host, not the window\'s', async () => {
		const requested: (string | undefined)[] = [];
		const started: number[] = [];
		const multiRemoteService = {
			// A local window has no primary remote environment; only the terminal's own host has one
			getEnvironment: async (authority: string | undefined) => {
				requested.push(authority);
				return authority === 'ssh-remote+b' ? {} as IRemoteAgentEnvironment : null;
			}
		} as Partial<IMultiRemoteService> as IMultiRemoteService;
		const channel = {
			start: async (id: number) => {
				started.push(id);
				return undefined;
			}
		} as Partial<RemoteTerminalChannelClient> as RemoteTerminalChannelClient;

		const pty = store.add(new RemotePty(7, false, 'ssh-remote+b', channel, multiRemoteService, new NullLogService() as unknown as ITerminalLogService));
		const result = await pty.start();

		assert.deepStrictEqual({ requested, started, result }, { requested: ['ssh-remote+b'], started: [7], result: undefined });
	});
});

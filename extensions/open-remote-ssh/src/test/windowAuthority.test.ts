/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isWindowAuthority } from '../windowAuthority';

suite('window authority', () => {

	test('only the remote window\'s own authority may show the resolve failure modal', () => {
		assert.deepStrictEqual({
			localWindow: isWindowAuthority(undefined, 'ssh-remote+aa'),
			ownHost: isWindowAuthority('ssh-remote+aa', 'ssh-remote+aa'),
			ownHostOtherCase: isWindowAuthority('SSH-REMOTE+AA', 'ssh-remote+aa'),
			otherHost: isWindowAuthority('ssh-remote+aa', 'ssh-remote+bb'),
		}, {
			localWindow: false,
			ownHost: true,
			ownHostOtherCase: true,
			otherHost: false,
		});
	});
});

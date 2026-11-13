/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import SSHDestination from '../ssh/sshDestination';
import { buildNativeSshArgs, buildNativeServerEnv, nativeRegistryKey } from '../native/nativeSshArgs';

function pairs(args: string[]): string[][] {
	const result: string[][] = [];
	for (let i = 0; i < args.length - 1; i++) {
		result.push([args[i], args[i + 1]]);
	}
	return result;
}

suite('native ssh args', () => {

	test('native ssh args are non-interactive', () => {
		const args = buildNativeSshArgs(SSHDestination.parse('me@devbox'), []);
		const found = pairs(args);

		assert.deepStrictEqual({
			batchMode: found.some(p => p[0] === '-o' && p[1] === 'BatchMode=yes'),
			connectTimeout: found.some(p => p[0] === '-o' && p[1] === 'ConnectTimeout=15'),
		}, { batchMode: true, connectTimeout: true });
	});

	test('passes the destination and extra arguments through', () => {
		const args = buildNativeSshArgs(new SSHDestination('devbox', 'me', 2222), ['-D', '1080']);

		assert.deepStrictEqual(args, [
			'-v', '-T',
			'-o', 'BatchMode=yes',
			'-o', 'ConnectTimeout=15',
			'-D', '1080',
			'-p', '2222',
			'-l', 'me',
			'devbox',
		]);
	});

	test('server env cannot prompt through askpass', () => {
		assert.deepStrictEqual(buildNativeServerEnv(undefined), { DISPLAY: '1', ELECTRON_RUN_AS_NODE: '1', SSH_ASKPASS_REQUIRE: 'never' });
	});

	test('registry key differs per user and port and is filesystem safe', () => {
		const alice = nativeRegistryKey(SSHDestination.parse('alice@box'));
		const bob = nativeRegistryKey(SSHDestination.parse('bob@box:2222'));

		assert.deepStrictEqual({ differ: alice !== bob, safe: /^[0-9a-f]+$/.test(alice) && /^[0-9a-f]+$/.test(bob), stable: alice === nativeRegistryKey(SSHDestination.parse('alice@box')) }, { differ: true, safe: true, stable: true });
	});
});

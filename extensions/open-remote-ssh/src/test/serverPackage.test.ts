/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { buildUploadCommand, pickServerPackage, remoteTarballPath, requireLocalServerPackage, serverInstallDir, stripForwardingArgs } from '../serverPackage';

suite('server package', () => {

	test('pickServerPackage maps every supported platform', () => {
		assert.deepStrictEqual([
			pickServerPackage({ kernel: 'Linux', machine: 'x86_64', isMusl: false }),
			pickServerPackage({ kernel: 'Linux', machine: 'aarch64', isMusl: false }),
			pickServerPackage({ kernel: 'Linux', machine: 'x86_64', isMusl: true }),
			pickServerPackage({ kernel: 'Linux', machine: 'aarch64', isMusl: true }),
		], [
			'vscode-reh-linux-x64.tar.gz',
			'vscode-reh-linux-arm64.tar.gz',
			'vscode-reh-linux-alpine.tar.gz',
			'vscode-reh-alpine-arm64.tar.gz',
		]);
	});

	test('pickServerPackage rejects 32-bit ARM', () => {
		assert.throws(
			() => pickServerPackage({ kernel: 'Linux', machine: 'armv7l', isMusl: false }),
			(err: Error) => err.message.includes('32-bit ARM')
		);
	});

	test('pickServerPackage rejects unknown platforms', () => {
		assert.throws(
			() => pickServerPackage({ kernel: 'FreeBSD', machine: 'amd64', isMusl: false }),
			(err: Error) => err.message === 'Unsupported platform FreeBSD amd64'
		);
	});

	test('install directory is keyed by commit', () => {
		assert.strictEqual(serverInstallDir('~/.supercode-server', 'abc'), '~/.supercode-server/bin/abc');
		assert.notStrictEqual(serverInstallDir('~/.supercode-server', 'abc'), serverInstallDir('~/.supercode-server', 'def'));
	});

	test('a missing local package fails without a download fallback', async () => {
		return assert.rejects(
			() => requireLocalServerPackage('/nonexistent/dir', 'vscode-reh-linux-x64.tar.gz', 'Linux x86_64'),
			(err: Error) => err.message === 'No server package for Linux x86_64 in /nonexistent/dir. Run scripts/supercode/build.sh.'
		);
	});

	test('upload streams into a commit-keyed file through a quoted remote command', () => {
		const remote = remoteTarballPath('$HOME/.supercode-server', 'abc', 'vscode-reh-linux-x64.tar.gz');
		assert.strictEqual(remote, '$HOME/.supercode-server/abc-vscode-reh-linux-x64.tar.gz');
		assert.strictEqual(
			buildUploadCommand('$HOME/.supercode-server', 'abc', 'vscode-reh-linux-x64.tar.gz'),
			`sh -c 'mkdir -p "$HOME/.supercode-server" && cat > "$HOME/.supercode-server/abc-vscode-reh-linux-x64.tar.gz.part" && mv -f "$HOME/.supercode-server/abc-vscode-reh-linux-x64.tar.gz.part" "$HOME/.supercode-server/abc-vscode-reh-linux-x64.tar.gz"'`
		);
		assert.throws(() => buildUploadCommand('$HOME/a"; rm -rf ~; "', 'abc', 'x.tar.gz'));
	});

	test('upload reuses the session ssh arguments without its dynamic forwarding', () => {
		assert.deepStrictEqual(
			stripForwardingArgs(['-v', '-T', '-o', 'BatchMode=yes', '-D', '1080', '-l', 'bob', 'host']),
			['-T', '-o', 'BatchMode=yes', '-l', 'bob', 'host']
		);
	});
});

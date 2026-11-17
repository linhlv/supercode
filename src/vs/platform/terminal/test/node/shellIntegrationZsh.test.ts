/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

const zshScriptPath = join(FileAccess.asFileUri('vs/workbench/contrib/terminal/common/scripts').fsPath, 'shellIntegration-rc.zsh');

/**
 * The source of `__vsc_escape_value` in the zsh shell integration script.
 */
function getEscapeValueFunction(): string {
	const match = readFileSync(zshScriptPath, 'utf8').match(/^__vsc_escape_value\(\) \{\n(?<body>[\s\S]*?)\n\}$/m);
	if (!match?.groups) {
		throw new Error('__vsc_escape_value not found');
	}
	return match[0];
}

function hasZsh(): boolean {
	if (process.platform === 'win32') {
		return false;
	}
	try {
		execFileSync('zsh', ['-f', '-c', 'true']);
		return true;
	} catch {
		return false;
	}
}

suite('platform - terminal - zsh shell integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('__vsc_escape_value runs no subshell per byte, which makes reporting a long PATH take seconds', () => {
		// `$(` but not arithmetic `$((`
		deepStrictEqual(/\$\((?!\()/.test(getEscapeValueFunction()), false);
	});

	(hasZsh() ? test : test.skip)('__vsc_escape_value escapes backslashes, semicolons and control characters and keeps other bytes', () => {
		const values = ['a;b\\c', 'tab\there\nnl\x1b[0m\x1f', 'ü→x', '', ' spaced  out ', '%d %s', '\'q', '-n'];
		const script = `${getEscapeValueFunction()}\nfor value in "$@"; do __vsc_escape_value "$value"; done`;
		const output = execFileSync('zsh', ['-f', '-c', script, 'zsh', ...values], { encoding: 'utf8' });

		deepStrictEqual(output.split('\n').slice(0, -1), ['a\\x3bb\\\\c', 'tab\\x09here\\x0anl\\x1b[0m\x1f', 'ü→x', '', ' spaced  out ', '%d %s', '\'q', '-n']);
	});
});

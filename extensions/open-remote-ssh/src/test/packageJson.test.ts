/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface IMenuItem {
	readonly command: string;
	readonly when?: string;
}

suite('package.json', () => {

	test('"Add SSH Folder to Workspace..." is only offered in local windows', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
		const menus: Record<string, IMenuItem[]> = manifest.contributes.menus;
		const whens = Object.entries(menus)
			.flatMap(([menu, items]) => items.filter(item => item.command === 'remote-ssh.addFolderToWorkspace').map(item => ({ menu, local: /(^|&& )remoteName == ''( &&|$)/.test(item.when ?? '') })));

		assert.deepStrictEqual(whens, [
			{ menu: 'commandPalette', local: true },
			{ menu: 'view/title', local: true },
		]);
	});
});

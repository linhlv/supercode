/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { selectFoldersOfAuthority } from '../envScope';

suite('terminal env scope', () => {

	test('selects only the folders of the session authority, case-insensitively', () => {
		const folders = [
			{ uri: { authority: 'ssh-remote+aa' } },
			{ uri: { authority: 'ssh-remote+bb' } },
			{ uri: { authority: '' } },
			{ uri: { authority: 'SSH-REMOTE+AA' } },
		];

		assert.deepStrictEqual({
			a: selectFoldersOfAuthority(folders, 'ssh-remote+aa'),
			b: selectFoldersOfAuthority(folders, 'ssh-remote+BB'),
			none: selectFoldersOfAuthority(undefined, 'ssh-remote+aa'),
		}, { a: [0, 3], b: [1], none: [] });
	});
});

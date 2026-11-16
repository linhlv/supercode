/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullFilesConfigurationService, TestFileService } from '../../../../test/common/workbenchTestServices.js';
import { IWorkspaceGroup } from '../../../../services/workspaceGroups/common/workspaceGroups.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { ExplorerGroupItem, getGroupDropTarget } from '../../common/explorerGroupItem.js';

suite('ExplorerGroupDragAndDrop', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const fileService = new TestFileService();
	const configService = new TestConfigurationService();

	function root(path: string): ExplorerItem {
		return new ExplorerItem(URI.file(path), fileService, configService, NullFilesConfigurationService, undefined, true, false, false, false);
	}

	function groupItem(name: string, roots: ExplorerItem[]): ExplorerGroupItem {
		return new ExplorerGroupItem({ name, folders: roots.map(r => r.resource), collapsed: false }, roots, fileService, configService, NullFilesConfigurationService);
	}

	const web = root('/web');
	const api = root('/api');
	const loose = root('/loose');
	const other = root('/other');
	const file = new ExplorerItem(URI.file('/web/a.ts'), fileService, configService, NullFilesConfigurationService, web, false);

	const groups: IWorkspaceGroup[] = [
		{ name: 'shop', folders: [web.resource, api.resource], collapsed: false },
		{ name: 'tools', folders: [], collapsed: false }
	];
	const service = {
		groups,
		getGroupOf: (folder: URI) => groups.find(g => g.folders.some(f => f.toString() === folder.toString()))
	};
	const noGroups = { groups: [], getGroupOf: () => undefined };

	test('roots dropped on a group move into it', () => {
		assert.deepStrictEqual(getGroupDropTarget([loose], groupItem('tools', []), service), { move: true, group: 'tools' });
	});

	test('roots dropped on a root inside a group move into that group', () => {
		assert.deepStrictEqual(getGroupDropTarget([loose], api, service), { move: true, group: 'shop' });
	});

	test('grouped roots dropped on an ungrouped root or empty space are ungrouped', () => {
		assert.deepStrictEqual(getGroupDropTarget([web], loose, service), { move: true, group: undefined });
		assert.deepStrictEqual(getGroupDropTarget([web, api], undefined, service), { move: true, group: undefined });
	});

	test('files dropped on a group, and groups being dragged, are rejected', () => {
		assert.deepStrictEqual(getGroupDropTarget([file], groupItem('shop', []), service), { move: false });
		assert.deepStrictEqual(getGroupDropTarget([groupItem('shop', [])], loose, service), { move: false });
		assert.deepStrictEqual(getGroupDropTarget([groupItem('shop', [])], undefined, service), { move: false });
	});

	test('existing behaviour applies when nothing changes group or no groups exist', () => {
		assert.strictEqual(getGroupDropTarget([loose], other, service), undefined);
		assert.strictEqual(getGroupDropTarget([web], api, service), undefined);
		assert.strictEqual(getGroupDropTarget([file], loose, service), undefined);
		assert.strictEqual(getGroupDropTarget([loose], other, noGroups), undefined);
		assert.strictEqual(getGroupDropTarget([groupItem('shop', [])], undefined, noGroups), undefined);
	});
});

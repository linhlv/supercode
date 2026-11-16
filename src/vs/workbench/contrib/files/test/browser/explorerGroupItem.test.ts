/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullFilesConfigurationService, TestFileService } from '../../../../test/common/workbenchTestServices.js';
import { groupResource, IWorkspaceGroup } from '../../../../services/workspaceGroups/common/workspaceGroups.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { applyGroupCollapseState, compareExplorerGroupItems, ExplorerGroupItem, findExplorerGroupItem, getExpandableRoots, getExplorerRoots, getRootsOutsideCollapsedGroups, groupExplorerRoots, isExplorerGroupItem, isGroupCollapsedByDefault } from '../../common/explorerGroupItem.js';

suite('ExplorerGroupItem', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const fileService = new TestFileService();
	const configService = new TestConfigurationService();

	function root(path: string): ExplorerItem {
		return new ExplorerItem(URI.file(path), fileService, configService, NullFilesConfigurationService, undefined, true, false, false, false);
	}

	function group(name: string, roots: ExplorerItem[], collapsed = true): ExplorerGroupItem {
		return new ExplorerGroupItem({ name, folders: roots.map(r => r.resource), collapsed }, roots, fileService, configService, NullFilesConfigurationService);
	}

	function groupsOf(groups: IWorkspaceGroup[]) {
		return {
			groups,
			getGroupOf: (folder: URI) => groups.find(g => g.folders.some(f => f.toString() === folder.toString()))
		};
	}

	const create = (g: IWorkspaceGroup, roots: ExplorerItem[]) => new ExplorerGroupItem(g, roots, fileService, configService, NullFilesConfigurationService);

	test('group item is not a root and lists its roots as children', () => {
		const web = root('/web');
		const api = root('/api');
		const item = group('shop', [web, api]);

		assert.deepStrictEqual({
			isRoot: item.isRoot,
			isDirectory: item.isDirectory,
			readonly: !!item.isReadonly,
			name: item.name,
			groupName: item.groupName,
			resource: item.resource.toString(),
			children: item.fetchChildren(),
			hasChildren: item.hasChildren(),
			emptyHasChildren: group('empty', []).hasChildren(),
			isGroup: [isExplorerGroupItem(item), isExplorerGroupItem(web), isExplorerGroupItem(undefined)],
		}, {
			isRoot: false,
			isDirectory: true,
			readonly: true,
			name: 'shop',
			groupName: 'shop',
			resource: groupResource('shop').toString(),
			children: [web, api],
			hasChildren: true,
			emptyHasChildren: false,
			isGroup: [true, false, false],
		});
	});

	test('group item id is stable for a name', () => {
		assert.deepStrictEqual(
			[group('my group', []).getId(), group('my group', [root('/a')]).getId()],
			[groupResource('my group').toString(), groupResource('my group').toString()]);
	});

	test('roots inside a group keep isRoot true', () => {
		const web = root('/web');
		const item = group('shop', [web]);
		assert.deepStrictEqual({ isRoot: web.isRoot, parent: web.parent, root: web.root, id: web.getId(), roots: item.roots }, { isRoot: true, parent: undefined, root: web, id: `${web.resource.toString()}::${web.resource.toString()}`, roots: [web] });
	});

	test('roots are placed in their groups, in group order, above ungrouped roots', () => {
		const [a, b, c, d] = [root('/a'), root('/b'), root('/c'), root('/d')];
		const groups: IWorkspaceGroup[] = [
			{ name: 'second', folders: [c.resource, a.resource], collapsed: true },
			{ name: 'empty', folders: [], collapsed: false },
			{ name: 'first', folders: [b.resource], collapsed: false },
		];
		const input = groupExplorerRoots([a, b, c, d], groupsOf(groups), create);
		assert.deepStrictEqual(input.map(item => isExplorerGroupItem(item) ? { group: item.groupName, roots: item.roots.map(r => r.name) } : item.name), [
			{ group: 'second', roots: ['a', 'c'] },
			{ group: 'empty', roots: [] },
			{ group: 'first', roots: ['b'] },
			'd',
		]);
	});

	test('without groups the roots are returned unchanged', () => {
		const roots = [root('/a'), root('/b')];
		assert.strictEqual(groupExplorerRoots(roots, groupsOf([]), create), roots);
	});

	test('roots, expandable roots and the group of a root', () => {
		const [a, b, c] = [root('/a'), root('/b'), root('/c')];
		const collapsed = group('collapsed', [a]);
		const expanded = group('expanded', [b]);
		const input = [collapsed, expanded, c];
		const isExpanded = (g: ExplorerGroupItem) => g === expanded;
		assert.deepStrictEqual({
			roots: getExplorerRoots(input),
			expandable: getExpandableRoots(input, isExpanded),
			groupOfA: findExplorerGroupItem(input, a),
			groupOfC: findExplorerGroupItem(input, c),
			groupOfSingleRoot: findExplorerGroupItem(a, a),
		}, {
			roots: [a, b, c],
			expandable: [b, c],
			groupOfA: collapsed,
			groupOfC: undefined,
			groupOfSingleRoot: undefined,
		});
	});

	test('view state follows the collapsed state of the groups', () => {
		const groups: IWorkspaceGroup[] = [
			{ name: 'open', folders: [], collapsed: false },
			{ name: 'shut', folders: [], collapsed: true },
		];
		assert.deepStrictEqual(
			applyGroupCollapseState(['file:///a::file:///a', groupResource('shut').toString()], groups),
			['file:///a::file:///a', groupResource('open').toString()]);
		assert.deepStrictEqual(applyGroupCollapseState(undefined, groups), [groupResource('open').toString()]);
	});

	test('roots of collapsed groups are left out of the find roots', () => {
		const [a, b, c] = [root('/a'), root('/b'), root('/c')];
		const collapsed = group('collapsed', [a]);
		const expanded = group('expanded', [b]);
		assert.deepStrictEqual([
			getRootsOutsideCollapsedGroups([a, b, c], [collapsed, expanded, c], g => g === expanded),
			getRootsOutsideCollapsedGroups([a, b, c], [a, b, c], () => false),
			getRootsOutsideCollapsedGroups([a], a, () => false),
		], [[b, c], [a, b, c], [a]]);
	});

	test('a group is collapsed by default as the groups service says, also while filtering', () => {
		const groups: IWorkspaceGroup[] = [{ name: 'open', folders: [], collapsed: false }, { name: 'shut', folders: [], collapsed: true }];
		assert.deepStrictEqual(
			[isGroupCollapsedByDefault(group('open', []), groups), isGroupCollapsedByDefault(group('shut', []), groups), isGroupCollapsedByDefault(group('gone', []), groups), isGroupCollapsedByDefault(root('/a'), groups)],
			[false, true, true, undefined]);
	});

	test('groups sort before roots and keep their order', () => {
		const a = root('/a');
		const [x, y] = [group('x', []), group('y', [])];
		assert.deepStrictEqual(
			[compareExplorerGroupItems(x, a), compareExplorerGroupItems(a, x), compareExplorerGroupItems(y, x), compareExplorerGroupItems(a, root('/b'))],
			[-1, 1, 0, undefined]);
	});
});

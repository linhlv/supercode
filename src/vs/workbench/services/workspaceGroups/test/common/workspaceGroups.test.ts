/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { applyEdits, setProperty } from '../../../../../base/common/jsonEdit.js';
import { parse } from '../../../../../base/common/json.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { groupNameOf, groupResource, parseWorkspaceFileForImport, reconcileGroups, uniqueGroupName, validateGroupName, WORKSPACE_GROUPS_KEY } from '../../common/workspaceGroups.js';

suite('WorkspaceGroups - model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const a = URI.parse('file:///a');
	const b = URI.parse('file:///b');

	function summarize(groups: readonly { name: string; folders: readonly URI[] }[]) {
		return groups.map(g => ({ name: g.name, folders: g.folders.map(f => f.toString()) }));
	}

	test('reconcileGroups ignores a missing or non-array value', () => {
		for (const raw of [undefined, {}, 'x']) {
			assert.deepStrictEqual(reconcileGroups(raw, [a], extUri), []);
		}
	});

	test('reconcileGroups drops stale folders and keeps workspace order', () => {
		const result = reconcileGroups([{ name: 'g', folders: [b.toString(), 'file:///gone', a.toString()] }], [a, b], extUri);
		assert.deepStrictEqual(summarize(result), [{ name: 'g', folders: [a.toString(), b.toString()] }]);
	});

	test('reconcileGroups keeps the first of duplicate names (case-insensitive) and of a folder listed twice', () => {
		const result = reconcileGroups([
			{ name: 'G', folders: [a.toString()] },
			{ name: 'g', folders: [b.toString()] },
			{ name: 'h', folders: [a.toString(), b.toString()] }
		], [a, b], extUri);
		assert.deepStrictEqual(summarize(result), [
			{ name: 'G', folders: [a.toString()] },
			{ name: 'h', folders: [b.toString()] }
		]);
	});

	test('reconcileGroups matches remote authorities case-insensitively', () => {
		const ws = URI.parse('vscode-remote://ssh-remote+devbox/srv');
		const result = reconcileGroups([{ name: 'g', folders: ['vscode-remote://ssh-remote+DevBox/srv'] }], [ws], extUri);
		assert.deepStrictEqual(summarize(result), [{ name: 'g', folders: [ws.toString()] }]);
	});

	test('reconcileGroups trims names, drops empty names and malformed entries, keeps empty groups', () => {
		const result = reconcileGroups([
			{ name: '  spaced  ', folders: [a.toString()] },
			{ name: '   ', folders: [] },
			{ folders: [] },
			null,
			'str',
			{ name: 5, folders: [] },
			{ name: 'empty', folders: [] },
			{ name: 'nofolders' },
			{ name: 'mixed', folders: [3, null, b.toString()] }
		], [a, b], extUri);
		assert.deepStrictEqual(summarize(result), [
			{ name: 'spaced', folders: [a.toString()] },
			{ name: 'empty', folders: [] },
			{ name: 'nofolders', folders: [] },
			{ name: 'mixed', folders: [b.toString()] }
		]);
	});

	test('uniqueGroupName', () => {
		assert.strictEqual(uniqueGroupName('g', ['G']), 'g (2)');
		assert.strictEqual(uniqueGroupName('g', ['g', 'g (2)']), 'g (3)');
		assert.strictEqual(uniqueGroupName('x', []), 'x');
	});

	test('validateGroupName', () => {
		assert.ok(validateGroupName('', []));
		assert.ok(validateGroupName('   ', []));
		assert.ok(validateGroupName('Shop', ['shop']));
		assert.strictEqual(validateGroupName('Shop', ['shop'], 'shop'), undefined);
		assert.strictEqual(validateGroupName('Shop', ['other']), undefined);
	});

	test('groupResource round-trips names with slashes and spaces', () => {
		for (const name of ['a/b c', 'plain', 'ünï 100%']) {
			const res = groupResource(name);
			assert.strictEqual(res.scheme, 'supercode-group');
			assert.strictEqual(groupNameOf(res), name);
		}
		assert.strictEqual(groupNameOf(URI.file('/x')), undefined);
	});

	test('parseWorkspaceFileForImport resolves relative paths and uri entries', () => {
		const content = '{"folders":[{"path":"app"},{"uri":"vscode-remote://ssh-remote+h/srv","name":"srv [SSH: h]"}]}';
		const result = parseWorkspaceFileForImport(content, URI.parse('file:///w/x.code-workspace'), extUri);
		assert.ok(!('error' in result));
		assert.strictEqual(result.name, 'x');
		assert.deepStrictEqual(result.folders.map(f => ({ uri: f.uri.toString(), name: f.name })), [
			{ uri: 'file:///w/app', name: undefined },
			{ uri: URI.parse('vscode-remote://ssh-remote+h/srv').toString(), name: 'srv [SSH: h]' }
		]);
		assert.strictEqual(result.groups, undefined);
	});

	test('parseWorkspaceFileForImport returns its own groups when present', () => {
		const content = `{
			// comment
			"folders": [{"path": "app"}, {"path": "lib"},],
			"supercode.groups": [{"name": "g", "folders": ["file:///w/lib", "file:///gone"]}],
		}`;
		const result = parseWorkspaceFileForImport(content, URI.parse('file:///w/x.code-workspace'), extUri);
		assert.ok(!('error' in result));
		assert.deepStrictEqual(summarize(result.groups!), [{ name: 'g', folders: ['file:///w/lib'] }]);
	});

	test('parseWorkspaceFileForImport refuses remote workspaces and bad JSON', () => {
		const file = URI.parse('file:///w/x.code-workspace');
		assert.deepStrictEqual(parseWorkspaceFileForImport('{"remoteAuthority":"ssh-remote+h","folders":[]}', file, extUri), { error: 'remote' });
		assert.deepStrictEqual(parseWorkspaceFileForImport('{', file, extUri), { error: 'invalid' });
		assert.deepStrictEqual(parseWorkspaceFileForImport('{"settings":{}}', file, extUri), { error: 'invalid' });
	});

	test('rewriting folders keeps the groups key and comments', () => {
		const content = '{\n\t// comment\n\t"folders": [{"path": "a"}],\n\t"supercode.groups": [{"name": "g", "folders": ["file:///a"]}]\n}';
		const edits = setProperty(content, ['folders'], [{ path: 'a' }, { path: 'b' }], { insertSpaces: false, tabSize: 4 });
		const result = applyEdits(content, edits);
		assert.ok(result.includes('// comment'));
		assert.ok(result.includes(WORKSPACE_GROUPS_KEY));
		assert.strictEqual(parse(result).folders.length, 2);
	});
});

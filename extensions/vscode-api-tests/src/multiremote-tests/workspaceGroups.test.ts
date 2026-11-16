/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';
import { poll } from '../utils';

type HostState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed' | 'none';

/**
 * Runs in the same local window as the `multi-remote window` suite (see scripts/test-multi-remote-integration.sh):
 * a local folder and one folder on each of the test resolver hosts `test+a` and `test+b`.
 */
suite('workspace groups', () => {

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const group = 'g-b';

	function getRoot(authority: string): vscode.Uri {
		const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'vscode-remote' && folder.uri.authority === authority);
		assert.ok(folder, `workspace folder of ${authority} not found`);
		return folder.uri;
	}

	const rootA = getRoot('test+a');
	const rootB = getRoot('test+b');

	async function getState(authority: string): Promise<HostState | undefined> {
		const states = await vscode.commands.executeCommand<{ authority: string; state: HostState }[]>('_multiRemote.getHostStates');
		return states.find(entry => entry.authority.toLowerCase() === authority)?.state;
	}

	function waitForState(authority: string, state: HostState, retryCount = 100): Promise<unknown> {
		return poll(() => getState(authority), actual => actual === state, `${authority} is ${state}`, retryCount, 100);
	}

	function sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	async function closeAll(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		for (const terminal of vscode.window.terminals) {
			terminal.dispose();
		}
	}

	async function ungroupAll(): Promise<void> {
		try {
			await vscode.commands.executeCommand('_workspaceGroups.setCollapsed', group, false);
		} catch {
			// the group may not exist
		}
		await vscode.commands.executeCommand('supercode.workspaceGroups.ungroup', group);
	}

	async function collapseAndWaitForDisconnect(): Promise<void> {
		await vscode.commands.executeCommand('_workspaceGroups.setCollapsed', group, true);
		await waitForState('test+b', 'disconnected');
	}

	setup(async () => {
		await closeAll();
		await vscode.workspace.getConfiguration('multiRemote').update('idleDisconnectDelay', 1, vscode.ConfigurationTarget.Global);

		// The multi-remote suite kills test+b's server; bring it back
		if ((await getState('test+b')) === 'failed') {
			await vscode.commands.executeCommand('vscode-testresolver.restoreServer', 'test+b');
			await vscode.commands.executeCommand('multiRemote.reconnectHost', rootB);
		}
		await waitForState('test+a', 'connected', 300);
		await waitForState('test+b', 'connected', 300);

		await vscode.commands.executeCommand('supercode.workspaceGroups.add', { name: group });
		await vscode.commands.executeCommand('supercode.workspaceGroups.moveTo', rootB, group);
	});

	teardown(async () => {
		await ungroupAll();
		await vscode.workspace.getConfiguration('multiRemote').update('idleDisconnectDelay', undefined, vscode.ConfigurationTarget.Global);
		await closeAll();
	});

	test('a collapsed group\'s host disconnects and stays disconnected', async () => {
		await waitForState('test+b', 'disconnected', 100);

		await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(rootB)), (error: unknown) => {
			assert.ok(error instanceof vscode.FileSystemError, `expected a FileSystemError, got ${error}`);
			assert.ok(/ is (not connected yet|unavailable)\.\)?$/.test(error.message), error.message);
			return true;
		});

		await sleep(2000);
		assert.strictEqual(await getState('test+b'), 'disconnected');
		assert.strictEqual(await getState('test+a'), 'connected');
	});

	test('expanding a group connects its host and lists its root', async () => {
		await collapseAndWaitForDisconnect();

		await vscode.commands.executeCommand('_workspaceGroups.setCollapsed', group, false);
		await waitForState('test+b', 'connected');

		await vscode.workspace.fs.readDirectory(rootB);
	});

	test('opening a file from a collapsed group\'s host connects it', async () => {
		const file = vscode.Uri.joinPath(rootB, 'group-open.txt');
		await vscode.workspace.fs.writeFile(file, encoder.encode('opened from a collapsed group'));
		await collapseAndWaitForDisconnect();

		// goes through the opener service like links do: the host connects before the file is looked at
		await vscode.commands.executeCommand('vscode.open', file);
		await waitForState('test+b', 'connected');

		await poll(
			async () => decoder.decode(await vscode.workspace.fs.readFile(file)),
			text => text === 'opened from a collapsed group',
			'the file loads', 100, 100
		);
		const document = await vscode.workspace.openTextDocument(file);
		assert.strictEqual(document.getText(), 'opened from a collapsed group');
	});

	test('the workspace file stores the group', async () => {
		const workspaceFile = vscode.workspace.workspaceFile;
		assert.ok(workspaceFile);

		const stored = await poll(
			async () => JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(workspaceFile))) as { 'supercode.groups'?: { name: string; folders: string[] }[] },
			content => !!content['supercode.groups']?.some(entry => entry.name === group),
			'the group is written to the workspace file', 50, 100
		);
		assert.deepStrictEqual(stored['supercode.groups']?.find(entry => entry.name === group), { name: group, folders: [rootB.toString()] });
	});

	test('test+a stays connected throughout', async () => {
		await collapseAndWaitForDisconnect();
		assert.strictEqual(await getState('test+a'), 'connected');

		await vscode.commands.executeCommand('_workspaceGroups.setCollapsed', group, false);
		await waitForState('test+b', 'connected');
		assert.strictEqual(await getState('test+a'), 'connected');
		await vscode.workspace.fs.readDirectory(rootA);
	});
});

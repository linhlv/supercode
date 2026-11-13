/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';
import { disposeAll, poll } from '../utils';

/**
 * Runs in a local window whose workspace (see scripts/test-multi-remote-integration.sh) holds
 * a local folder and one folder on each of the test resolver hosts `test+a` and `test+b`.
 */
suite('multi-remote window', () => {

	const disposables: vscode.Disposable[] = [];
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	function getRoot(predicate: (uri: vscode.Uri) => boolean): vscode.Uri {
		const folder = vscode.workspace.workspaceFolders?.find(folder => predicate(folder.uri));
		assert.ok(folder, 'workspace folder not found');
		return folder.uri;
	}

	const rootLocal = getRoot(uri => uri.scheme === 'file');
	const rootA = getRoot(uri => uri.scheme === 'vscode-remote' && uri.authority === 'test+a');
	const rootB = getRoot(uri => uri.scheme === 'vscode-remote' && uri.authority === 'test+b');

	async function exists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
				return false;
			}
			throw error;
		}
	}

	async function readText(uri: vscode.Uri): Promise<string> {
		return decoder.decode(await vscode.workspace.fs.readFile(uri));
	}

	function withTimeout<T>(promise: Thenable<T>, ms: number, message: string): Promise<T> {
		let handle: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			handle = setTimeout(() => reject(new Error(`Timeout after ${ms} ms: ${message}`)), ms);
		});
		return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(handle));
	}

	function createTerminal(cwd: vscode.Uri): vscode.Terminal {
		const terminal = vscode.window.createTerminal({ cwd });
		disposables.push(terminal);
		return terminal;
	}

	setup(async () => {
		// The window connects to both hosts in the background; a host that is not connected yet fails fast
		await poll(() => Promise.all([vscode.workspace.fs.stat(rootA), vscode.workspace.fs.stat(rootB)]), () => true, 'both hosts connected', 300, 100);
	});

	teardown(() => {
		disposeAll(disposables);
		disposables.length = 0;
	});

	test('reads and writes files on two hosts and a local folder', async () => {
		const files = [vscode.Uri.joinPath(rootLocal, 'l.txt'), vscode.Uri.joinPath(rootA, 'a.txt'), vscode.Uri.joinPath(rootB, 'b.txt')];
		for (const file of files) {
			await vscode.workspace.fs.writeFile(file, encoder.encode(`content of ${file.toString()}`));
		}

		const contents = await Promise.all(files.map(readText));
		assert.deepStrictEqual(contents, files.map(file => `content of ${file.toString()}`));

		const whereIsA = {
			local: await exists(vscode.Uri.joinPath(rootLocal, 'a.txt')),
			a: await exists(vscode.Uri.joinPath(rootA, 'a.txt')),
			b: await exists(vscode.Uri.joinPath(rootB, 'a.txt'))
		};
		assert.deepStrictEqual(whereIsA, { local: false, a: true, b: false });
	});

	test('terminals start on the right host in the root folder', async () => {
		// All hosts share this machine's file system, so the terminal names its host through the
		// variable that the test resolver sets on each server it starts
		for (const root of [rootA, rootB]) {
			const terminal = createTerminal(root);
			terminal.sendText('echo "$TESTRESOLVER_AUTHORITY $(pwd)" > where.txt');
			const where = vscode.Uri.joinPath(root, 'where.txt');
			const expected = `${root.authority} ${root.path}`;
			await poll(() => readText(where), content => content.trim() === expected, `"${expected}" written to ${where.toString()}`, 300, 100);
		}
	});

	test('watcher reports changes made on a host', async () => {
		const watched = vscode.Uri.joinPath(rootA, 'watched.txt');
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootA, '*.txt'));
		disposables.push(watcher);
		const created = new Promise<void>(resolve => {
			disposables.push(watcher.onDidCreate(uri => {
				if (uri.toString() === watched.toString()) {
					resolve();
				}
			}));
		});

		createTerminal(rootA).sendText('touch watched.txt');

		await withTimeout(created, 10_000, `onDidCreate for ${watched.toString()}`);
	});

	test('saving to a dead host fails and leaves other hosts working', async () => {
		await vscode.commands.executeCommand('vscode-testresolver.killServer', 'test+b');

		await assert.rejects(
			withTimeout(vscode.workspace.fs.writeFile(vscode.Uri.joinPath(rootB, 'x.txt'), encoder.encode('x')), 5_000, 'write to the dead host'),
			(error: unknown) => {
				assert.ok(error instanceof vscode.FileSystemError, `expected a FileSystemError, got ${error}`);
				// Core FileService wraps provider errors, so the API code is `Unknown`; the router's Unavailable error is in the message
				assert.ok(error.message.includes('is not connected yet.'), error.message);
				return true;
			}
		);

		const a = vscode.Uri.joinPath(rootA, 'a.txt');
		assert.strictEqual(await readText(a), `content of ${a.toString()}`);
	});
});

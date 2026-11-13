/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchConfigurationService } from '../../../../services/configuration/common/configuration.js';
import { IDecorationData, IDecorationsProvider, IDecorationsService } from '../../../../services/decorations/common/decorations.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IMultiRemoteService, IRemoteHostConnection, IRemoteHostStatus, RemoteHostState } from '../../../../services/remote/common/multiRemoteService.js';
import { IExplorerService } from '../../../files/browser/files.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { MultiRemoteWorkspaceContribution, ReconnectHostAction } from '../../browser/multiRemoteWorkspace.js';

suite('MultiRemoteWorkspace', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let folders: IWorkspaceFolder[];
	let stateEmitter: Emitter<IRemoteHostStatus>;
	let foldersEmitter: Emitter<IWorkspaceFoldersChangeEvent>;
	let connectCalls: string[];
	let reloaded: IWorkspaceFolder[];
	let explorerRefreshes: number;
	let provider: IDecorationsProvider | undefined;
	let states: Map<string, RemoteHostState>;
	let enabled: boolean;
	let disconnectCalls: string[];
	let terminalAuthorities: (string | undefined)[];

	function folder(authority: string | undefined, path: string, index: number): IWorkspaceFolder {
		const uri = authority ? URI.from({ scheme: Schemas.vscodeRemote, authority, path }) : URI.file(path);
		return { uri, name: path, index, toResource: p => URI.joinPath(uri, p) };
	}

	function create(): MultiRemoteWorkspaceContribution {
		const multiRemoteService = {
			isEnabled: enabled,
			onDidChangeHostState: stateEmitter.event,
			getState: (authority: string) => states.get(authority.toLowerCase()),
			getHosts: () => [],
			connect: (authority: string) => { connectCalls.push(authority); return new Promise<IRemoteHostConnection>(() => { }); },
			disconnect: async (authority: string) => { disconnectCalls.push(authority); }
		} as Partial<IMultiRemoteService> as IMultiRemoteService;
		const contextService = {
			getWorkspace: () => ({ folders }),
			onDidChangeWorkspaceFolders: foldersEmitter.event
		} as Partial<IWorkspaceContextService> as IWorkspaceContextService;
		const configurationService = {
			reloadConfiguration: async (target: IWorkspaceFolder) => { reloaded.push(target); }
		} as Partial<IWorkbenchConfigurationService> as IWorkbenchConfigurationService;
		const explorerService = { refresh: () => { explorerRefreshes++; } } as Partial<IExplorerService> as IExplorerService;
		const editorGroupsService = { groups: [] } as Partial<IEditorGroupsService> as IEditorGroupsService;
		const editorService = { openEditor: async () => undefined } as Partial<IEditorService> as IEditorService;
		const decorationsService = {
			registerDecorationsProvider: (p: IDecorationsProvider): IDisposable => { provider = p; return toDisposable(() => { provider = undefined; }); }
		} as Partial<IDecorationsService> as IDecorationsService;
		const labelService = { getHostLabel: (_scheme: string, authority: string) => `SSH: ${authority.substring('ssh-remote+'.length)}@box` } as Partial<ILabelService> as ILabelService;
		const terminalService = { get instances() { return terminalAuthorities.map(remoteAuthority => ({ remoteAuthority }) as ITerminalInstance); } } as Partial<ITerminalService> as ITerminalService;
		return store.add(new MultiRemoteWorkspaceContribution(multiRemoteService, contextService, configurationService, explorerService, editorGroupsService, editorService, labelService, terminalService, decorationsService));
	}

	setup(() => {
		stateEmitter = store.add(new Emitter<IRemoteHostStatus>());
		foldersEmitter = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		connectCalls = [];
		reloaded = [];
		explorerRefreshes = 0;
		provider = undefined;
		states = new Map();
		enabled = true;
		folders = [];
		disconnectCalls = [];
		terminalAuthorities = [];
	});

	test('connects every remote root at startup without awaiting', () => {
		folders = [folder(undefined, '/local', 0), folder('ssh-remote+a', '/one', 1), folder('ssh-remote+a', '/two', 2), folder('ssh-remote+b', '/three', 3)];
		create();
		assert.deepStrictEqual(connectCalls, ['ssh-remote+a', 'ssh-remote+b']);
	});

	test('local folders never trigger connect', () => {
		folders = [folder(undefined, '/local', 0)];
		create();
		assert.deepStrictEqual(connectCalls, []);
	});

	test('does nothing when disabled', () => {
		enabled = false;
		folders = [folder('ssh-remote+a', '/one', 0)];
		create();
		assert.deepStrictEqual({ connectCalls, provider: provider === undefined }, { connectCalls: [], provider: true });
	});

	test('adding a remote folder connects its host', () => {
		create();
		const added = folder('ssh-remote+c', '/x', 0);
		foldersEmitter.fire({ added: [added], removed: [], changed: [] });
		assert.deepStrictEqual(connectCalls, ['ssh-remote+c']);
	});

	test('removing the last root of a host disconnects it unless it has terminals', () => {
		const a1 = folder('ssh-remote+a', '/one', 0), a2 = folder('ssh-remote+A', '/two', 1), b = folder('ssh-remote+b', '/three', 2), c = folder('ssh-remote+c', '/four', 3);
		folders = [a1, a2, b, c];
		create();
		terminalAuthorities = [undefined, 'SSH-REMOTE+C'];

		folders = [a2];
		foldersEmitter.fire({ added: [], removed: [a1, b, c], changed: [] });
		const afterFirst = [...disconnectCalls];
		folders = [];
		foldersEmitter.fire({ added: [], removed: [a2], changed: [] });

		assert.deepStrictEqual({ afterFirst, all: disconnectCalls }, { afterFirst: ['ssh-remote+b'], all: ['ssh-remote+b', 'ssh-remote+A'] });
	});

	test('reloads configuration only for the connected host\'s roots', () => {
		folders = [folder(undefined, '/local', 0), folder('ssh-remote+a', '/one', 1), folder('ssh-remote+A', '/two', 2), folder('ssh-remote+b', '/three', 3)];
		create();
		stateEmitter.fire({ authority: 'ssh-remote+a', state: RemoteHostState.Connected });
		assert.deepStrictEqual({ reloaded: reloaded.map(f => f.uri.path), refreshes: explorerRefreshes }, { reloaded: ['/one', '/two'], refreshes: 1 });
	});

	test('failed host decorates its roots', async () => {
		folders = [folder('ssh-remote+a', '/one', 0), folder('ssh-remote+b', '/two', 1)];
		create();
		states.set('ssh-remote+a', RemoteHostState.Failed);
		stateEmitter.fire({ authority: 'ssh-remote+a', state: RemoteHostState.Failed, error: 'Permission denied' });
		const decoration = await provider!.provideDecorations(folders[0].uri, undefined!) as IDecorationData;
		const other = await provider!.provideDecorations(folders[1].uri, undefined!);
		const child = await provider!.provideDecorations(URI.joinPath(folders[0].uri, 'sub'), undefined!);
		assert.deepStrictEqual({ letter: decoration.letter, tooltip: decoration.tooltip, other, child }, { letter: '!', tooltip: 'SSH: a@box: Permission denied', other: undefined, child: undefined });
	});

	test('Reconnect Host is only offered in local windows', () => {
		const menu = new ReconnectHostAction().desc.menu;
		const when = (Array.isArray(menu) ? menu[0] : menu)?.when?.serialize();
		assert.ok(when?.includes(`remoteName == ''`), when);
	});
});

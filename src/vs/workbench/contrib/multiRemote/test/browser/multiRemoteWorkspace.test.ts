/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { timeout } from '../../../../../base/common/async.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchConfigurationService } from '../../../../services/configuration/common/configuration.js';
import { IDecorationData, IDecorationsProvider, IDecorationsService } from '../../../../services/decorations/common/decorations.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IMultiRemoteService, IRemoteHostConnection, IRemoteHostStatus, RemoteHostState } from '../../../../services/remote/common/multiRemoteService.js';
import { IWorkspaceGroup, IWorkspaceGroupsService, groupResource } from '../../../../services/workspaceGroups/common/workspaceGroups.js';
import { IExplorerService } from '../../../files/browser/files.js';
import { IHostDemandService } from '../../browser/hostDemand.js';
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
	let trusted: boolean;
	let trustEmitter: Emitter<boolean>;
	let demandEmitter: Emitter<void>;
	let groupsEmitter: Emitter<void>;
	/** Lower-cased authorities the fake demand service wants; `undefined` wants every host with roots. */
	let wanted: Set<string> | undefined;
	let groups: IWorkspaceGroup[];
	let idleDelay: number;

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
			reconnect: async (authority: string) => { connectCalls.push(`reconnect ${authority}`); return undefined!; },
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
		const rootAuthorities = () => [...new Map(folders.filter(f => f.uri.scheme === Schemas.vscodeRemote).map(f => [f.uri.authority.toLowerCase(), f.uri.authority])).values()];
		const hostDemandService = {
			onDidChange: demandEmitter.event,
			hasRoots: (authority: string) => rootAuthorities().some(a => a.toLowerCase() === authority.toLowerCase()),
			isWanted: (authority: string) => rootAuthorities().some(a => a.toLowerCase() === authority.toLowerCase()) && (!wanted || wanted.has(authority.toLowerCase())),
			getRootHosts: () => rootAuthorities(),
			getWantedHosts: () => rootAuthorities().filter(a => !wanted || wanted.has(a.toLowerCase())),
			isInUse: (authority: string) => folders.some(f => f.uri.authority.toLowerCase() === authority.toLowerCase()) || terminalAuthorities.some(a => a?.toLowerCase() === authority.toLowerCase())
		} as Partial<IHostDemandService> as IHostDemandService;
		const trustService = { isWorkspaceTrusted: () => trusted, onDidChangeTrust: trustEmitter.event } as Partial<IWorkspaceTrustManagementService> as IWorkspaceTrustManagementService;
		const groupsService = { get groups() { return groups; }, onDidChange: groupsEmitter.event } as Partial<IWorkspaceGroupsService> as IWorkspaceGroupsService;
		const configService = { getValue: () => idleDelay } as Partial<IConfigurationService> as IConfigurationService;
		return store.add(new MultiRemoteWorkspaceContribution(multiRemoteService, contextService, configurationService, explorerService, editorGroupsService, editorService, labelService, hostDemandService, trustService, groupsService, configService, decorationsService));
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
		trusted = true;
		trustEmitter = store.add(new Emitter<boolean>());
		demandEmitter = store.add(new Emitter<void>());
		groupsEmitter = store.add(new Emitter<void>());
		wanted = undefined;
		groups = [];
		idleDelay = 300;
	});

	test('connects every remote root at startup without awaiting', () => {
		folders = [folder(undefined, '/local', 0), folder('ssh-remote+a', '/one', 1), folder('ssh-remote+a', '/two', 2), folder('ssh-remote+b', '/three', 3)];
		create();
		assert.deepStrictEqual(connectCalls, ['ssh-remote+a', 'ssh-remote+b']);
	});

	test('an untrusted workspace connects no host until it is trusted', async () => {
		trusted = false;
		folders = [folder('ssh-remote+a', '/one', 0)];
		create();
		foldersEmitter.fire({ added: [folder('ssh-remote+b', '/two', 1)], removed: [], changed: [] });
		const untrusted = [...connectCalls];
		const decoration = await provider!.provideDecorations(folders[0].uri, undefined!) as IDecorationData;

		trusted = true;
		trustEmitter.fire(true);

		assert.deepStrictEqual({ untrusted, decoration: { letter: decoration.letter, tooltip: decoration.tooltip }, trusted: connectCalls }, {
			untrusted: [],
			decoration: { letter: '–', tooltip: 'SSH: a@box is not connected because the workspace is not trusted.' },
			trusted: ['ssh-remote+a']
		});
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
		folders = [added];
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

	test('connects only wanted hosts at startup', () => {
		folders = [folder('ssh-remote+a', '/one', 0), folder('ssh-remote+b', '/two', 1)];
		wanted = new Set(['ssh-remote+a']);
		create();
		assert.deepStrictEqual({ connectCalls, stateOfB: states.get('ssh-remote+b') }, { connectCalls: ['ssh-remote+a'], stateOfB: undefined });
	});

	test('connects wanted hosts once the groups are read', () => {
		folders = [folder('ssh-remote+a', '/one', 0)];
		wanted = new Set();
		create();
		const before = [...connectCalls];
		wanted = new Set(['ssh-remote+a']);
		demandEmitter.fire();
		demandEmitter.fire();
		assert.deepStrictEqual({ before, after: connectCalls }, { before: [], after: ['ssh-remote+a'] });
	});

	test('expanding a group connects its hosts in the background', () => {
		folders = [folder('ssh-remote+a', '/one', 0), folder('ssh-remote+b', '/two', 1)];
		wanted = new Set(['ssh-remote+a']);
		create();
		wanted.add('ssh-remote+b');
		demandEmitter.fire();
		assert.deepStrictEqual(connectCalls, ['ssh-remote+a', 'ssh-remote+b']);
	});

	test('reconnects a wanted disconnected host but not a failed one', () => {
		folders = [folder('ssh-remote+a', '/one', 0), folder('ssh-remote+b', '/two', 1)];
		wanted = new Set();
		states.set('ssh-remote+a', RemoteHostState.Disconnected);
		states.set('ssh-remote+b', RemoteHostState.Failed);
		create();
		wanted.add('ssh-remote+a').add('ssh-remote+b');
		demandEmitter.fire();
		assert.deepStrictEqual(connectCalls, ['ssh-remote+a']);
	});

	test('does not retry a failed host when its group is expanded', () => {
		folders = [folder('ssh-remote+a', '/one', 0)];
		wanted = new Set();
		states.set('ssh-remote+a', RemoteHostState.Failed);
		create();
		wanted.add('ssh-remote+a');
		demandEmitter.fire();
		assert.deepStrictEqual(connectCalls, []);
	});

	test('disconnects a host idle for the delay after its group collapses', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		folders = [folder('ssh-remote+a', '/one', 0)];
		states.set('ssh-remote+a', RemoteHostState.Connected);
		create();
		wanted = new Set();
		demandEmitter.fire();
		await timeout(299_000);
		const early = [...disconnectCalls];
		await timeout(1_000);
		assert.deepStrictEqual({ early, late: disconnectCalls }, { early: [], late: ['ssh-remote+a'] });
	}));

	test('wanted again before the delay keeps the host connected', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		folders = [folder('ssh-remote+a', '/one', 0)];
		states.set('ssh-remote+a', RemoteHostState.Connected);
		create();
		wanted = new Set();
		demandEmitter.fire();
		await timeout(200_000);
		wanted.add('ssh-remote+a');
		demandEmitter.fire();
		await timeout(400_000);
		assert.deepStrictEqual({ disconnectCalls, connectCalls }, { disconnectCalls: [], connectCalls: [] });
	}));

	test('a host without roots used only by a terminal is never idle-disconnected', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		folders = [];
		terminalAuthorities = ['ssh-remote+t'];
		states.set('ssh-remote+t', RemoteHostState.Connected);
		create();
		demandEmitter.fire();
		await timeout(1_000_000);
		assert.deepStrictEqual(disconnectCalls, []);
	}));

	test('removing a host\'s last root still disconnects it immediately', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const a = folder('ssh-remote+a', '/one', 0);
		folders = [a];
		states.set('ssh-remote+a', RemoteHostState.Connected);
		create();
		folders = [];
		foldersEmitter.fire({ added: [], removed: [a], changed: [] });
		assert.deepStrictEqual(disconnectCalls, ['ssh-remote+a']);
	}));

	test('a group with a failed host shows ! with each host\'s state in the tooltip', async () => {
		folders = [folder('ssh-remote+a', '/one', 0), folder('ssh-remote+b', '/two', 1)];
		groups = [{ name: 'shop', folders: folders.map(f => f.uri), collapsed: true }];
		states.set('ssh-remote+a', RemoteHostState.Connected);
		states.set('ssh-remote+b', RemoteHostState.Failed);
		create();
		const decoration = await provider!.provideDecorations(groupResource('shop'), undefined!) as IDecorationData;
		assert.deepStrictEqual({ letter: decoration.letter, tooltip: decoration.tooltip }, { letter: '!', tooltip: 'SSH: a@box: Connected\nSSH: b@box: Failed' });
	});

	test('an expanded group with a connecting host shows …', async () => {
		folders = [folder('ssh-remote+a', '/one', 0)];
		groups = [{ name: 'shop', folders: folders.map(f => f.uri), collapsed: false }];
		states.set('ssh-remote+a', RemoteHostState.Connecting);
		create();
		const decoration = await provider!.provideDecorations(groupResource('shop'), undefined!) as IDecorationData;
		assert.strictEqual(decoration.letter, '…');
	});

	test('a collapsed group shows no letter', async () => {
		folders = [folder('ssh-remote+a', '/one', 0)];
		groups = [{ name: 'shop', folders: folders.map(f => f.uri), collapsed: true }];
		states.set('ssh-remote+a', RemoteHostState.Connecting);
		create();
		const decoration = await provider!.provideDecorations(groupResource('shop'), undefined!);
		assert.strictEqual(decoration, undefined);
	});

	test('Reconnect Host is only offered in local windows', () => {
		const menu = new ReconnectHostAction().desc.menu;
		const when = (Array.isArray(menu) ? menu[0] : menu)?.when?.serialize();
		assert.ok(when?.includes(`remoteName == ''`), when);
	});

	test('Reconnect Host reconnects the host of the root, even one stuck reconnecting', async () => {
		const calls: string[] = [];
		const multiRemoteService = {
			connect: async (authority: string) => { calls.push(`connect ${authority}`); return undefined!; },
			reconnect: async (authority: string) => { calls.push(`reconnect ${authority}`); return undefined!; }
		} as Partial<IMultiRemoteService> as IMultiRemoteService;
		const accessor = { get: () => multiRemoteService } as Partial<ServicesAccessor> as ServicesAccessor;
		await new ReconnectHostAction().run(accessor, URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+a', path: '/app' }));
		assert.deepStrictEqual(calls, ['reconnect ssh-remote+a']);
	});
});

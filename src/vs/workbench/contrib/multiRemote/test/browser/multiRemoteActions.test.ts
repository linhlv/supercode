/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileDialogService, IOpenDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputButton, IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { IMultiRemoteService, IRemoteHostConnection, IRemoteHostStatus, RemoteHostState } from '../../../../services/remote/common/multiRemoteService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IHostDemandService } from '../../browser/hostDemand.js';
import { AddRemoteFolderToWorkspaceAction } from '../../browser/multiRemoteActions.js';
import { MultiRemoteStatusContribution } from '../../browser/multiRemoteStatus.js';

suite('MultiRemoteActions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const AUTHORITY = 'ssh-remote+a';

	let connectResult: Promise<IRemoteHostConnection>;
	let dialogCalls: IOpenDialogOptions[];
	let dialogResult: URI[] | undefined;
	let added: { uri: URI; name?: string }[][];
	let errors: string[];
	let hostLabel: string;
	let enabled: boolean;
	let connectCalls: number;
	let disconnected: string[];
	let workspaceFolders: IWorkspaceFolder[];
	let terminalAuthorities: string[];

	function accessor(): ServicesAccessor {
		const services = new Map<unknown, unknown>([
			[IMultiRemoteService, {
				isEnabled: enabled,
				connect: () => { connectCalls++; return connectResult; },
				disconnect: async (authority: string) => { disconnected.push(authority); }
			} as Partial<IMultiRemoteService>],
			[IHostDemandService, { isInUse: (authority: string) => workspaceFolders.some(f => f.uri.authority === authority) || terminalAuthorities.includes(authority) } as Partial<IHostDemandService>],
			[IProgressService, { withProgress: (_options: unknown, task: () => Promise<unknown>) => task() } as Partial<IProgressService>],
			[IFileDialogService, { showOpenDialog: async (options: IOpenDialogOptions) => { dialogCalls.push(options); return dialogResult; } } as Partial<IFileDialogService>],
			[IWorkspaceEditingService, { addFolders: async (folders: { uri: URI; name?: string }[]) => { added.push(folders); } } as Partial<IWorkspaceEditingService>],
			[INotificationService, { error: (message: string) => { errors.push(message); } } as Partial<INotificationService>],
			[ILabelService, { getHostLabel: () => hostLabel } as Partial<ILabelService>]
		]);
		return { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;
	}

	function connection(): Promise<IRemoteHostConnection> {
		return Promise.resolve({
			authority: AUTHORITY,
			connection: undefined!,
			environment: { userHome: URI.from({ scheme: Schemas.vscodeRemote, authority: AUTHORITY, path: '/home/a' }) }
		} as unknown as IRemoteHostConnection);
	}

	setup(() => {
		connectResult = connection();
		dialogCalls = [];
		dialogResult = undefined;
		added = [];
		errors = [];
		hostLabel = 'SSH: alice@box';
		enabled = true;
		connectCalls = 0;
		disconnected = [];
		workspaceFolders = [];
		terminalAuthorities = [];
	});

	test('adds the picked folder from the host\'s home, with a single-select dialog so that clicking a folder opens it', async () => {
		const picked = [URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/a/x' })];
		dialogResult = picked;
		await new AddRemoteFolderToWorkspaceAction().run(accessor(), AUTHORITY);

		assert.deepStrictEqual({
			homeOk: isEqual(dialogCalls[0].defaultUri!, URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/a' })),
			options: [dialogCalls[0].canSelectFolders, dialogCalls[0].canSelectFiles, dialogCalls[0].canSelectMany, dialogCalls[0].availableFileSystems],
			added: added.map(folders => folders.map(f => ({ uri: f.uri.toString(), name: f.name })))
		}, {
			homeOk: true,
			options: [true, false, false, [Schemas.vscodeRemote]],
			added: [[{ uri: picked[0].toString(), name: 'x [SSH: alice@box]' }]]
		});
	});

	test('cancelled dialog adds nothing and disconnects the host it connected', async () => {
		dialogResult = undefined;
		await new AddRemoteFolderToWorkspaceAction().run(accessor(), AUTHORITY);
		assert.deepStrictEqual({ dialogs: dialogCalls.length, added, disconnected }, { dialogs: 1, added: [], disconnected: [AUTHORITY] });
	});

	test('cancelled dialog keeps a host that has roots or terminals', async () => {
		const root = URI.from({ scheme: Schemas.vscodeRemote, authority: AUTHORITY, path: '/w' });
		workspaceFolders = [{ uri: root, name: 'w', index: 0, toResource: p => URI.joinPath(root, p) }];
		await new AddRemoteFolderToWorkspaceAction().run(accessor(), AUTHORITY);
		workspaceFolders = [];
		terminalAuthorities = [AUTHORITY];
		await new AddRemoteFolderToWorkspaceAction().run(accessor(), AUTHORITY);
		assert.deepStrictEqual({ dialogs: dialogCalls.length, disconnected }, { dialogs: 2, disconnected: [] });
	});

	test('does nothing in a window where multi-remote is disabled', async () => {
		enabled = false;
		dialogResult = [URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/a/x' })];
		await new AddRemoteFolderToWorkspaceAction().run(accessor(), AUTHORITY);
		assert.deepStrictEqual({ connectCalls, dialogs: dialogCalls.length, added }, { connectCalls: 0, dialogs: 0, added: [] });
	});

	test('connection failure reports and adds nothing', async () => {
		connectResult = Promise.reject(new Error('Host key verification failed'));
		hostLabel = '';
		await new AddRemoteFolderToWorkspaceAction().run(accessor(), AUTHORITY);
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].includes('Host key verification failed'));
		assert.ok(errors[0].includes(AUTHORITY));
		assert.deepStrictEqual({ dialogs: dialogCalls.length, added }, { dialogs: 0, added: [] });
	});

	suite('status', () => {
		let hosts: IRemoteHostStatus[];
		let folders: IWorkspaceFolder[];
		let entry: IStatusbarEntry | undefined;
		let entryId: string | undefined;
		let stateEmitter: Emitter<IRemoteHostStatus>;
		let foldersEmitter: Emitter<IWorkspaceFoldersChangeEvent>;
		let wantedAuthorities: string[] | undefined;
		let trusted: boolean;
		let statusConnectCalls: string[];
		let pickerItems: { authority?: string; description?: string; buttons?: IQuickInputButton[] }[];
		let triggerButton: ((item: { authority?: string }, button: IQuickInputButton) => void) | undefined;

		const current = () => entry;

		function remoteFolder(authority: string): IWorkspaceFolder {
			const uri = URI.from({ scheme: Schemas.vscodeRemote, authority, path: '/w' });
			return { uri, name: 'w', index: 0, toResource: p => URI.joinPath(uri, p) };
		}

		function create(): MultiRemoteStatusContribution {
			const multiRemoteService = {
				isEnabled: true,
				onDidChangeHostState: stateEmitter.event,
				getHosts: () => hosts,
				connect: async (authority: string) => { statusConnectCalls.push(authority); return undefined!; }
			} as Partial<IMultiRemoteService> as IMultiRemoteService;
			const contextService = {
				getWorkspace: () => ({ folders }),
				onDidChangeWorkspaceFolders: foldersEmitter.event
			} as Partial<IWorkspaceContextService> as IWorkspaceContextService;
			const statusbarService = {
				addEntry: (e: IStatusbarEntry, id: string): IStatusbarEntryAccessor => {
					entry = e; entryId = id;
					return { update: (u: IStatusbarEntry) => { entry = u; }, dispose: () => { entry = undefined; } } as IStatusbarEntryAccessor & IDisposable;
				}
			} as Partial<IStatusbarService> as IStatusbarService;
			const quickInputService = {
				createQuickPick: () => {
					const buttonEmitter = store.add(new Emitter<{ item: { authority?: string }; button: IQuickInputButton }>());
					const hideEmitter = store.add(new Emitter<void>());
					triggerButton = (item, button) => buttonEmitter.fire({ item, button });
					return {
						set items(value: readonly { authority?: string; description?: string; buttons?: IQuickInputButton[]; type?: string }[]) { pickerItems = value.filter(i => i.type !== 'separator' && i.authority); },
						onDidTriggerItemButton: buttonEmitter.event,
						onDidAccept: Event.None,
						onDidHide: hideEmitter.event,
						selectedItems: [],
						show: () => { },
						hide: () => hideEmitter.fire(),
						dispose: () => { }
					};
				}
			} as unknown as IQuickInputService;
			const rootHosts = () => [...new Set(folders.map(f => f.uri.authority))];
			return store.add(new MultiRemoteStatusContribution(
				multiRemoteService, contextService, statusbarService,
				quickInputService, { getHostLabel: () => '' } as Partial<ILabelService> as ILabelService,
				{} as ICommandService, {} as INotificationService,
				{
					onDidChange: Event.None,
					hasRoots: (authority: string) => folders.some(f => f.uri.authority.toLowerCase() === authority.toLowerCase()),
					getRootHosts: rootHosts,
					getWantedHosts: () => wantedAuthorities ?? rootHosts()
				} as Partial<IHostDemandService> as IHostDemandService,
				{ isWorkspaceTrusted: () => trusted } as Partial<IWorkspaceTrustManagementService> as IWorkspaceTrustManagementService));
		}

		setup(() => {
			stateEmitter = store.add(new Emitter<IRemoteHostStatus>());
			foldersEmitter = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
			hosts = [];
			folders = [];
			entry = undefined;
			entryId = undefined;
			wantedAuthorities = undefined;
			trusted = true;
			statusConnectCalls = [];
			pickerItems = [];
			triggerButton = undefined;
		});

		test('untrusted window with two never-connected remote roots shows no count change from before', () => {
			trusted = false;
			folders = [remoteFolder('ssh-remote+a'), remoteFolder('ssh-remote+b')];
			create();
			assert.strictEqual(entry?.text, '$(remote) 0/0');
		});

		test('Hosts n/m counts wanted hosts', () => {
			hosts = [{ authority: 'ssh-remote+a', state: RemoteHostState.Connected }, { authority: 'ssh-remote+c', state: RemoteHostState.Connected }];
			folders = [remoteFolder('ssh-remote+a'), remoteFolder('ssh-remote+b'), remoteFolder('ssh-remote+c')];
			wantedAuthorities = ['ssh-remote+a', 'ssh-remote+b'];
			create();
			assert.strictEqual(entry?.text, '$(remote) 1/2');
		});

		test('the picker lists idle hosts with roots as Not connected and Connect calls connect', async () => {
			hosts = [{ authority: 'ssh-remote+a', state: RemoteHostState.Connected }];
			folders = [remoteFolder('ssh-remote+a'), remoteFolder('ssh-remote+b')];
			wantedAuthorities = ['ssh-remote+a'];
			create();
			await CommandsRegistry.getCommand('multiRemote.showHosts')!.handler(undefined!);
			const idle = pickerItems.find(i => i.authority === 'ssh-remote+b')!;
			triggerButton!(idle, idle.buttons!.find(b => b.tooltip === 'Connect')!);
			assert.deepStrictEqual({ items: pickerItems.map(i => [i.authority, i.description]), connectCalls: statusConnectCalls }, {
				items: [['ssh-remote+a', 'Connected'], ['ssh-remote+b', 'Not connected']],
				connectCalls: ['ssh-remote+b']
			});
		});

		test('status text counts connected hosts', () => {
			hosts = [{ authority: 'ssh-remote+a', state: RemoteHostState.Connected }, { authority: 'ssh-remote+b', state: RemoteHostState.Failed, error: 'boom' }];
			folders = [remoteFolder('ssh-remote+a'), remoteFolder('ssh-remote+b')];
			create();
			assert.deepStrictEqual({ id: entryId, text: entry?.text }, { id: 'status.multiRemote', text: '$(remote) 1/2' });
		});

		test('status counts only hosts that have roots', () => {
			hosts = [{ authority: 'ssh-remote+a', state: RemoteHostState.Connected }, { authority: 'ssh-remote+b', state: RemoteHostState.Connected }, { authority: 'ssh-remote+c', state: RemoteHostState.Failed }];
			folders = [remoteFolder('ssh-remote+A')];
			create();
			assert.strictEqual(entry?.text, '$(remote) 1/1');
		});

		test('hidden without remote roots and shown once one is added', () => {
			hosts = [{ authority: 'ssh-remote+a', state: RemoteHostState.Connected }];
			create();
			assert.strictEqual(current(), undefined);
			folders = [remoteFolder('ssh-remote+a')];
			foldersEmitter.fire({ added: [], removed: [], changed: [] });
			assert.strictEqual(current()?.text, '$(remote) 1/1');
			hosts = [{ authority: 'ssh-remote+a', state: RemoteHostState.Failed }];
			stateEmitter.fire(hosts[0]);
			assert.strictEqual(current()?.text, '$(remote) 0/1');
		});
	});
});

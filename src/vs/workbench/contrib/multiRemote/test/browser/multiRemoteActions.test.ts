/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileDialogService, IOpenDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { IMultiRemoteService, IRemoteHostConnection, IRemoteHostStatus, RemoteHostState } from '../../../../services/remote/common/multiRemoteService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
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

	function accessor(): ServicesAccessor {
		const services = new Map<unknown, unknown>([
			[IMultiRemoteService, {
				connect: () => connectResult
			} as Partial<IMultiRemoteService>],
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
	});

	test('adds picked folders from the host\'s home', async () => {
		const picked = [URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/a/x' }), URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/a/y' })];
		dialogResult = picked;
		await new AddRemoteFolderToWorkspaceAction().run(accessor(), AUTHORITY);

		assert.deepStrictEqual({
			homeOk: isEqual(dialogCalls[0].defaultUri!, URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/a' })),
			options: [dialogCalls[0].canSelectFolders, dialogCalls[0].canSelectFiles, dialogCalls[0].canSelectMany, dialogCalls[0].availableFileSystems],
			added: added.map(folders => folders.map(f => ({ uri: f.uri.toString(), name: f.name })))
		}, {
			homeOk: true,
			options: [true, false, true, [Schemas.vscodeRemote]],
			added: [[{ uri: picked[0].toString(), name: 'x [SSH: alice@box]' }, { uri: picked[1].toString(), name: 'y [SSH: alice@box]' }]]
		});
	});

	test('cancelled dialog adds nothing', async () => {
		dialogResult = undefined;
		await new AddRemoteFolderToWorkspaceAction().run(accessor(), AUTHORITY);
		assert.deepStrictEqual({ dialogs: dialogCalls.length, added }, { dialogs: 1, added: [] });
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

		const current = () => entry;

		function remoteFolder(authority: string): IWorkspaceFolder {
			const uri = URI.from({ scheme: Schemas.vscodeRemote, authority, path: '/w' });
			return { uri, name: 'w', index: 0, toResource: p => URI.joinPath(uri, p) };
		}

		function create(): MultiRemoteStatusContribution {
			const multiRemoteService = {
				isEnabled: true,
				onDidChangeHostState: stateEmitter.event,
				getHosts: () => hosts
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
			return store.add(new MultiRemoteStatusContribution(
				multiRemoteService, contextService, statusbarService,
				{} as IQuickInputService, { getHostLabel: () => '' } as Partial<ILabelService> as ILabelService,
				{} as ICommandService, {} as INotificationService));
		}

		setup(() => {
			stateEmitter = store.add(new Emitter<IRemoteHostStatus>());
			foldersEmitter = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
			hosts = [];
			folders = [];
			entry = undefined;
			entryId = undefined;
		});

		test('status text counts connected hosts', () => {
			hosts = [{ authority: 'ssh-remote+a', state: RemoteHostState.Connected }, { authority: 'ssh-remote+b', state: RemoteHostState.Failed, error: 'boom' }];
			folders = [remoteFolder('ssh-remote+a')];
			create();
			assert.deepStrictEqual({ id: entryId, text: entry?.text }, { id: 'status.multiRemote', text: '$(remote) 1/2' });
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService, IOpenDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IMultiRemoteService, RemoteHostState } from '../../../../services/remote/common/multiRemoteService.js';
import { groupResource, IWorkspaceGroup, IWorkspaceGroupsService } from '../../../../services/workspaceGroups/common/workspaceGroups.js';
import { IExplorerService } from '../../../files/browser/files.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { IHostDemandService } from '../../browser/hostDemand.js';
import { AddSshFolderToGroupAction, AddWorkspaceAction, MoveToGroupAction, NewTerminalInGroupAction, RemoveGroupAction, RenameGroupAction, UngroupAction } from '../../browser/workspaceGroupsActions.js';

suite('WorkspaceGroupsActions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const a = URI.parse('file:///a');
	const b = URI.parse('file:///b');

	let calls: string[];
	let groups: IWorkspaceGroup[];
	let errors: string[];
	let infos: string[];
	let importResult: { groups: string[]; skipped: URI[] };
	let importError: Error | undefined;
	let pickAnswer: ((items: readonly IQuickPickItem[]) => IQuickPickItem | undefined) | undefined;
	let pickedItems: string[];
	let inputAnswer: string | undefined;
	let inputValidation: (string | undefined | null)[];
	let dialogResult: URI[] | undefined;
	let openDialogs: IOpenDialogOptions[];
	let confirmed: boolean;
	let confirmCalls: number;
	let terminalCwds: (URI | string | undefined)[];

	function group(name: string, folders: URI[] = []): IWorkspaceGroup {
		return { name, folders, collapsed: true };
	}

	function accessor(): ServicesAccessor {
		const services = new Map<unknown, unknown>([
			[IWorkspaceGroupsService, {
				get groups() { return groups; },
				getGroupOf: (folder: URI) => groups.find(g => g.folders.some(f => f.toString() === folder.toString())),
				createGroup: async (name: string) => { calls.push(`createGroup ${name}`); return name; },
				importWorkspaceFile: async (file: URI) => { calls.push(`import ${file.toString()}`); if (importError) { throw importError; } return importResult; },
				addFolders: async (name: string, folders: { uri: URI }[]) => { calls.push(`addFolders ${name} ${folders.map(f => f.uri.toString())}`); },
				renameGroup: async (name: string, newName: string) => { calls.push(`rename ${name} ${newName}`); },
				removeGroup: async (name: string, keep: boolean) => { calls.push(`remove ${name} keep=${keep}`); },
				moveFolder: async (folder: URI, name: string | undefined) => { calls.push(`move ${folder.toString()} ${name}`); },
				setFocusedGroup: (name: string | undefined) => { calls.push(`focus ${name}`); },
				setCollapsed: (name: string, collapsed: boolean) => { calls.push(`collapsed ${name} ${collapsed}`); }
			} as Partial<IWorkspaceGroupsService>],
			[IQuickInputService, {
				pick: async (items: readonly IQuickPickItem[]) => { pickedItems = items.map(i => i.label); return pickAnswer?.(items); },
				input: async (options: { validateInput?: (v: string) => Promise<string | undefined | null> }) => {
					for (const value of ['', 'taken', 'fresh']) {
						inputValidation.push(await options.validateInput?.(value));
					}
					return inputAnswer;
				}
			} as Partial<IQuickInputService>],
			[IFileDialogService, {
				showOpenDialog: async (options: IOpenDialogOptions) => { openDialogs.push(options); return dialogResult; },
				defaultWorkspacePath: async () => URI.parse('file:///home'),
				defaultFolderPath: async () => URI.parse('file:///home')
			} as Partial<IFileDialogService>],
			[INotificationService, { error: (m: string) => { errors.push(m); }, info: (m: string) => { infos.push(m); } } as Partial<INotificationService>],
			[ILabelService, { getUriLabel: (u: URI) => u.path } as Partial<ILabelService>],
			[IDialogService, { confirm: async () => { confirmCalls++; return { confirmed }; } } as Partial<IDialogService>],
			[ICommandService, { executeCommand: async (id: string) => { calls.push(`command ${id}`); } } as Partial<ICommandService>],
			[IPathService, { defaultUriScheme: 'file' } as Partial<IPathService>],
			[IWorkspaceContextService, { getWorkspaceFolder: () => null } as Partial<IWorkspaceContextService>],
			[ITerminalService, {
				createTerminal: async (options: { config: { cwd?: URI | string } }) => { terminalCwds.push(options.config.cwd); return { focus: () => { } }; },
				revealActiveTerminal: async () => { }
			} as unknown as ITerminalService],
			[IExplorerService, { getContext: () => [] } as Partial<IExplorerService>]
		]);
		return { get: (id: unknown) => { if (!services.has(id)) { throw new Error('unexpected service'); } return services.get(id); } } as unknown as ServicesAccessor;
	}

	setup(() => {
		calls = [];
		groups = [group('g', [a, b]), group('h')];
		errors = [];
		infos = [];
		importResult = { groups: ['shop'], skipped: [] };
		importError = undefined;
		pickAnswer = undefined;
		pickedItems = [];
		inputAnswer = undefined;
		inputValidation = [];
		dialogResult = undefined;
		openDialogs = [];
		confirmed = true;
		confirmCalls = 0;
		terminalCwds = [];
	});

	test('add with a name creates an empty group', async () => {
		await new AddWorkspaceAction().run(accessor(), { name: 'Backend' });
		assert.deepStrictEqual({ calls, errors }, { calls: ['createGroup Backend'], errors: [] });
	});

	test('add with a file imports and reports skipped folders', async () => {
		importResult = { groups: ['shop'], skipped: [a] };
		const file = URI.parse('file:///x/shop.code-workspace');
		await new AddWorkspaceAction().run(accessor(), { file });
		assert.deepStrictEqual({ calls, infos: infos.map(i => i.includes('/a')) }, { calls: [`import ${file.toString()}`], infos: [true] });
	});

	test('add through the picker imports the chosen file and creates a named group', async () => {
		dialogResult = [URI.parse('file:///x/shop.code-workspace')];
		pickAnswer = items => items[0];
		await new AddWorkspaceAction().run(accessor());
		const imported = { calls: [...calls], pickedItems: [...pickedItems], filters: openDialogs[0].filters };
		calls = [];
		pickAnswer = items => items[1];
		inputAnswer = 'Team';
		await new AddWorkspaceAction().run(accessor());
		assert.deepStrictEqual({ imported, created: calls, validation: inputValidation.map(Boolean) }, {
			imported: { calls: ['import file:///x/shop.code-workspace'], pickedItems: ['Import .code-workspace File…', 'New Empty Group…'], filters: [{ name: 'Workspace', extensions: ['code-workspace'] }] },
			created: ['createGroup Team'],
			validation: [true, false, false]
		});
	});

	test('add rejects a remote workspace file with a message', async () => {
		importError = new Error('\'x.code-workspace\' was saved from a remote window and cannot be imported.');
		await new AddWorkspaceAction().run(accessor(), { file: URI.parse('file:///x.code-workspace') });
		assert.deepStrictEqual({ errors, infos }, { errors: [importError.message], infos: [] });
	});

	test('rename validates the name', async () => {
		inputAnswer = 'renamed';
		await new RenameGroupAction().run(accessor(), groupResource('g'));
		// '' is empty, 'taken' only clashes once such a group exists
		groups.push(group('taken'));
		inputValidation = [];
		await new RenameGroupAction().run(accessor(), groupResource('g'));
		assert.deepStrictEqual({ calls, validation: inputValidation.map(Boolean) }, { calls: ['rename g renamed', 'rename g renamed'], validation: [true, true, false] });
	});

	test('remove asks for confirmation and removes the roots', async () => {
		confirmed = false;
		await new RemoveGroupAction().run(accessor(), groupResource('g'));
		confirmed = true;
		await new RemoveGroupAction().run(accessor(), groupResource('g'));
		assert.deepStrictEqual({ calls, confirmCalls }, { calls: ['remove g keep=false'], confirmCalls: 2 });
	});

	test('ungroup keeps the roots', async () => {
		await new UngroupAction().run(accessor(), 'g');
		await new UngroupAction().run(accessor(), groupResource('h'));
		assert.deepStrictEqual(calls, ['remove g keep=true', 'remove h keep=true']);
	});

	test('moveTo moves a root', async () => {
		const action = new MoveToGroupAction();
		await action.run(accessor(), a, 'h');
		await action.run(accessor(), a, undefined);
		pickAnswer = items => items[0];
		await action.run(accessor(), a, [a]);
		assert.deepStrictEqual({ calls, pickedItems }, { calls: [`move ${a} h`, `move ${a} undefined`, `move ${a} h`], pickedItems: ['h', 'Ungrouped'] });
	});

	test('addSsh focuses the group before starting the SSH host flow', async () => {
		await new AddSshFolderToGroupAction().run(accessor(), groupResource('h'));
		assert.deepStrictEqual(calls, ['focus h', 'command remote-ssh.addFolderToWorkspace']);
	});

	test('newTerminal offers only the group\'s roots', async () => {
		pickAnswer = items => items[1];
		await new NewTerminalInGroupAction().run(accessor(), groupResource('g'));
		assert.deepStrictEqual({ pickedItems, terminalCwds: terminalCwds.map(String) }, { pickedItems: ['/a', '/b'], terminalCwds: [b.toString()] });
	});

	test('getHostStates reports none for untouched hosts', async () => {
		const states = new Map<string, RemoteHostState>([['ssh-remote+a', RemoteHostState.Connected]]);
		const services = new Map<unknown, unknown>([
			[IHostDemandService, { getRootHosts: () => ['ssh-remote+a', 'ssh-remote+b'] } as Partial<IHostDemandService>],
			[IMultiRemoteService, { getState: (authority: string) => states.get(authority) } as Partial<IMultiRemoteService>]
		]);
		const handler = CommandsRegistry.getCommand('_multiRemote.getHostStates')!.handler;
		const result = handler({ get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor);
		assert.deepStrictEqual(result, [{ authority: 'ssh-remote+a', state: 'connected' }, { authority: 'ssh-remote+b', state: 'none' }]);
	});
});

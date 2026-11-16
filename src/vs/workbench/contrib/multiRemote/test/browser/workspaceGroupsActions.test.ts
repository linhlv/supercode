/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService, IOpenDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
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
import { AddFolderToGroupAction, AddSshFolderToGroupAction, AddWorkspaceAction, MoveToGroupAction, NewTerminalInGroupAction, RemoveGroupAction, RenameGroupAction, UngroupAction } from '../../browser/workspaceGroupsActions.js';

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
	let mutationError: Error | undefined;
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

	/**
	 * Runs an action like `IInstantiationService.invokeFunction` does: the accessor expires once
	 * the synchronous part of `run` has returned, so a service fetched after an `await` throws.
	 */
	function run(action: Action2, ...args: unknown[]): Promise<void> {
		let valid = true;
		const services = createServices();
		const accessor = {
			get: (id: unknown) => {
				if (!valid) {
					throw new Error('service accessor is only valid during the invocation of its target method');
				}
				if (!services.has(id)) {
					throw new Error('unexpected service');
				}
				return services.get(id);
			}
		} as unknown as ServicesAccessor;
		try {
			return Promise.resolve(action.run(accessor, ...args));
		} finally {
			valid = false;
		}
	}

	function createServices(): Map<unknown, unknown> {
		const services = new Map<unknown, unknown>([
			[IWorkspaceGroupsService, {
				get groups() { return groups; },
				getGroupOf: (folder: URI) => groups.find(g => g.folders.some(f => f.toString() === folder.toString())),
				createGroup: async (name: string) => { calls.push(`createGroup ${name}`); return name; },
				importWorkspaceFile: async (file: URI) => { calls.push(`import ${file.toString()}`); if (importError) { throw importError; } return importResult; },
				addFolders: async (name: string, folders: { uri: URI }[]) => { calls.push(`addFolders ${name} ${folders.map(f => f.uri.toString())}`); if (mutationError) { throw mutationError; } },
				renameGroup: async (name: string, newName: string) => { calls.push(`rename ${name} ${newName}`); if (mutationError) { throw mutationError; } },
				removeGroup: async (name: string, keep: boolean) => { calls.push(`remove ${name} keep=${keep}`); if (mutationError) { throw mutationError; } },
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
		return services;
	}

	setup(() => {
		calls = [];
		groups = [group('g', [a, b]), group('h')];
		errors = [];
		infos = [];
		importResult = { groups: ['shop'], skipped: [] };
		importError = undefined;
		mutationError = undefined;
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
		await run(new AddWorkspaceAction(), { name: 'Backend' });
		assert.deepStrictEqual({ calls, errors }, { calls: ['createGroup Backend'], errors: [] });
	});

	test('add with a file imports and reports skipped folders', async () => {
		importResult = { groups: ['shop'], skipped: [a] };
		const file = URI.parse('file:///x/shop.code-workspace');
		await run(new AddWorkspaceAction(), { file });
		assert.deepStrictEqual({ calls, infos: infos.map(i => i.includes('/a')) }, { calls: [`import ${file.toString()}`], infos: [true] });
	});

	test('add through the picker imports the chosen file and creates a named group', async () => {
		dialogResult = [URI.parse('file:///x/shop.code-workspace')];
		pickAnswer = items => items[0];
		await run(new AddWorkspaceAction());
		const imported = { calls: [...calls], pickedItems: [...pickedItems], filters: openDialogs[0].filters };
		calls = [];
		pickAnswer = items => items[1];
		inputAnswer = 'Team';
		await run(new AddWorkspaceAction());
		assert.deepStrictEqual({ imported, created: calls, validation: inputValidation.map(Boolean) }, {
			imported: { calls: ['import file:///x/shop.code-workspace'], pickedItems: ['Import .code-workspace File…', 'New Empty Group…'], filters: [{ name: 'Workspace', extensions: ['code-workspace'] }] },
			created: ['createGroup Team'],
			validation: [true, false, false]
		});
	});

	test('add rejects a remote workspace file with a message', async () => {
		importError = new Error('\'x.code-workspace\' was saved from a remote window and cannot be imported.');
		await run(new AddWorkspaceAction(), { file: URI.parse('file:///x.code-workspace') });
		assert.deepStrictEqual({ errors, infos }, { errors: [importError.message], infos: [] });
	});

	test('rename validates the name', async () => {
		inputAnswer = 'renamed';
		await run(new RenameGroupAction(), groupResource('g'));
		// '' is empty, 'taken' only clashes once such a group exists
		groups.push(group('taken'));
		inputValidation = [];
		await run(new RenameGroupAction(), groupResource('g'));
		assert.deepStrictEqual({ calls, validation: inputValidation.map(Boolean) }, { calls: ['rename g renamed', 'rename g renamed'], validation: [true, true, false] });
	});

	test('remove asks for confirmation and removes the roots', async () => {
		confirmed = false;
		await run(new RemoveGroupAction(), groupResource('g'));
		confirmed = true;
		await run(new RemoveGroupAction(), groupResource('g'));
		assert.deepStrictEqual({ calls, confirmCalls }, { calls: ['remove g keep=false'], confirmCalls: 2 });
	});

	test('ungroup keeps the roots', async () => {
		await run(new UngroupAction(), 'g');
		await run(new UngroupAction(), groupResource('h'));
		assert.deepStrictEqual(calls, ['remove g keep=true', 'remove h keep=true']);
	});

	test('moveTo moves a root', async () => {
		const action = new MoveToGroupAction();
		await run(action, a, 'h');
		await run(action, a, undefined);
		pickAnswer = items => items[0];
		await run(action, a, [a]);
		assert.deepStrictEqual({ calls, pickedItems }, { calls: [`move ${a} h`, `move ${a} undefined`, `move ${a} h`], pickedItems: ['h', 'New Group…', 'Ungrouped'] });
	});

	test('moveTo offers a new group, also in a window without groups', async () => {
		groups = [];
		pickAnswer = items => items.find(item => item.label === 'New Group…');
		inputAnswer = 'Fresh';
		await run(new MoveToGroupAction(), a, [a]);
		assert.deepStrictEqual({ calls, pickedItems, validation: inputValidation.map(Boolean) }, {
			calls: ['createGroup Fresh', `move ${a} Fresh`],
			pickedItems: ['New Group…'],
			validation: [true, false, false]
		});
	});

	test('addFolder adds the picked folders to the group', async () => {
		dialogResult = [URI.parse('file:///c')];
		await run(new AddFolderToGroupAction(), groupResource('h'));
		assert.deepStrictEqual({ calls, errors, fileSystems: openDialogs[0].availableFileSystems }, { calls: ['addFolders h file:///c'], errors: [], fileSystems: ['file'] });
	});

	test('failures after the first await are reported', async () => {
		mutationError = new Error('boom');
		dialogResult = [URI.parse('file:///c')];
		inputAnswer = 'renamed';
		await run(new AddFolderToGroupAction(), groupResource('h'));
		await run(new RenameGroupAction(), groupResource('g'));
		await run(new RemoveGroupAction(), groupResource('g'));
		await run(new UngroupAction(), 'g');
		assert.deepStrictEqual(errors, ['boom', 'boom', 'boom', 'boom']);
	});

	test('addSsh focuses the group before starting the SSH host flow', async () => {
		await run(new AddSshFolderToGroupAction(), groupResource('h'));
		assert.deepStrictEqual(calls, ['focus h', 'command remote-ssh.addFolderToWorkspace']);
	});

	test('newTerminal offers only the group\'s roots', async () => {
		pickAnswer = items => items[1];
		await run(new NewTerminalInGroupAction(), groupResource('g'));
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

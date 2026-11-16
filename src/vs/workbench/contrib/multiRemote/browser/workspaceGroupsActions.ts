/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, IAction2Options, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsWebContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { RemoteNameContext, WorkbenchStateContext } from '../../../common/contextkeys.js';
import { IMultiRemoteService } from '../../../services/remote/common/multiRemoteService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { groupNameOf, IWorkspaceGroupsService, validateGroupName } from '../../../services/workspaceGroups/common/workspaceGroups.js';
import { IExplorerService } from '../../files/browser/files.js';
import { isExplorerGroupItem, ExplorerGroupContextMenu } from '../../files/common/explorerGroupItem.js';
import { ExplorerGroupContext, ExplorerRootContext, FilesExplorerFocusedContext, VIEW_ID } from '../../files/common/files.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IHostDemandService } from './hostDemand.js';

/** Groups exist only in a local desktop window. */
const IsLocalWindow = ContextKeyExpr.and(RemoteNameContext.isEqualTo(''), IsWebContext.toNegated());

/** The command contributed by the SSH extension that picks a host and then calls `AddRemoteFolderToWorkspaceAction`. */
const ADD_SSH_FOLDER_COMMAND = 'remote-ssh.addFolderToWorkspace';

/**
 * Resolves the group a command acts on: a group resource or name passed as argument, else the focused Explorer item.
 * Commands fetch every service before their first `await`: the accessor expires once `run` yields.
 */
function resolveGroupName(explorerService: IExplorerService, arg: unknown): string | undefined {
	if (typeof arg === 'string') {
		return arg;
	}
	if (URI.isUri(arg)) {
		return groupNameOf(arg);
	}
	const focused = explorerService.getContext(true)[0];
	return isExplorerGroupItem(focused) ? focused.groupName : undefined;
}

function notifyError(notificationService: INotificationService, error: unknown): void {
	notificationService.error(getErrorMessage(error));
}

/** Shared registration of a command of the group context menu. */
abstract class WorkspaceGroupAction extends Action2 {

	constructor(id: string, title: ReturnType<typeof localize2>, group: string, order: number, keybinding?: IAction2Options['keybinding']) {
		super({
			id,
			title,
			f1: false,
			precondition: IsLocalWindow,
			menu: { id: ExplorerGroupContextMenu, group, order, when: IsLocalWindow },
			keybinding
		});
	}
}

/** Imports a `.code-workspace` file as groups, or creates an empty group. */
export class AddWorkspaceAction extends Action2 {

	static readonly ID = 'supercode.workspaceGroups.add';

	constructor() {
		super({
			id: AddWorkspaceAction.ID,
			title: localize2('workspaceGroups.add', "Add Workspace…"),
			f1: true,
			icon: Codicon.rootFolder,
			precondition: IsLocalWindow,
			menu: [
				{ id: MenuId.ViewTitle, group: 'navigation', order: 50, when: ContextKeyExpr.and(ContextKeyExpr.equals('view', VIEW_ID), IsLocalWindow) },
				{ id: MenuId.MenubarFileMenu, group: '3_workspace', order: 1.5, when: IsLocalWindow }
			]
		});
	}

	override async run(accessor: ServicesAccessor, args?: { name?: string; file?: URI }): Promise<void> {
		const groupsService = accessor.get(IWorkspaceGroupsService);
		const quickInputService = accessor.get(IQuickInputService);
		const fileDialogService = accessor.get(IFileDialogService);
		const notificationService = accessor.get(INotificationService);
		const labelService = accessor.get(ILabelService);
		const importFile = async (file: URI) => {
			const result = await groupsService.importWorkspaceFile(file);
			if (result.skipped.length) {
				notificationService.info(localize('workspaceGroups.skipped', "These folders are already in the workspace and were skipped: {0}", result.skipped.map(uri => labelService.getUriLabel(uri)).join(', ')));
			}
		};

		try {
			if (typeof args?.name === 'string') {
				await groupsService.createGroup(args.name);
				return;
			}
			if (URI.isUri(args?.file)) {
				await importFile(args.file);
				return;
			}

			const importItem: IQuickPickItem = { label: localize('workspaceGroups.importFile', "Import .code-workspace File…") };
			const newItem: IQuickPickItem = { label: localize('workspaceGroups.newEmptyGroup', "New Empty Group…") };
			const choice = await quickInputService.pick([importItem, newItem], { placeHolder: localize('workspaceGroups.addPlaceholder', "Add a workspace as a group") });
			if (choice === importItem) {
				const picked = await fileDialogService.showOpenDialog({
					title: localize('workspaceGroups.importTitle', "Import Workspace"),
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					defaultUri: await fileDialogService.defaultWorkspacePath(),
					filters: [{ name: localize('workspaceGroups.workspaceFilter', "Workspace"), extensions: ['code-workspace'] }]
				});
				if (picked?.length) {
					await importFile(picked[0]);
				}
			} else if (choice === newItem) {
				const name = await quickInputService.input({
					prompt: localize('workspaceGroups.namePrompt', "Name of the new group"),
					validateInput: async value => validateGroupName(value, groupsService.groups.map(group => group.name))
				});
				if (name !== undefined) {
					await groupsService.createGroup(name);
				}
			}
		} catch (error) {
			notifyError(notificationService, error);
		}
	}
}

export class AddFolderToGroupAction extends WorkspaceGroupAction {

	constructor() {
		super('supercode.workspaceGroups.addFolder', localize2('workspaceGroups.addFolder', "Add Folder to Group…"), '1_add', 10);
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const name = resolveGroupName(accessor.get(IExplorerService), arg);
		if (name === undefined) {
			return;
		}
		const fileDialogService = accessor.get(IFileDialogService);
		const pathService = accessor.get(IPathService);
		const groupsService = accessor.get(IWorkspaceGroupsService);
		const notificationService = accessor.get(INotificationService);
		try {
			const folders = await fileDialogService.showOpenDialog({
				title: localize('workspaceGroups.addFolderTitle', "Add Folder to Group"),
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: true,
				defaultUri: await fileDialogService.defaultFolderPath(),
				availableFileSystems: [pathService.defaultUriScheme]
			});
			if (folders?.length) {
				await groupsService.addFolders(name, folders.map(uri => ({ uri })));
			}
		} catch (error) {
			notifyError(notificationService, error);
		}
	}
}

export class AddSshFolderToGroupAction extends WorkspaceGroupAction {

	constructor() {
		super('supercode.workspaceGroups.addSshFolder', localize2('workspaceGroups.addSshFolder', "Add SSH Folder to Group…"), '1_add', 20);
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const name = resolveGroupName(accessor.get(IExplorerService), arg);
		if (name === undefined) {
			return;
		}
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);
		// The focused group receives the folders that the SSH flow adds to the workspace
		accessor.get(IWorkspaceGroupsService).setFocusedGroup(name);
		try {
			await commandService.executeCommand(ADD_SSH_FOLDER_COMMAND);
		} catch (error) {
			notifyError(notificationService, error);
		}
	}
}

export class NewTerminalInGroupAction extends WorkspaceGroupAction {

	constructor() {
		super('supercode.workspaceGroups.newTerminal', localize2('workspaceGroups.newTerminal', "New Terminal in Group"), '2_terminal', 10);
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const name = resolveGroupName(accessor.get(IExplorerService), arg);
		const group = accessor.get(IWorkspaceGroupsService).groups.find(candidate => candidate.name === name);
		if (!group) {
			return;
		}
		const terminalService = accessor.get(ITerminalService);
		const labelService = accessor.get(ILabelService);
		const contextService = accessor.get(IWorkspaceContextService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		let cwd: URI | undefined = group.folders.length === 1 ? group.folders[0] : undefined;
		if (!cwd) {
			const picked = await quickInputService.pick(
				group.folders.map(folder => ({
					label: contextService.getWorkspaceFolder(folder)?.name ?? labelService.getUriLabel(folder, { relative: true }),
					description: labelService.getUriLabel(folder),
					folder
				})),
				{ placeHolder: localize('workspaceGroups.pickRoot', "Select the folder to open a terminal in") });
			cwd = picked?.folder;
		}
		if (!cwd) {
			return;
		}
		try {
			const instance = await terminalService.createTerminal({ config: { cwd } });
			await terminalService.revealActiveTerminal();
			instance.focus();
		} catch (error) {
			notifyError(notificationService, error);
		}
	}
}

export class RenameGroupAction extends WorkspaceGroupAction {

	constructor() {
		super('supercode.workspaceGroups.rename', localize2('workspaceGroups.rename', "Rename Group"), '3_modify', 10, {
			weight: KeybindingWeight.WorkbenchContrib + 10,
			when: ContextKeyExpr.and(ExplorerGroupContext, FilesExplorerFocusedContext),
			primary: KeyCode.F2
		});
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const name = resolveGroupName(accessor.get(IExplorerService), arg);
		if (name === undefined) {
			return;
		}
		const groupsService = accessor.get(IWorkspaceGroupsService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		try {
			const newName = await quickInputService.input({
				value: name,
				prompt: localize('workspaceGroups.renamePrompt', "New name of the group"),
				validateInput: async value => validateGroupName(value, groupsService.groups.map(group => group.name), name)
			});
			if (newName !== undefined && newName.trim() !== name) {
				await groupsService.renameGroup(name, newName);
			}
		} catch (error) {
			notifyError(notificationService, error);
		}
	}
}

export class UngroupAction extends WorkspaceGroupAction {

	constructor() {
		super('supercode.workspaceGroups.ungroup', localize2('workspaceGroups.ungroup', "Ungroup"), '3_modify', 20);
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const name = resolveGroupName(accessor.get(IExplorerService), arg);
		if (name === undefined) {
			return;
		}
		const groupsService = accessor.get(IWorkspaceGroupsService);
		const notificationService = accessor.get(INotificationService);
		try {
			await groupsService.removeGroup(name, true);
		} catch (error) {
			notifyError(notificationService, error);
		}
	}
}

export class RemoveGroupAction extends WorkspaceGroupAction {

	constructor() {
		super('supercode.workspaceGroups.remove', localize2('workspaceGroups.remove', "Remove Group"), '3_modify', 30);
	}

	override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const name = resolveGroupName(accessor.get(IExplorerService), arg);
		const groupsService = accessor.get(IWorkspaceGroupsService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const group = groupsService.groups.find(candidate => candidate.name === name);
		if (!group) {
			return;
		}
		const confirmation = await dialogService.confirm({
			type: 'warning',
			message: localize('workspaceGroups.removeConfirm', "Remove the group '{0}' and its {1} folder(s) from the workspace?", group.name, group.folders.length),
			detail: localize('workspaceGroups.removeDetail', "The folders are not deleted from disk. Use Ungroup to keep them in the workspace."),
			primaryButton: localize({ key: 'workspaceGroups.removeButton', comment: ['&& denotes a mnemonic'] }, "&&Remove")
		});
		if (!confirmation.confirmed) {
			return;
		}
		try {
			await groupsService.removeGroup(group.name, false);
		} catch (error) {
			notifyError(notificationService, error);
		}
	}
}

/** Moves a root folder to another group or out of its group. */
export class MoveToGroupAction extends Action2 {

	static readonly ID = 'supercode.workspaceGroups.moveTo';

	constructor() {
		super({
			id: MoveToGroupAction.ID,
			title: localize2('workspaceGroups.moveTo', "Move to Group…"),
			f1: false,
			precondition: IsLocalWindow,
			menu: {
				id: MenuId.ExplorerContext,
				group: '2_workspace',
				order: 20,
				when: ContextKeyExpr.and(ExplorerRootContext, IsLocalWindow, WorkbenchStateContext.isEqualTo('workspace'))
			}
		});
	}

	/** Called as `(folder, groupName | undefined)` programmatically, or from the menu with the folder (and the selection) only. */
	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const [folder, target] = args;
		if (!URI.isUri(folder)) {
			return;
		}
		const groupsService = accessor.get(IWorkspaceGroupsService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		try {
			if (args.length >= 2 && !Array.isArray(target)) {
				await groupsService.moveFolder(folder, typeof target === 'string' ? target : undefined);
				return;
			}

			const current = groupsService.getGroupOf(folder);
			const newGroup: IQuickPickItem = { label: localize('workspaceGroups.newGroup', "New Group…") };
			const ungrouped: IQuickPickItem = { label: localize('workspaceGroups.ungrouped', "Ungrouped") };
			const items: IQuickPickItem[] = groupsService.groups
				.filter(group => group !== current && group.name !== current?.name)
				.map(group => ({ label: group.name }));
			items.push(newGroup);
			if (current) {
				items.push(ungrouped);
			}
			const picked = await quickInputService.pick(items, { placeHolder: localize('workspaceGroups.movePlaceholder', "Select the group to move the folder to") });
			if (!picked) {
				return;
			}
			if (picked === ungrouped) {
				await groupsService.moveFolder(folder, undefined);
			} else if (picked === newGroup) {
				const name = await quickInputService.input({
					prompt: localize('workspaceGroups.namePrompt', "Name of the new group"),
					validateInput: async value => validateGroupName(value, groupsService.groups.map(group => group.name))
				});
				if (name !== undefined) {
					await groupsService.moveFolder(folder, await groupsService.createGroup(name));
				}
			} else {
				await groupsService.moveFolder(folder, picked.label);
			}
		} catch (error) {
			notifyError(notificationService, error);
		}
	}
}

registerAction2(AddWorkspaceAction);
registerAction2(AddFolderToGroupAction);
registerAction2(AddSshFolderToGroupAction);
registerAction2(NewTerminalInGroupAction);
registerAction2(RenameGroupAction);
registerAction2(UngroupAction);
registerAction2(RemoveGroupAction);
registerAction2(MoveToGroupAction);

//#region commands for the integration tests

/** Connection state of a root host as reported by `_multiRemote.getHostStates`. */
export interface IHostStateReport {
	readonly authority: string;
	readonly state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed' | 'none';
}

export function getHostStates(accessor: ServicesAccessor): IHostStateReport[] {
	const multiRemoteService = accessor.get(IMultiRemoteService);
	return accessor.get(IHostDemandService).getRootHosts().map(authority => ({ authority, state: multiRemoteService.getState(authority) ?? 'none' }));
}

CommandsRegistry.registerCommand('_workspaceGroups.setCollapsed', (accessor: ServicesAccessor, groupName: string, collapsed: boolean) => {
	accessor.get(IWorkspaceGroupsService).setCollapsed(groupName, collapsed);
});

CommandsRegistry.registerCommand('_multiRemote.getHostStates', getHostStates);

//#endregion

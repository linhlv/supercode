/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { parse } from '../../../../base/common/json.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceFolderCreationData, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { IJSONEditingService } from '../../configuration/common/jsonEditing.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IWorkspaceEditingService } from '../../workspaces/common/workspaceEditing.js';
import { IGroupMembership, IWorkspaceGroup, IWorkspaceGroupsService, parseWorkspaceFileForImport, reconcileGroups, toStoredGroups, uniqueGroupName, validateGroupName, WORKSPACE_GROUPS_KEY } from '../common/workspaceGroups.js';

const COLLAPSED_STORAGE_KEY = 'workspaceGroups.collapsed';

function nameKey(name: string): string {
	return name.toLowerCase();
}

function folderKey(uri: URI): string {
	return (uri.scheme === 'vscode-remote' ? uri.with({ authority: uri.authority.toLowerCase() }) : uri).toString();
}

/**
 * Owns workspace-group membership (stored in the window's `.code-workspace` file) and the
 * collapsed state of each group (workspace storage).
 */
export class WorkspaceGroupsService extends Disposable implements IWorkspaceGroupsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	readonly whenReady: Promise<void>;

	private readonly queue = new Sequencer();
	/** Folders being added by this service for a specific group; the focused-group rule skips them. */
	private readonly explicitAdds = new Set<string>();

	private memberships: readonly IGroupMembership[] = [];
	private collapsedState: { [name: string]: boolean } = {};
	private cachedGroups: readonly IWorkspaceGroup[] = [];
	private focusedGroup: string | undefined;
	private requestedLoads = 0;
	private appliedLoad = 0;

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IJSONEditingService private readonly jsonEditingService: IJSONEditingService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService
	) {
		super();

		this.collapsedState = this.readCollapsedState();
		this.rebuild();

		this._register(this.contextService.onDidChangeWorkspaceFolders(e => {
			// Decide synchronously, so that folders being added through `addFolders` are recognised.
			const joining = e.added.filter(folder => !this.explicitAdds.has(folderKey(folder.uri))).map(folder => folder.uri);
			this.queue.queue(() => this.onFoldersChanged(joining));
		}));
		this._register(this.fileService.onDidFilesChange(e => {
			const configPath = this.configPath;
			if (configPath && e.contains(configPath)) {
				this.queue.queue(() => this.refresh());
			}
		}));

		this.whenReady = this.queue.queue(() => this.refresh()).catch(() => { });
	}

	get groups(): readonly IWorkspaceGroup[] {
		return this.cachedGroups;
	}

	getGroupOf(folder: URI): IWorkspaceGroup | undefined {
		const key = folderKey(folder);
		return this.cachedGroups.find(group => group.folders.some(candidate => folderKey(candidate) === key));
	}

	setCollapsed(name: string, collapsed: boolean): void {
		if (!this.isActive || !this.memberships.some(group => nameKey(group.name) === nameKey(name))) {
			return;
		}
		this.collapsedState = { ...this.collapsedState, [nameKey(name)]: collapsed };
		this.storeCollapsedState();
		this.rebuild();
		this._onDidChange.fire();
	}

	setFocusedGroup(name: string | undefined): void {
		this.focusedGroup = name;
	}

	createGroup(name: string, folders: readonly IWorkspaceFolderCreationData[] = []): Promise<string> {
		const trimmed = name.trim();
		const error = validateGroupName(trimmed, []);
		if (error) {
			return Promise.reject(new Error(error));
		}
		if (!this.isLocalDesktop) {
			return Promise.resolve(trimmed);
		}
		return this.queue.queue(async () => {
			if (this.contextService.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
				const unique = uniqueGroupName(trimmed, []);
				await this.createWorkspaceAndEnter([{ name: unique, folders: folders.map(folder => folder.uri) }], folders);
				return unique;
			}

			await this.refresh();
			const unique = uniqueGroupName(trimmed, this.memberships.map(group => group.name));
			await this.addToWorkspace(folders);
			await this.writeMemberships(this.assign(this.memberships, unique, folders.map(folder => folder.uri), true));
			return unique;
		});
	}

	addFolders(group: string, folders: readonly IWorkspaceFolderCreationData[]): Promise<void> {
		return this.mutate(async () => {
			const target = this.find(group);
			if (!target) {
				throw new Error(`Unknown workspace group '${group}'`);
			}
			await this.addToWorkspace(folders);
			await this.writeMemberships(this.assign(this.memberships, target.name, folders.map(folder => folder.uri)));
		});
	}

	renameGroup(name: string, newName: string): Promise<void> {
		const trimmed = newName.trim();
		return this.mutate(async () => {
			const target = this.find(name);
			if (!target) {
				return;
			}
			const error = validateGroupName(trimmed, this.memberships.map(group => group.name), target.name);
			if (error) {
				throw new Error(error);
			}
			const state = { ...this.collapsedState };
			if (nameKey(target.name) !== nameKey(trimmed) && nameKey(target.name) in state) {
				state[nameKey(trimmed)] = state[nameKey(target.name)];
				delete state[nameKey(target.name)];
			}
			this.collapsedState = state;
			this.storeCollapsedState();
			if (this.focusedGroup !== undefined && nameKey(this.focusedGroup) === nameKey(target.name)) {
				this.focusedGroup = trimmed;
			}
			await this.writeMemberships(this.memberships.map(group => group === target ? { name: trimmed, folders: group.folders } : group));
		});
	}

	removeGroup(name: string, keepFolders: boolean): Promise<void> {
		return this.mutate(async () => {
			const target = this.find(name);
			if (!target) {
				return;
			}
			if (!keepFolders && target.folders.length) {
				await this.workspaceEditingService.removeFolders([...target.folders]);
			}
			const state = { ...this.collapsedState };
			delete state[nameKey(target.name)];
			this.collapsedState = state;
			this.storeCollapsedState();
			await this.writeMemberships(this.memberships.filter(group => group !== target));
		});
	}

	moveFolder(folder: URI, group: string | undefined): Promise<void> {
		return this.mutate(async () => {
			const key = folderKey(folder);
			const target = group === undefined ? undefined : this.find(group);
			if (group !== undefined && !target) {
				return;
			}
			const current = this.memberships.find(candidate => candidate.folders.some(f => folderKey(f) === key));
			if (current === target) {
				return;
			}
			await this.writeMemberships(target ? this.assign(this.memberships, target.name, [folder]) : this.memberships.map(candidate => ({ name: candidate.name, folders: candidate.folders.filter(f => folderKey(f) !== key) })));
		});
	}

	importWorkspaceFile(file: URI): Promise<{ readonly groups: string[]; readonly skipped: URI[] }> {
		if (!this.isLocalDesktop) {
			return Promise.resolve({ groups: [], skipped: [] });
		}
		return this.queue.queue(async () => {
			const content = (await this.fileService.readFile(file)).value.toString();
			const imported = parseWorkspaceFileForImport(content, file, this.uriIdentityService.extUri);
			const fileName = this.uriIdentityService.extUri.basename(file);
			if ('error' in imported) {
				throw new Error(imported.error === 'remote'
					? localize('workspaceGroups.importRemote', "'{0}' was saved from a remote window and cannot be imported.", fileName)
					: localize('workspaceGroups.importInvalid', "'{0}' is not a valid workspace file.", fileName));
			}

			const state = this.contextService.getWorkbenchState();
			if (state === WorkbenchState.WORKSPACE) {
				await this.refresh();
			}
			const inWindow = new Set(this.contextService.getWorkspace().folders.map(folder => folderKey(folder.uri)));
			const skipped: URI[] = [];
			const toAdd: IWorkspaceFolderCreationData[] = [];
			for (const folder of imported.folders) {
				const key = folderKey(folder.uri);
				if (inWindow.has(key)) {
					if (!skipped.some(existing => folderKey(existing) === key)) {
						skipped.push(folder.uri);
					}
				} else {
					inWindow.add(key);
					toAdd.push(folder);
				}
			}

			const added = new Set(toAdd.map(folder => folderKey(folder.uri)));
			const source: IGroupMembership[] = imported.groups?.length ? imported.groups : [{ name: imported.name, folders: imported.folders.map(folder => folder.uri) }];
			const taken: string[] = state === WorkbenchState.WORKSPACE ? this.memberships.map(group => group.name) : [];
			const created: IGroupMembership[] = [];
			for (const group of source) {
				const name = uniqueGroupName(group.name.trim(), taken);
				taken.push(name);
				created.push({ name, folders: group.folders.filter(folder => added.has(folderKey(folder))) });
			}

			if (state === WorkbenchState.WORKSPACE) {
				await this.addToWorkspace(toAdd);
				await this.writeMemberships([...this.memberships, ...created]);
			} else {
				await this.createWorkspaceAndEnter(created, toAdd);
			}
			return { groups: created.map(group => group.name), skipped };
		});
	}

	//#region internals

	private get isLocalDesktop(): boolean {
		return this.environmentService.remoteAuthority === undefined && !isWeb;
	}

	private get isActive(): boolean {
		return this.isLocalDesktop && this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE;
	}

	private get configPath(): URI | undefined {
		return this.isActive ? this.contextService.getWorkspace().configuration ?? undefined : undefined;
	}

	private find(name: string): IGroupMembership | undefined {
		return this.memberships.find(group => nameKey(group.name) === nameKey(name));
	}

	/** Runs a mutation against freshly read state; a no-op where groups are not active. */
	private mutate(task: () => Promise<void>): Promise<void> {
		if (!this.isActive) {
			return Promise.resolve();
		}
		return this.queue.queue(async () => {
			await this.refresh();
			await task();
		});
	}

	/** Returns `groups` with `folders` moved into `name` (appended, or created when `create` is set). */
	private assign(groups: readonly IGroupMembership[], name: string, folders: readonly URI[], create = false): IGroupMembership[] {
		const moving = new Set(folders.map(folderKey));
		const result = groups.map(group => ({
			name: group.name,
			folders: nameKey(group.name) === nameKey(name)
				? [...group.folders.filter(folder => !moving.has(folderKey(folder))), ...folders]
				: group.folders.filter(folder => !moving.has(folderKey(folder)))
		}));
		if (create) {
			result.push({ name, folders: [...folders] });
		}
		return result;
	}

	private async onFoldersChanged(joining: readonly URI[]): Promise<void> {
		await this.refresh();
		const target = this.focusedGroup === undefined ? undefined : this.find(this.focusedGroup);
		if (this.isActive && target && joining.length) {
			await this.writeMemberships(this.assign(this.memberships, target.name, joining));
		}
	}

	private async addToWorkspace(folders: readonly IWorkspaceFolderCreationData[]): Promise<void> {
		const existing = new Set(this.contextService.getWorkspace().folders.map(folder => folderKey(folder.uri)));
		const missing = folders.filter(folder => !existing.has(folderKey(folder.uri)));
		if (!missing.length) {
			return;
		}
		const keys = missing.map(folder => folderKey(folder.uri));
		keys.forEach(key => this.explicitAdds.add(key));
		try {
			await this.workspaceEditingService.addFolders([...missing]);
		} finally {
			// the change event is delivered synchronously with the add; release after queued handlers were decided
			keys.forEach(key => this.explicitAdds.delete(key));
		}
	}

	/** Turns a folder or empty window into an untitled multi-root workspace holding the groups. */
	private async createWorkspaceAndEnter(groups: readonly IGroupMembership[], folders: readonly IWorkspaceFolderCreationData[]): Promise<void> {
		const current: IWorkspaceFolderCreationData[] = this.contextService.getWorkbenchState() === WorkbenchState.FOLDER
			? [{ uri: this.contextService.getWorkspace().folders[0].uri }]
			: [];
		const known = new Set(current.map(folder => folderKey(folder.uri)));
		const all = [...current, ...folders.filter(folder => !known.has(folderKey(folder.uri)))];

		const untitled = await this.workspacesService.createUntitledWorkspace(all);
		await this.jsonEditingService.write(untitled.configPath, [{ path: [WORKSPACE_GROUPS_KEY], value: toStoredGroups(groups) }], true);
		if (!this.userDataProfileService.currentProfile.isDefault) {
			await this.userDataProfilesService.setProfileForWorkspace(untitled, this.userDataProfileService.currentProfile);
		}
		await this.workspaceEditingService.enterWorkspace(untitled.configPath);
	}

	private async writeMemberships(groups: readonly IGroupMembership[]): Promise<void> {
		const configPath = this.configPath;
		if (!configPath) {
			return;
		}
		const folders = this.contextService.getWorkspace().folders.map(folder => folder.uri);
		const reconciled = reconcileGroups(toStoredGroups(groups), folders, this.uriIdentityService.extUri);
		await this.jsonEditingService.write(configPath, [{ path: [WORKSPACE_GROUPS_KEY], value: reconciled.length ? toStoredGroups(reconciled) : undefined }], true);
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		const configPath = this.configPath;
		const load = ++this.requestedLoads;
		let raw: unknown;
		if (configPath) {
			try {
				const content = await this.fileService.readFile(configPath);
				raw = parse(content.value.toString(), [], { allowTrailingComma: true })?.[WORKSPACE_GROUPS_KEY];
			} catch {
				raw = undefined;
			}
		}
		if (load < this.appliedLoad) {
			return;
		}
		this.appliedLoad = load;

		const folders = this.contextService.getWorkspace().folders.map(folder => folder.uri);
		const next = configPath ? reconcileGroups(raw, folders, this.uriIdentityService.extUri) : [];
		const changed = JSON.stringify(toStoredGroups(next)) !== JSON.stringify(toStoredGroups(this.memberships));
		this.memberships = next;
		this.rebuild();
		if (changed) {
			this._onDidChange.fire();
		}
	}

	private rebuild(): void {
		this.cachedGroups = this.memberships.map(group => ({
			name: group.name,
			folders: group.folders,
			collapsed: this.collapsedState[nameKey(group.name)] ?? true
		}));
	}

	private readCollapsedState(): { [name: string]: boolean } {
		try {
			const parsed = JSON.parse(this.storageService.get(COLLAPSED_STORAGE_KEY, StorageScope.WORKSPACE, '{}'));
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	private storeCollapsedState(): void {
		this.storageService.store(COLLAPSED_STORAGE_KEY, JSON.stringify(this.collapsedState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.rebuild();
	}

	//#endregion
}

registerSingleton(IWorkspaceGroupsService, WorkspaceGroupsService, InstantiationType.Delayed);

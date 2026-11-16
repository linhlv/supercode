/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { IExtUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceFolderCreationData, IStoredWorkspaceFolder, toWorkspaceFolders } from '../../../../platform/workspaces/common/workspaces.js';

/** Key in the `.code-workspace` file holding the groups. */
export const WORKSPACE_GROUPS_KEY = 'supercode.groups';

/** URI scheme of the synthetic resource representing a group in the Explorer. */
export const WORKSPACE_GROUP_SCHEME = 'supercode-group';

const WORKSPACE_FILE_EXTENSION = '.code-workspace';

/** A group as persisted in the workspace file. */
export interface IStoredWorkspaceGroup {
	readonly name: string;
	readonly folders: readonly string[];
}

/** A group's name and member workspace folders (in workspace order). */
export interface IGroupMembership {
	readonly name: string;
	readonly folders: readonly URI[];
}

export interface IWorkspaceGroup extends IGroupMembership {
	readonly collapsed: boolean;
}

export function groupResource(name: string): URI {
	return URI.from({ scheme: WORKSPACE_GROUP_SCHEME, path: '/' + encodeURIComponent(name) });
}

export function groupNameOf(resource: URI): string | undefined {
	if (resource.scheme !== WORKSPACE_GROUP_SCHEME) {
		return undefined;
	}
	try {
		return decodeURIComponent(resource.path.slice(1));
	} catch {
		return undefined;
	}
}

function nameKey(name: string): string {
	return name.toLowerCase();
}

/** Comparison key for a folder; `vscode-remote` authorities are case-insensitive. */
function folderKey(uri: URI, extUri: IExtUri): string {
	if (uri.scheme === 'vscode-remote') {
		uri = uri.with({ authority: uri.authority.toLowerCase() });
	}
	return extUri.getComparisonKey(uri);
}

/**
 * Validates the raw `supercode.groups` value against the current workspace folders: drops
 * malformed entries, stale folders, duplicate names (first wins) and folders already claimed by
 * an earlier group. Folders are returned as the workspace's own URIs, in workspace order.
 */
export function reconcileGroups(raw: unknown, workspaceFolders: readonly URI[], extUri: IExtUri): IGroupMembership[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const folderByKey = new Map<string, URI>();
	const orderByKey = new Map<string, number>();
	workspaceFolders.forEach((folder, index) => {
		const key = folderKey(folder, extUri);
		if (!folderByKey.has(key)) {
			folderByKey.set(key, folder);
			orderByKey.set(key, index);
		}
	});

	const result: IGroupMembership[] = [];
	const names = new Set<string>();
	const claimed = new Set<string>();
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
			continue;
		}
		const name = entry.name.trim();
		if (!name || names.has(nameKey(name))) {
			continue;
		}
		names.add(nameKey(name));

		const keys: string[] = [];
		for (const value of Array.isArray(entry.folders) ? entry.folders : []) {
			if (typeof value !== 'string') {
				continue;
			}
			let uri: URI;
			try {
				uri = URI.parse(value);
			} catch {
				continue;
			}
			const key = folderKey(uri, extUri);
			if (folderByKey.has(key) && !claimed.has(key)) {
				claimed.add(key);
				keys.push(key);
			}
		}
		keys.sort((x, y) => orderByKey.get(x)! - orderByKey.get(y)!);
		result.push({ name, folders: keys.map(key => folderByKey.get(key)!) });
	}
	return result;
}

export function toStoredGroups(groups: readonly IGroupMembership[]): IStoredWorkspaceGroup[] {
	return groups.map(group => ({ name: group.name, folders: group.folders.map(folder => folder.toString()) }));
}

/** Returns `name`, or `name (2)`, `name (3)`, ... when it clashes (case-insensitively) with `existing`. */
export function uniqueGroupName(name: string, existing: readonly string[]): string {
	const taken = new Set(existing.map(nameKey));
	if (!taken.has(nameKey(name))) {
		return name;
	}
	for (let i = 2; ; i++) {
		const candidate = `${name} (${i})`;
		if (!taken.has(nameKey(candidate))) {
			return candidate;
		}
	}
}

/**
 * @param current the group being renamed, if any (its own name does not count as a clash,
 * so a case-only rename is allowed)
 * @returns a localized error, or `undefined` when the name is valid
 */
export function validateGroupName(name: string, existing: readonly string[], current?: string): string | undefined {
	const trimmed = name.trim();
	if (!trimmed) {
		return localize('workspaceGroups.nameEmpty', "A group name is required.");
	}
	const key = nameKey(trimmed);
	const currentKey = current === undefined ? undefined : nameKey(current);
	if (existing.some(other => nameKey(other) === key && nameKey(other) !== currentKey)) {
		return localize('workspaceGroups.nameExists', "A group named '{0}' already exists.", trimmed);
	}
	return undefined;
}

export interface IImportedWorkspace {
	readonly name: string;
	readonly folders: IWorkspaceFolderCreationData[];
	/** The file's own groups reconciled against its folders; `undefined` when it has none. */
	readonly groups: IGroupMembership[] | undefined;
}

/** Reads a `.code-workspace` file for "Add Workspace": its folders and, if present, its groups. */
export function parseWorkspaceFileForImport(content: string, file: URI, extUri: IExtUri): IImportedWorkspace | { readonly error: 'invalid' | 'remote' } {
	const errors: ParseError[] = [];
	const raw = parse(content, errors, { allowTrailingComma: true });
	if (errors.length || !raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.folders)) {
		return { error: 'invalid' };
	}
	if (raw.remoteAuthority) {
		return { error: 'remote' };
	}

	const folders = toWorkspaceFolders(raw.folders as IStoredWorkspaceFolder[], file, extUri);
	const name = extUri.basename(file);
	return {
		name: name.endsWith(WORKSPACE_FILE_EXTENSION) ? name.slice(0, -WORKSPACE_FILE_EXTENSION.length) : name,
		folders: folders.map(folder => ({ uri: folder.uri, name: folder.raw?.name })),
		groups: raw[WORKSPACE_GROUPS_KEY] === undefined ? undefined : reconcileGroups(raw[WORKSPACE_GROUPS_KEY], folders.map(folder => folder.uri), extUri)
	};
}

export const IWorkspaceGroupsService = createDecorator<IWorkspaceGroupsService>('workspaceGroupsService');

export interface IWorkspaceGroupsService {

	readonly _serviceBrand: undefined;

	/** Fires when membership, order, names or collapsed state change. */
	readonly onDidChange: Event<void>;

	/** The groups in display order. */
	readonly groups: readonly IWorkspaceGroup[];

	getGroupOf(folder: URI): IWorkspaceGroup | undefined;
	setCollapsed(name: string, collapsed: boolean): void;
	setFocusedGroup(name: string | undefined): void;

	/** @returns the unique name used */
	createGroup(name: string, folders?: readonly IWorkspaceFolderCreationData[]): Promise<string>;
	addFolders(group: string, folders: readonly IWorkspaceFolderCreationData[]): Promise<void>;
	renameGroup(name: string, newName: string): Promise<void>;
	removeGroup(name: string, keepFolders: boolean): Promise<void>;
	/** @param group `undefined` ungroups the folder */
	moveFolder(folder: URI, group: string | undefined): Promise<void>;
	importWorkspaceFile(file: URI): Promise<{ readonly groups: string[]; readonly skipped: URI[] }>;
}

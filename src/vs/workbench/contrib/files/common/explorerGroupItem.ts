/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { groupResource, IWorkspaceGroup, IWorkspaceGroupsService } from '../../../services/workspaceGroups/common/workspaceGroups.js';
import { ExplorerItem } from './explorerModel.js';

/** Context menu of a workspace group in the Explorer (instead of `MenuId.ExplorerContext`). */
export const ExplorerGroupContextMenu = new MenuId('ExplorerGroupContext');

/**
 * A workspace group shown in the Explorer above its roots. The roots stay roots: they keep no
 * parent, so `isRoot`, ids and everything keyed on the root are unchanged inside a group.
 */
export class ExplorerGroupItem extends ExplorerItem {

	readonly groupName: string;
	readonly roots: ExplorerItem[];

	constructor(
		group: IWorkspaceGroup,
		roots: ExplorerItem[],
		@IFileService fileService: IFileService,
		@IConfigurationService configService: IConfigurationService,
		@IFilesConfigurationService filesConfigService: IFilesConfigurationService
	) {
		super(groupResource(group.name), fileService, configService, filesConfigService, undefined, true, false, true, false, group.name);
		this.groupName = group.name;
		this.roots = roots;
	}

	override get isRoot(): boolean {
		return false;
	}

	override get isReadonly(): boolean {
		return true;
	}

	override hasChildren(): boolean {
		return this.roots.length > 0;
	}

	override fetchChildren(): ExplorerItem[] {
		return this.roots;
	}

	override getId(): string {
		return this.resource.toString();
	}

	override toString(): string {
		return `ExplorerGroupItem: ${this.groupName}`;
	}
}

export function isExplorerGroupItem(item: unknown): item is ExplorerGroupItem {
	return item instanceof ExplorerGroupItem;
}

/**
 * The top level of the Explorer tree: the groups in display order, each holding its roots in
 * workspace order, then the roots that are in no group. Returns `roots` itself without groups.
 */
export function groupExplorerRoots(roots: ExplorerItem[], groupsService: Pick<IWorkspaceGroupsService, 'groups' | 'getGroupOf'>, createGroupItem: (group: IWorkspaceGroup, roots: ExplorerItem[]) => ExplorerGroupItem): ExplorerItem[] {
	const groups = groupsService.groups;
	if (!groups.length) {
		return roots;
	}

	const rootsByGroup = new Map<string, ExplorerItem[]>(groups.map(group => [group.name, []]));
	const ungrouped: ExplorerItem[] = [];
	for (const root of roots) {
		const group = groupsService.getGroupOf(root.resource);
		const groupRoots = group && rootsByGroup.get(group.name);
		if (groupRoots) {
			groupRoots.push(root);
		} else {
			ungrouped.push(root);
		}
	}

	return [...groups.map(group => createGroupItem(group, rootsByGroup.get(group.name)!)), ...ungrouped];
}

/** All roots of a tree input, the ones inside groups included. */
export function getExplorerRoots(input: ExplorerItem | ExplorerItem[] | undefined): ExplorerItem[] {
	if (!Array.isArray(input)) {
		return input ? [input] : [];
	}
	return input.flatMap(item => isExplorerGroupItem(item) ? item.roots : [item]);
}

/** The roots the Explorer may expand on its own: ungrouped roots and roots of expanded groups. */
export function getExpandableRoots(input: ExplorerItem[], isExpanded: (group: ExplorerGroupItem) => boolean): ExplorerItem[] {
	return input.flatMap(item => isExplorerGroupItem(item) ? (isExpanded(item) ? item.roots : []) : [item]);
}

/** `roots` without the roots of groups that are not expanded, e.g. the roots the Explorer find may search. */
export function getRootsOutsideCollapsedGroups(roots: readonly ExplorerItem[], input: ExplorerItem | ExplorerItem[] | undefined, isExpanded: (group: ExplorerGroupItem) => boolean): ExplorerItem[] {
	if (!Array.isArray(input)) {
		return [...roots];
	}
	const hidden = new Set(input.flatMap(item => isExplorerGroupItem(item) && !isExpanded(item) ? item.roots : []));
	return roots.filter(root => !hidden.has(root));
}

/** The group item of the tree input that holds `root`, if any. */
export function findExplorerGroupItem(input: ExplorerItem | ExplorerItem[] | undefined, root: ExplorerItem): ExplorerGroupItem | undefined {
	if (!Array.isArray(input)) {
		return undefined;
	}
	return input.find((item): item is ExplorerGroupItem => isExplorerGroupItem(item) && item.roots.includes(root));
}

/** The name of the group `item` is or belongs to. */
export function getGroupNameOfItem(item: ExplorerItem | undefined, getGroupOf: (folder: URI) => IWorkspaceGroup | undefined): string | undefined {
	if (!item) {
		return undefined;
	}
	return isExplorerGroupItem(item) ? item.groupName : getGroupOf(item.root.resource)?.name;
}

/** Returns the expanded ids of a tree view state with each group's state taken from `groups`. */
export function applyGroupCollapseState(expanded: readonly string[] | undefined, groups: readonly IWorkspaceGroup[]): string[] {
	const groupIds = new Set(groups.map(group => groupResource(group.name).toString()));
	return [
		...(expanded ?? []).filter(id => !groupIds.has(id)),
		...groups.filter(group => !group.collapsed).map(group => groupResource(group.name).toString())
	];
}

/** Whether a group starts collapsed in the tree (also while the Explorer find filters); `undefined` for other items. */
export function isGroupCollapsedByDefault(item: unknown, groups: readonly IWorkspaceGroup[]): boolean | undefined {
	if (!isExplorerGroupItem(item)) {
		return undefined;
	}
	return groups.find(group => group.name === item.groupName)?.collapsed ?? true;
}

/** A key that changes when group names, order or membership change, but not on collapsed state. */
export function getGroupsLayoutKey(groups: readonly IWorkspaceGroup[]): string {
	return JSON.stringify(groups.map(group => [group.name, group.folders.map(folder => folder.toString())]));
}

/**
 * Sort order of group items: groups come before roots and keep their display order.
 * `undefined` when neither item is a group.
 */
export function compareExplorerGroupItems(a: ExplorerItem, b: ExplorerItem): number | undefined {
	const aIsGroup = isExplorerGroupItem(a);
	const bIsGroup = isExplorerGroupItem(b);
	if (aIsGroup && bIsGroup) {
		return 0;
	}
	if (aIsGroup) {
		return -1;
	}
	if (bIsGroup) {
		return 1;
	}
	return undefined;
}

/** The description shown next to a group's name: how many roots it holds. */
export function getGroupDescription(item: ExplorerGroupItem): string {
	return item.roots.length === 1
		? localize('explorerGroupOneFolder', "1 folder")
		: localize('explorerGroupFolders', "{0} folders", item.roots.length);
}

/**
 * What dropping `dragged` onto `target` means for workspace groups: move the roots into a group
 * (or out of all groups), reject the drop, or `undefined` when groups don't take part and the
 * regular Explorer drag and drop applies (also for plain reordering within the same group).
 */
export function getGroupDropTarget(dragged: readonly ExplorerItem[], target: ExplorerItem | undefined, groupsService: Pick<IWorkspaceGroupsService, 'groups' | 'getGroupOf'>): { move: true; group: string | undefined } | { move: false } | undefined {
	if (!groupsService.groups.length) {
		return undefined;
	}
	if (dragged.some(isExplorerGroupItem)) {
		return { move: false };
	}

	const targetIsGroup = isExplorerGroupItem(target);
	if (!dragged.every(item => item.isRoot)) {
		return targetIsGroup ? { move: false } : undefined;
	}
	if (target && !targetIsGroup && !target.isRoot) {
		return undefined;
	}

	const targetGroup = target ? getGroupNameOfItem(target, folder => groupsService.getGroupOf(folder)) : undefined;
	const unchanged = dragged.every(item => groupsService.getGroupOf(item.resource)?.name === targetGroup);
	if (unchanged) {
		return targetIsGroup ? { move: false } : undefined;
	}
	return { move: true, group: targetGroup };
}

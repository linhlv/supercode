/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkspaceGroupsService } from '../../../services/workspaceGroups/common/workspaceGroups.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

export const IHostDemandService = createDecorator<IHostDemandService>('hostDemandService');

/** Decides which remote hosts the window wants to be connected. */
export interface IHostDemandService {

	readonly _serviceBrand: undefined;

	/** Fires when roots, groups, visible editors or terminals changed, so the answers may differ. */
	readonly onDidChange: Event<void>;

	/** Whether `authority` is the host of at least one workspace root. */
	hasRoots(authority: string): boolean;

	/**
	 * Whether the host should be connected: it has roots and one of them is ungrouped or in an
	 * expanded group, or an editor showing it is visible, or a terminal runs on it. Nothing is
	 * wanted until the groups were read from the workspace file.
	 */
	isWanted(authority: string): boolean;

	/** Authorities with roots, first spelling, deduplicated case-insensitively. */
	getRootHosts(): string[];

	getWantedHosts(): string[];

	/** Whether the host still has roots or terminals, so it has to stay connected. */
	isInUse(authority: string): boolean;
}

export class HostDemandService extends Disposable implements IHostDemandService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private ready = false;

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceGroupsService private readonly groupsService: IWorkspaceGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@ITerminalService private readonly terminalService: ITerminalService
	) {
		super();

		const fire = () => this._onDidChange.fire();
		this._register(this.contextService.onDidChangeWorkspaceFolders(fire));
		this._register(this.groupsService.onDidChange(fire));
		this._register(this.editorService.onDidVisibleEditorsChange(fire));
		this._register(this.terminalService.onDidCreateInstance(fire));
		this._register(this.terminalService.onDidDisposeInstance(fire));

		this.groupsService.whenReady.then(() => {
			if (!this._store.isDisposed) {
				this.ready = true;
				fire();
			}
		});
	}

	private getRoots(authority: string): URI[] {
		const key = authority.toLowerCase();
		return this.contextService.getWorkspace().folders
			.map(folder => folder.uri)
			.filter(uri => uri.scheme === Schemas.vscodeRemote && uri.authority.toLowerCase() === key);
	}

	hasRoots(authority: string): boolean {
		return this.getRoots(authority).length > 0;
	}

	isWanted(authority: string): boolean {
		if (!this.ready) {
			return false;
		}
		const roots = this.getRoots(authority);
		if (roots.length === 0) {
			return false;
		}
		if (roots.some(root => !this.groupsService.getGroupOf(root)?.collapsed)) {
			return true;
		}
		return this.hasVisibleEditor(authority) || this.hasTerminal(authority);
	}

	getRootHosts(): string[] {
		const seen = new Set<string>();
		const hosts: string[] = [];
		for (const folder of this.contextService.getWorkspace().folders) {
			const authority = folder.uri.authority;
			if (folder.uri.scheme === Schemas.vscodeRemote && authority && !seen.has(authority.toLowerCase())) {
				seen.add(authority.toLowerCase());
				hosts.push(authority);
			}
		}
		return hosts;
	}

	getWantedHosts(): string[] {
		return this.getRootHosts().filter(authority => this.isWanted(authority));
	}

	isInUse(authority: string): boolean {
		return this.hasRoots(authority) || this.hasTerminal(authority);
	}

	private hasTerminal(authority: string): boolean {
		const key = authority.toLowerCase();
		return this.terminalService.instances.some(instance => instance.remoteAuthority?.toLowerCase() === key);
	}

	private hasVisibleEditor(authority: string): boolean {
		const key = authority.toLowerCase();
		const matches = (uri: URI | undefined) => uri?.scheme === Schemas.vscodeRemote && uri.authority.toLowerCase() === key;
		return this.editorService.visibleEditors.some(editor => {
			const resource = EditorResourceAccessor.getCanonicalUri(editor, { supportSideBySide: SideBySideEditor.BOTH });
			return URI.isUri(resource) ? matches(resource) : matches(resource?.primary) || matches(resource?.secondary);
		});
	}
}

registerSingleton(IHostDemandService, HostDemandService, InstantiationType.Delayed);

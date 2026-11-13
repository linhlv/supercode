/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { listErrorForeground } from '../../../../platform/theme/common/colorRegistry.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { RemoteNameContext, ResourceContextKey } from '../../../common/contextkeys.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchConfigurationService } from '../../../services/configuration/common/configuration.js';
import { IDecorationData, IDecorationsProvider, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMultiRemoteService, RemoteHostState } from '../../../services/remote/common/multiRemoteService.js';
import { ExplorerRootContext } from '../../files/common/files.js';
import { IExplorerService } from '../../files/browser/files.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

/** Whether a remote host still has workspace roots or terminals, so it has to stay connected. */
export function isHostInUse(authority: string, contextService: IWorkspaceContextService, terminalService: ITerminalService): boolean {
	return hasRoots(authority, contextService) || terminalService.instances.some(instance => instance.remoteAuthority?.toLowerCase() === authority.toLowerCase());
}

/** Whether `authority` is the host of at least one workspace root. */
export function hasRoots(authority: string, contextService: IWorkspaceContextService): boolean {
	const key = authority.toLowerCase();
	return contextService.getWorkspace().folders.some(folder => folder.uri.scheme === Schemas.vscodeRemote && folder.uri.authority.toLowerCase() === key);
}

/**
 * Connects every remote host referenced by a workspace folder in the background, refreshes
 * the workspace when a host becomes connected and decorates roots of hosts that are not.
 */
export class MultiRemoteWorkspaceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.multiRemoteWorkspace';

	private readonly errors = new Map<string, string | undefined>();
	private readonly _onDidChangeDecorations = this._register(new Emitter<readonly URI[]>());

	constructor(
		@IMultiRemoteService private readonly multiRemoteService: IMultiRemoteService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkbenchConfigurationService private readonly configurationService: IWorkbenchConfigurationService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@ILabelService private readonly labelService: ILabelService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IDecorationsService decorationsService: IDecorationsService
	) {
		super();

		if (!multiRemoteService.isEnabled) {
			return;
		}

		this._register(decorationsService.registerDecorationsProvider(this.createDecorationsProvider()));

		this.connectHosts(this.contextService.getWorkspace().folders);
		this._register(this.workspaceTrustManagementService.onDidChangeTrust(trusted => {
			if (trusted) {
				this.connectHosts(this.contextService.getWorkspace().folders);
			}
			this._onDidChangeDecorations.fire(this.contextService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.vscodeRemote).map(folder => folder.uri));
		}));
		this._register(this.contextService.onDidChangeWorkspaceFolders(e => {
			this.connectHosts(e.added);
			this.disconnectUnusedHosts(e.removed);
		}));
		this._register(this.multiRemoteService.onDidChangeHostState(status => {
			this.errors.set(status.authority.toLowerCase(), status.error);
			if (status.state === RemoteHostState.Connected) {
				this.onDidConnect(status.authority);
			}
			this._onDidChangeDecorations.fire(this.getRoots(status.authority).map(folder => folder.uri));
		}));
	}

	private getRoots(authority: string): IWorkspaceFolder[] {
		const key = authority.toLowerCase();
		return this.contextService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.vscodeRemote && folder.uri.authority.toLowerCase() === key);
	}

	/** Connects the hosts of `folders` in the background. An untrusted workspace connects no host on its own. */
	private connectHosts(folders: readonly IWorkspaceFolder[]): void {
		if (!this.workspaceTrustManagementService.isWorkspaceTrusted()) {
			return;
		}
		const seen = new Set<string>();
		for (const folder of folders) {
			const authority = folder.uri.authority;
			if (folder.uri.scheme !== Schemas.vscodeRemote || !authority || seen.has(authority.toLowerCase())) {
				continue;
			}
			seen.add(authority.toLowerCase());
			// Failures are surfaced through the host state
			this.multiRemoteService.connect(authority).catch(() => { });
		}
	}

	/** Disconnects the hosts of removed roots that have no root and no terminal left. */
	private disconnectUnusedHosts(removed: readonly IWorkspaceFolder[]): void {
		const seen = new Set<string>();
		for (const folder of removed) {
			const authority = folder.uri.authority;
			if (folder.uri.scheme !== Schemas.vscodeRemote || !authority || seen.has(authority.toLowerCase())) {
				continue;
			}
			seen.add(authority.toLowerCase());
			if (!isHostInUse(authority, this.contextService, this.terminalService)) {
				this.multiRemoteService.disconnect(authority).catch(() => { /* surfaced through the host state */ });
			}
		}
	}

	private onDidConnect(authority: string): void {
		const key = authority.toLowerCase();
		for (const folder of this.getRoots(authority)) {
			this.configurationService.reloadConfiguration(folder).catch(() => { });
		}
		this.explorerService.refresh();
		for (const group of this.editorGroupsService.groups) {
			const editor = group.activeEditor;
			if (editor?.resource?.authority.toLowerCase() === key) {
				this.editorService.openEditor(editor, { preserveFocus: true, forceReload: true }, group).catch(() => { });
			}
		}
	}

	private createDecorationsProvider(): IDecorationsProvider {
		return {
			label: localize('multiRemote.hostStatus', "Remote Host Status"),
			onDidChange: this._onDidChangeDecorations.event as Event<readonly URI[]>,
			provideDecorations: (resource: URI): IDecorationData | undefined => {
				if (resource.scheme !== Schemas.vscodeRemote) {
					return undefined;
				}
				const isRoot = this.getRoots(resource.authority).some(folder => extUriBiasedIgnorePathCase.isEqual(folder.uri, resource));
				if (!isRoot) {
					return undefined;
				}
				const key = resource.authority.toLowerCase();
				const host = this.labelService.getHostLabel(Schemas.vscodeRemote, resource.authority) || resource.authority;
				const error = this.errors.get(key) ?? this.multiRemoteService.getHosts().find(h => h.authority.toLowerCase() === key)?.error;
				const state = this.multiRemoteService.getState(resource.authority);
				switch (state) {
					case RemoteHostState.Connecting:
					case RemoteHostState.Reconnecting:
						return { letter: '…', tooltip: localize('multiRemote.connecting', "Connecting to {0}…", host), weight: 10 };
					case RemoteHostState.Failed:
						return {
							letter: '!',
							color: listErrorForeground,
							tooltip: localize('multiRemote.failed', "{0}: {1}", host, error ?? localize('multiRemote.connectionLost', "connection lost")),
							weight: 10
						};
					case RemoteHostState.Disconnected:
						return { letter: '–', tooltip: localize('multiRemote.disconnected', "{0} is disconnected", host), weight: 10 };
					case undefined:
						return this.workspaceTrustManagementService.isWorkspaceTrusted()
							? undefined
							: { letter: '–', tooltip: localize('multiRemote.notTrusted', "{0} is not connected because the workspace is not trusted.", host), weight: 10 };
					default:
						return undefined;
				}
			}
		};
	}
}

/** Explorer context menu action that reconnects the host of a remote workspace root. */
export class ReconnectHostAction extends Action2 {

	static readonly ID = 'multiRemote.reconnectHost';

	constructor() {
		super({
			id: ReconnectHostAction.ID,
			title: localize2('multiRemote.reconnectHost', "Reconnect Host"),
			f1: false,
			menu: {
				id: MenuId.ExplorerContext,
				group: '2_workspace',
				order: 100,
				when: ContextKeyExpr.and(RemoteNameContext.isEqualTo(''), ExplorerRootContext, ResourceContextKey.Scheme.isEqualTo(Schemas.vscodeRemote))
			}
		});
	}

	override async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
		const multiRemoteService = accessor.get(IMultiRemoteService);
		if (resource?.scheme === Schemas.vscodeRemote && resource.authority) {
			await multiRemoteService.connect(resource.authority).catch(() => { });
		}
	}
}

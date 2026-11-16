/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
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
import { IWorkspaceGroupsService, WORKSPACE_GROUP_SCHEME, groupNameOf, groupResource } from '../../../services/workspaceGroups/common/workspaceGroups.js';
import { ExplorerRootContext } from '../../files/common/files.js';
import { IExplorerService } from '../../files/browser/files.js';
import { IHostDemandService } from './hostDemand.js';

/** Default of `multiRemote.idleDisconnectDelay`, in seconds. */
const DEFAULT_IDLE_DISCONNECT_DELAY = 300;
/** Longest delay a timer supports; longer ones fire at once. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Connects the remote hosts the window wants in the background, disconnects hosts that only
 * collapsed groups use once they were idle for a while, refreshes the workspace when a host
 * becomes connected and decorates roots and groups of hosts that are not.
 */
export class MultiRemoteWorkspaceContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.multiRemoteWorkspace';

	private readonly errors = new Map<string, string | undefined>();
	private readonly _onDidChangeDecorations = this._register(new Emitter<readonly URI[]>());
	/** Idle timers by lower-cased authority. */
	private readonly idleTimers = this._register(new DisposableMap<string>());
	/** Lower-cased authorities with a connect call in flight. */
	private readonly connecting = new Set<string>();
	/** Lower-cased authorities this contribution disconnected for being idle; only those reconnect on their own. */
	private readonly idleDisconnected = new Set<string>();

	constructor(
		@IMultiRemoteService private readonly multiRemoteService: IMultiRemoteService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkbenchConfigurationService private readonly configurationService: IWorkbenchConfigurationService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@ILabelService private readonly labelService: ILabelService,
		@IHostDemandService private readonly hostDemandService: IHostDemandService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceGroupsService private readonly groupsService: IWorkspaceGroupsService,
		@IConfigurationService private readonly settingsService: IConfigurationService,
		@IDecorationsService decorationsService: IDecorationsService
	) {
		super();

		if (!multiRemoteService.isEnabled) {
			return;
		}

		this._register(decorationsService.registerDecorationsProvider(this.createDecorationsProvider()));

		this.update();
		this._register(this.hostDemandService.onDidChange(() => this.update()));
		this._register(this.workspaceTrustManagementService.onDidChangeTrust(trusted => {
			if (trusted) {
				this.update();
			}
			this._onDidChangeDecorations.fire(this.contextService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.vscodeRemote).map(folder => folder.uri));
		}));
		this._register(this.contextService.onDidChangeWorkspaceFolders(e => {
			this.disconnectUnusedHosts(e.removed);
			this.connectAddedHosts(e.added);
			this.update();
		}));
		this._register(this.groupsService.onDidChange(() => this._onDidChangeDecorations.fire(this.groupsService.groups.map(group => groupResource(group.name)))));
		this._register(this.multiRemoteService.onDidChangeHostState(status => {
			this.errors.set(status.authority.toLowerCase(), status.error);
			if (status.state === RemoteHostState.Connecting || status.state === RemoteHostState.Connected) {
				this.idleDisconnected.delete(status.authority.toLowerCase());
			}
			if (status.state === RemoteHostState.Connected) {
				this.onDidConnect(status.authority);
			}
			this._onDidChangeDecorations.fire([...this.getRoots(status.authority).map(folder => folder.uri), ...this.getGroupResources(status.authority)]);
			// A host that becomes active while no one wants it starts its idle timer
			this.update();
		}));
	}

	private getRoots(authority: string): IWorkspaceFolder[] {
		const key = authority.toLowerCase();
		return this.contextService.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.vscodeRemote && folder.uri.authority.toLowerCase() === key);
	}

	private getGroupResources(authority: string): URI[] {
		const key = authority.toLowerCase();
		return this.groupsService.groups
			.filter(group => group.folders.some(folder => folder.scheme === Schemas.vscodeRemote && folder.authority.toLowerCase() === key))
			.map(group => groupResource(group.name));
	}

	/**
	 * Brings connections in line with what the window wants: connects wanted hosts that are
	 * untouched or disconnected (never a failed one), and starts or cancels idle timers.
	 * Cheap and idempotent, as it runs on every change of the demand.
	 */
	private update(): void {
		const trusted = this.workspaceTrustManagementService.isWorkspaceTrusted();
		const withRoots = new Set<string>();
		for (const authority of this.hostDemandService.getRootHosts()) {
			const key = authority.toLowerCase();
			withRoots.add(key);
			const state = this.multiRemoteService.getState(authority);
			if (this.hostDemandService.isWanted(authority)) {
				this.idleTimers.deleteAndDispose(key);
				// A manual disconnect sticks: only untouched hosts and hosts disconnected for being idle connect on their own
				if (trusted && (state === undefined || (state === RemoteHostState.Disconnected && this.idleDisconnected.has(key)))) {
					this.connectHost(authority);
				}
			} else if (state === RemoteHostState.Connecting || state === RemoteHostState.Connected || state === RemoteHostState.Reconnecting) {
				if (!this.idleTimers.has(key)) {
					this.startIdleTimer(authority);
				}
			} else {
				this.idleTimers.deleteAndDispose(key);
			}
		}
		for (const key of [...this.idleTimers.keys()]) {
			if (!withRoots.has(key)) {
				this.idleTimers.deleteAndDispose(key);
			}
		}
		for (const key of [...this.idleDisconnected]) {
			if (!withRoots.has(key)) {
				this.idleDisconnected.delete(key);
			}
		}
	}

	private connectHost(authority: string): void {
		const key = authority.toLowerCase();
		if (this.connecting.has(key)) {
			return;
		}
		this.connecting.add(key);
		// Failures are surfaced through the host state
		this.multiRemoteService.connect(authority).catch(() => { }).finally(() => this.connecting.delete(key));
	}

	/** Adding a root retries a failed host, unlike expanding a group; an untrusted workspace connects nothing. */
	private connectAddedHosts(added: readonly IWorkspaceFolder[]): void {
		if (!this.workspaceTrustManagementService.isWorkspaceTrusted()) {
			return;
		}
		for (const folder of added) {
			const authority = folder.uri.authority;
			if (folder.uri.scheme !== Schemas.vscodeRemote || !authority || !this.hostDemandService.isWanted(authority)) {
				continue;
			}
			const state = this.multiRemoteService.getState(authority);
			if (state === undefined || state === RemoteHostState.Failed || state === RemoteHostState.Disconnected) {
				this.connectHost(authority);
			}
		}
	}

	private startIdleTimer(authority: string): void {
		const key = authority.toLowerCase();
		this.idleTimers.set(key, disposableTimeout(() => {
			this.idleTimers.deleteAndDispose(key);
			const state = this.multiRemoteService.getState(authority);
			const active = state === RemoteHostState.Connecting || state === RemoteHostState.Connected || state === RemoteHostState.Reconnecting;
			if (active && this.hostDemandService.hasRoots(authority) && !this.hostDemandService.isWanted(authority)) {
				this.idleDisconnected.add(key);
				this.multiRemoteService.disconnect(authority).catch(() => { /* surfaced through the host state */ });
			}
		}, this.getIdleDelay()));
	}

	/** The idle delay in milliseconds: the default for a value that is not a number, at most what a timer supports. */
	private getIdleDelay(): number {
		const value = this.settingsService.getValue<unknown>('multiRemote.idleDisconnectDelay');
		const seconds = typeof value === 'number' && !isNaN(value) ? value : DEFAULT_IDLE_DISCONNECT_DELAY;
		return Math.min(Math.max(0, seconds) * 1000, MAX_TIMEOUT);
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
			if (!this.hostDemandService.isInUse(authority)) {
				this.idleTimers.deleteAndDispose(authority.toLowerCase());
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

	/** Summarizes the hosts of a group: `!` if one failed, `…` while one connects in an expanded group. */
	private provideGroupDecoration(resource: URI): IDecorationData | undefined {
		const name = groupNameOf(resource)?.toLowerCase();
		const group = this.groupsService.groups.find(g => g.name.toLowerCase() === name);
		if (!group) {
			return undefined;
		}
		const authorities = new Map<string, string>();
		for (const folder of group.folders) {
			if (folder.scheme === Schemas.vscodeRemote && folder.authority && !authorities.has(folder.authority.toLowerCase())) {
				authorities.set(folder.authority.toLowerCase(), folder.authority);
			}
		}
		const hosts = [...authorities.values()].map(authority => ({ authority, state: this.multiRemoteService.getState(authority) }));
		const tooltip = hosts.map(host => localize('multiRemote.groupHostState', "{0}: {1}", this.labelService.getHostLabel(Schemas.vscodeRemote, host.authority) || host.authority, this.describeState(host.state))).join('\n');
		if (hosts.some(host => host.state === RemoteHostState.Failed)) {
			return { letter: '!', color: listErrorForeground, tooltip, weight: 10 };
		}
		if (!group.collapsed && hosts.some(host => host.state === RemoteHostState.Connecting || host.state === RemoteHostState.Reconnecting)) {
			return { letter: '…', tooltip, weight: 10 };
		}
		return undefined;
	}

	private describeState(state: RemoteHostState | undefined): string {
		switch (state) {
			case RemoteHostState.Connected: return localize('multiRemote.groupConnected', "Connected");
			case RemoteHostState.Connecting: return localize('multiRemote.groupConnecting', "Connecting…");
			case RemoteHostState.Reconnecting: return localize('multiRemote.groupReconnecting', "Reconnecting…");
			case RemoteHostState.Failed: return localize('multiRemote.groupFailed', "Failed");
			case RemoteHostState.Disconnected: return localize('multiRemote.groupDisconnected', "Disconnected");
			default: return localize('multiRemote.groupNotConnected', "Not connected");
		}
	}

	private createDecorationsProvider(): IDecorationsProvider {
		return {
			label: localize('multiRemote.hostStatus', "Remote Host Status"),
			onDidChange: this._onDidChangeDecorations.event as Event<readonly URI[]>,
			provideDecorations: (resource: URI): IDecorationData | undefined => {
				if (resource.scheme === WORKSPACE_GROUP_SCHEME) {
					return this.provideGroupDecoration(resource);
				}
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
			await multiRemoteService.reconnect(resource.authority).catch(() => { });
		}
	}
}

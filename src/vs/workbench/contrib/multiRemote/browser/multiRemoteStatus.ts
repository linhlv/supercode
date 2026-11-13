/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputButton, IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IMultiRemoteService, IRemoteHostStatus, RemoteHostState } from '../../../services/remote/common/multiRemoteService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

interface IHostPickItem extends IQuickPickItem {
	readonly authority?: string;
	readonly addFolder?: boolean;
}

/** Shows how many remote hosts are connected in the status bar and offers per-host actions. */
export class MultiRemoteStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.multiRemoteStatus';

	private static readonly ENTRY_ID = 'status.multiRemote';
	private static readonly SHOW_HOSTS_COMMAND = 'multiRemote.showHosts';
	private static readonly ADD_SSH_FOLDER_COMMAND = 'remote-ssh.addFolderToWorkspace';

	private static readonly RECONNECT_BUTTON: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.refresh), tooltip: localize('multiRemote.reconnect', "Reconnect") };
	private static readonly DISCONNECT_BUTTON: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.debugDisconnect), tooltip: localize('multiRemote.disconnect', "Disconnect") };
	private static readonly TERMINAL_BUTTON: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.terminal), tooltip: localize('multiRemote.newTerminal', "New Terminal") };

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IMultiRemoteService private readonly multiRemoteService: IMultiRemoteService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILabelService private readonly labelService: ILabelService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super();

		if (!multiRemoteService.isEnabled) {
			return;
		}

		this._register(CommandsRegistry.registerCommand(MultiRemoteStatusContribution.SHOW_HOSTS_COMMAND, () => this.showHosts()));
		this._register(this.multiRemoteService.onDidChangeHostState(() => this.update()));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.update()));
		this.update();
	}

	private hostLabel(authority: string): string {
		return this.labelService.getHostLabel(Schemas.vscodeRemote, authority) || authority;
	}

	private hasRemoteRoots(): boolean {
		return this.contextService.getWorkspace().folders.some(folder => folder.uri.scheme === Schemas.vscodeRemote);
	}

	private update(): void {
		if (!this.hasRemoteRoots()) {
			this.entry.clear();
			return;
		}

		const hosts = this.multiRemoteService.getHosts();
		const connected = hosts.filter(host => host.state === RemoteHostState.Connected).length;
		const text = `$(remote) ${connected}/${hosts.length}`;
		const tooltip = hosts.map(host => this.describe(host)).join('\n') || localize('multiRemote.noHosts', "No remote hosts");
		const properties = {
			name: localize('multiRemote.statusName', "Remote Hosts"),
			text,
			ariaLabel: localize('multiRemote.statusAria', "{0} of {1} remote hosts connected", connected, hosts.length),
			tooltip,
			command: MultiRemoteStatusContribution.SHOW_HOSTS_COMMAND
		};
		if (this.entry.value) {
			this.entry.value.update(properties);
		} else {
			this.entry.value = this.statusbarService.addEntry(properties, MultiRemoteStatusContribution.ENTRY_ID, StatusbarAlignment.LEFT, 100);
		}
	}

	private describe(host: IRemoteHostStatus): string {
		return localize('multiRemote.hostState', "{0}: {1}", this.hostLabel(host.authority), this.stateLabel(host));
	}

	private stateLabel(host: IRemoteHostStatus): string {
		switch (host.state) {
			case RemoteHostState.Connected: return localize('multiRemote.stateConnected', "Connected");
			case RemoteHostState.Connecting: return localize('multiRemote.stateConnecting', "Connecting…");
			case RemoteHostState.Reconnecting: return localize('multiRemote.stateReconnecting', "Reconnecting…");
			case RemoteHostState.Disconnected: return localize('multiRemote.stateDisconnected', "Disconnected");
			case RemoteHostState.Failed: return host.error
				? localize('multiRemote.stateFailedWithError', "Failed ({0})", host.error)
				: localize('multiRemote.stateFailed', "Failed");
		}
	}

	private showHosts(): void {
		const store = new DisposableStore();
		const picker = store.add(this.quickInputService.createQuickPick<IHostPickItem>({ useSeparators: true }));
		picker.placeholder = localize('multiRemote.pickHost', "Remote Hosts");

		const items: (IHostPickItem | IQuickPickSeparator)[] = this.multiRemoteService.getHosts().map(host => ({
			label: this.hostLabel(host.authority),
			description: this.stateLabel(host),
			detail: host.authority,
			authority: host.authority,
			buttons: [MultiRemoteStatusContribution.RECONNECT_BUTTON, MultiRemoteStatusContribution.DISCONNECT_BUTTON, MultiRemoteStatusContribution.TERMINAL_BUTTON]
		}));
		items.push({ type: 'separator' });
		items.push({ label: localize('multiRemote.addSshFolder', "Add SSH Folder to Workspace…"), addFolder: true });
		picker.items = items;

		store.add(picker.onDidTriggerItemButton(({ item, button }) => {
			const authority = item.authority;
			if (!authority) {
				return;
			}
			picker.hide();
			switch (button) {
				case MultiRemoteStatusContribution.RECONNECT_BUTTON:
					this.multiRemoteService.connect(authority).catch(() => { /* failures are surfaced through the host state */ });
					break;
				case MultiRemoteStatusContribution.DISCONNECT_BUTTON:
					this.multiRemoteService.disconnect(authority).catch(error => this.notificationService.error(getErrorMessage(error)));
					break;
				case MultiRemoteStatusContribution.TERMINAL_BUTTON:
					this.commandService.executeCommand('workbench.action.terminal.newOnRemoteHost', authority).catch(error => this.notificationService.error(getErrorMessage(error)));
					break;
			}
		}));
		store.add(picker.onDidAccept(() => {
			const selected = picker.selectedItems[0];
			picker.hide();
			if (selected?.addFolder) {
				this.commandService.executeCommand(MultiRemoteStatusContribution.ADD_SSH_FOLDER_COMMAND).catch(error => this.notificationService.error(getErrorMessage(error)));
			}
		}));
		store.add(picker.onDidHide(() => store.dispose()));
		picker.show();
	}
}

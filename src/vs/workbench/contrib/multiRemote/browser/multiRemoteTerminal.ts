/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ITerminalBackendRegistry, TerminalExtensions } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { RemoteNameContext } from '../../../common/contextkeys.js';
import { IMultiRemoteService, RemoteHostState } from '../../../services/remote/common/multiRemoteService.js';
import { IRemoteAgentConnection } from '../../../services/remote/common/remoteAgentService.js';
import { RemoteTerminalBackend } from '../../terminal/browser/remoteTerminalBackend.js';
import { ITerminalInstanceService, ITerminalService } from '../../terminal/browser/terminal.js';
import { REMOTE_TERMINAL_CHANNEL_NAME, RemoteTerminalChannelClient } from '../../terminal/common/remote/remoteTerminalChannel.js';

/** Gives every connected additional host its own remote terminal backend. */
export class MultiRemoteTerminalContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.multiRemoteTerminal';

	/** Keyed by lowercased authority; remembers the connection each backend was built on. */
	private readonly _backends = this._register(new DisposableMap<string, { dispose(): void; handleHostUnavailable(message: string): number }>());
	private readonly _connections = new Map<string, IRemoteAgentConnection>();

	constructor(
		@IMultiRemoteService private readonly _multiRemoteService: IMultiRemoteService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@ILabelService private readonly _labelService: ILabelService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super();

		if (!this._multiRemoteService.isEnabled) {
			return;
		}

		this._register(this._multiRemoteService.onDidChangeHostState(status => {
			switch (status.state) {
				case RemoteHostState.Connected:
					this._ensureBackend(status.authority);
					break;
				case RemoteHostState.Failed:
				case RemoteHostState.Disconnected:
					this._endTerminals(status.authority);
					this._removeBackend(status.authority);
					break;
				// Reconnecting keeps the backend: the same persistent connection resumes live terminals.
			}
		}));
		for (const host of this._multiRemoteService.getHosts()) {
			if (host.state === RemoteHostState.Connected) {
				this._ensureBackend(host.authority);
			}
		}
	}

	private _ensureBackend(authority: string): void {
		const connected = this._multiRemoteService.getConnected(authority);
		if (!connected) {
			return;
		}
		const key = authority.toLowerCase();
		if (this._connections.get(key) === connected.connection) {
			return;
		}
		this._removeBackend(authority);

		const channel = this._instantiationService.createInstance(RemoteTerminalChannelClient, authority, connected.connection.getChannel(REMOTE_TERMINAL_CHANNEL_NAME));
		const backend = this._instantiationService.createInstance(RemoteTerminalBackend, authority, channel);
		const registry = Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend);
		registry.registerTerminalBackend(backend);
		this._connections.set(key, connected.connection);
		this._backends.set(key, {
			handleHostUnavailable: message => backend.handleHostUnavailable(message),
			dispose: () => { registry.unregisterTerminalBackend(authority); backend.dispose(); }
		});
		this._terminalInstanceService.didRegisterBackend(backend);
		backend.setReady();
	}

	/** Ends the terminals of a host that failed or was disconnected, so they do not freeze silently. */
	private _endTerminals(authority: string): void {
		const backend = this._backends.get(authority.toLowerCase());
		if (!backend) {
			return;
		}
		const host = this._labelService.getHostLabel(Schemas.vscodeRemote, authority) || authority;
		const closed = backend.handleHostUnavailable(localize('multiRemote.hostLost', "The connection to {0} was lost.", host));
		if (closed > 0) {
			this._notificationService.warn(localize('multiRemote.terminalsClosed', "{0} is unavailable. Its terminals were closed.", host));
		}
	}

	private _removeBackend(authority: string): void {
		const key = authority.toLowerCase();
		this._connections.delete(key);
		this._backends.deleteAndDispose(key);
	}
}

/** Opens a terminal on a connected additional host, picked by the user or passed as `authority`. */
export class NewTerminalOnRemoteHostAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.terminal.newOnRemoteHost',
			title: localize2('newTerminalOnRemoteHost', "New Terminal on Remote Host…"),
			f1: true,
			category: localize2('terminalCategory', "Terminal"),
			precondition: RemoteNameContext.isEqualTo(''),
			menu: { id: MenuId.TerminalNewDropdownContext, group: '3_remote', when: RemoteNameContext.isEqualTo('') }
		});
	}

	async run(accessor: ServicesAccessor, authorityArg?: string): Promise<void> {
		const multiRemoteService = accessor.get(IMultiRemoteService);
		const quickInputService = accessor.get(IQuickInputService);
		const labelService = accessor.get(ILabelService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const terminalService = accessor.get(ITerminalService);

		let authority = typeof authorityArg === 'string' ? authorityArg : undefined;
		if (authority !== undefined && !multiRemoteService.isEnabled) {
			return;
		}
		if (authority === undefined) {
			const hosts = multiRemoteService.getHosts().filter(host => host.state === RemoteHostState.Connected);
			if (!multiRemoteService.isEnabled || hosts.length === 0) {
				await quickInputService.pick([], { placeHolder: localize('noConnectedHosts', "No remote hosts are connected") });
				return;
			}

			const items: (IQuickPickItem & { authority: string })[] = hosts.map(host => ({
				label: labelService.getHostLabel(Schemas.vscodeRemote, host.authority) || host.authority,
				description: host.authority,
				authority: host.authority
			}));
			const picked = await quickInputService.pick(items, { placeHolder: localize('pickRemoteHost', "Select the remote host to open a terminal on") });
			if (!picked) {
				return;
			}
			authority = picked.authority;
		}

		const root = workspaceContextService.getWorkspace().folders
			.find(folder => folder.uri.scheme === Schemas.vscodeRemote && folder.uri.authority.toLowerCase() === authority.toLowerCase());
		let cwd: URI | undefined = root?.uri;
		if (!cwd) {
			const environment = await multiRemoteService.getEnvironment(authority);
			if (!environment) {
				return;
			}
			cwd = URI.from({ scheme: Schemas.vscodeRemote, authority, path: environment.userHome.path });
		}
		const instance = await terminalService.createTerminal({ config: { cwd } });
		await terminalService.revealActiveTerminal();
		instance.focus();
	}
}

registerAction2(NewTerminalOnRemoteHostAction);

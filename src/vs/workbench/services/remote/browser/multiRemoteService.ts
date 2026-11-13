/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { CancellationError, getErrorMessage } from '../../../../base/common/errors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRemoteAgentEnvironment } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteSocketFactoryService } from '../../../../platform/remote/common/remoteSocketFactoryService.js';
import { ISignService } from '../../../../platform/sign/common/sign.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { RemoteAgentConnection } from '../common/abstractRemoteAgentService.js';
import { RemoteExtensionEnvironmentChannelClient } from '../common/remoteAgentEnvironmentChannel.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../common/remoteAgentService.js';
import { IMultiRemoteService, IRemoteHostConnection, IRemoteHostStatus, RemoteHostState } from '../common/multiRemoteService.js';

interface IHostEntry {
	status: IRemoteHostStatus;
	connectPromise?: Promise<IRemoteHostConnection>;
	host?: IRemoteHostConnection;
	readonly disposables: DisposableStore;
}

export class MultiRemoteService extends Disposable implements IMultiRemoteService {

	declare readonly _serviceBrand: undefined;

	private readonly _hosts = new Map<string, IHostEntry>();

	private readonly _onDidChangeHostState = this._register(new Emitter<IRemoteHostStatus>());
	readonly onDidChangeHostState: Event<IRemoteHostStatus> = this._onDidChangeHostState.event;

	constructor(
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IRemoteAuthorityResolverService private readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IRemoteSocketFactoryService private readonly _remoteSocketFactoryService: IRemoteSocketFactoryService,
		@ISignService private readonly _signService: ISignService,
		@IProductService private readonly _productService: IProductService,
		@IUserDataProfileService private readonly _userDataProfileService: IUserDataProfileService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
	}

	get isEnabled(): boolean {
		return !this._environmentService.remoteAuthority && !isWeb;
	}

	getHosts(): readonly IRemoteHostStatus[] {
		return [...this._hosts.values()].map(entry => entry.status);
	}

	getState(authority: string): RemoteHostState | undefined {
		return this._hosts.get(authority.toLowerCase())?.status.state;
	}

	getConnected(authority: string): IRemoteHostConnection | undefined {
		const entry = this._hosts.get(authority.toLowerCase());
		return entry?.status.state === RemoteHostState.Connected ? entry.host : undefined;
	}

	connect(authority: string): Promise<IRemoteHostConnection> {
		if (!this.isEnabled) {
			return Promise.reject(new Error(`Connecting to additional remote hosts is not supported in this window: ${authority}`));
		}
		const existing = this._hosts.get(authority.toLowerCase());
		if (existing) {
			if (existing.connectPromise) {
				return existing.connectPromise;
			}
			if (existing.host && (existing.status.state === RemoteHostState.Connected || existing.status.state === RemoteHostState.Reconnecting)) {
				return Promise.resolve(existing.host);
			}
			existing.disposables.dispose();
		}

		const entry: IHostEntry = { status: { authority, state: RemoteHostState.Connecting }, disposables: new DisposableStore() };
		this._hosts.set(authority.toLowerCase(), entry);
		this._setState(entry, RemoteHostState.Connecting);
		entry.connectPromise = this._connect(entry, authority);
		return entry.connectPromise;
	}

	private async _connect(entry: IHostEntry, authority: string): Promise<IRemoteHostConnection> {
		try {
			await this._extensionService.resolveRemoteAuthority(authority);
			this._throwIfCancelled(entry, authority);
			const connection = this._createConnection(authority);
			entry.disposables.add(connection);
			this._monitor(entry, connection, authority);
			const environment = await this._fetchEnvironment(connection);
			this._throwIfCancelled(entry, authority);
			if (typeof environment.reconnectionGraceTime === 'number') {
				connection.updateGraceTime(environment.reconnectionGraceTime);
			}
			entry.host = { authority, connection, environment };
			this._setState(entry, RemoteHostState.Connected);
			return entry.host;
		} catch (error) {
			if (this._hosts.get(authority.toLowerCase()) === entry && entry.status.state !== RemoteHostState.Disconnected) {
				entry.disposables.dispose();
				entry.host = undefined;
				this._setState(entry, RemoteHostState.Failed, getErrorMessage(error));
			}
			throw error;
		} finally {
			if (entry.status.state !== RemoteHostState.Disconnected) {
				entry.connectPromise = undefined;
			}
		}
	}

	/** Throws when the entry was abandoned by `disconnect` or service disposal while connecting. */
	private _throwIfCancelled(entry: IHostEntry, authority: string): void {
		if (this._hosts.get(authority.toLowerCase()) !== entry || entry.disposables.isDisposed) {
			throw new CancellationError();
		}
	}

	private _monitor(entry: IHostEntry, connection: IRemoteAgentConnection, authority: string): void {
		entry.disposables.add(connection.onDidStateChange(e => {
			if (this._hosts.get(authority.toLowerCase()) !== entry) {
				return;
			}
			switch (e.type) {
				case PersistentConnectionEventType.ConnectionLost:
					this._remoteAuthorityResolverService._clearResolvedAuthority(authority);
					this._setState(entry, RemoteHostState.Reconnecting);
					break;
				case PersistentConnectionEventType.ConnectionGain:
					if (entry.host) {
						this._setState(entry, RemoteHostState.Connected);
					}
					break;
				case PersistentConnectionEventType.ReconnectionPermanentFailure:
					entry.disposables.dispose();
					entry.host = undefined;
					this._setState(entry, RemoteHostState.Failed);
					break;
			}
		}));
		entry.disposables.add(connection.onReconnecting(() => {
			this._extensionService.resolveRemoteAuthority(authority).catch(error => this._logService.error(`[MultiRemoteService] Failed to re-resolve ${authority}`, error));
		}));
	}

	async disconnect(authority: string): Promise<void> {
		const entry = this._hosts.get(authority.toLowerCase());
		if (!entry) {
			return;
		}
		if (entry.connectPromise) {
			// Abandon the in-flight attempt: it rejects with a cancellation error and a later connect starts fresh.
			entry.connectPromise = undefined;
			entry.host = undefined;
			this._setState(entry, RemoteHostState.Disconnected);
			entry.disposables.dispose();
			return;
		}
		const connection = entry.host?.connection;
		entry.host = undefined;
		this._setState(entry, RemoteHostState.Disconnected);
		try {
			await connection?.end();
		} catch (error) {
			this._logService.warn(`[MultiRemoteService] Error while ending connection to ${authority}`, error);
		} finally {
			entry.disposables.dispose();
		}
	}

	isSecondary(authority: string | undefined): boolean {
		return this.isEnabled && authority !== undefined && authority.toLowerCase() !== this._environmentService.remoteAuthority?.toLowerCase();
	}

	async getEnvironment(authority: string | undefined): Promise<IRemoteAgentEnvironment | null> {
		if (!this.isSecondary(authority)) {
			return this._remoteAgentService.getEnvironment();
		}
		return (await this.connect(authority!)).environment;
	}

	/** Test seam: creates the (lazy) connection object for a host. A host failing must not fail the other hosts. */
	protected _createConnection(authority: string): IRemoteAgentConnection {
		return new RemoteAgentConnection(authority, this._productService.commit, this._productService.quality, this._remoteSocketFactoryService, this._remoteAuthorityResolverService, this._signService, this._logService, /* failureIsFatal */ false);
	}

	/** Test seam: fetches the remote environment over the given connection. */
	protected async _fetchEnvironment(connection: IRemoteAgentConnection): Promise<IRemoteAgentEnvironment> {
		const profile = this._userDataProfileService.currentProfile;
		const environment = await RemoteExtensionEnvironmentChannelClient.getEnvironmentData(connection.getChannel('remoteextensionsenvironment'), connection.remoteAuthority, profile.isDefault ? undefined : profile.id);
		this._remoteAuthorityResolverService._setAuthorityConnectionToken(connection.remoteAuthority, environment.connectionToken);
		return environment;
	}

	private _setState(entry: IHostEntry, state: RemoteHostState, error?: string): void {
		entry.status = error === undefined ? { authority: entry.status.authority, state } : { authority: entry.status.authority, state, error };
		this._onDidChangeHostState.fire(entry.status);
	}

	override dispose(): void {
		for (const entry of this._hosts.values()) {
			entry.disposables.dispose();
		}
		this._hosts.clear();
		super.dispose();
	}
}

registerSingleton(IMultiRemoteService, MultiRemoteService, InstantiationType.Delayed);

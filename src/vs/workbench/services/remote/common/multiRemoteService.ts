/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IRemoteAgentEnvironment } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IRemoteAgentConnection } from './remoteAgentService.js';

export const IMultiRemoteService = createDecorator<IMultiRemoteService>('multiRemoteService');

/** Lifecycle state of the connection to one remote host. */
export const enum RemoteHostState {
	Connecting = 'connecting',
	Connected = 'connected',
	Reconnecting = 'reconnecting',
	Disconnected = 'disconnected',
	Failed = 'failed'
}

/** Current state of a remote host, with the failure message when {@link RemoteHostState.Failed}. */
export interface IRemoteHostStatus {
	readonly authority: string;
	readonly state: RemoteHostState;
	readonly error?: string;
}

/** A live connection to a remote host together with its environment. */
export interface IRemoteHostConnection {
	readonly authority: string;
	readonly connection: IRemoteAgentConnection;
	readonly environment: IRemoteAgentEnvironment;
}

/** Manages one management connection per remote host, in addition to the (optional) primary remote. */
export interface IMultiRemoteService {
	readonly _serviceBrand: undefined;

	/** True in a local (non-remote, non-web) window, where additional hosts can be connected. */
	readonly isEnabled: boolean;

	readonly onDidChangeHostState: Event<IRemoteHostStatus>;

	getHosts(): readonly IRemoteHostStatus[];
	getState(authority: string): RemoteHostState | undefined;
	getConnected(authority: string): IRemoteHostConnection | undefined;

	/** Idempotent; concurrent calls share one connection attempt. Starts a fresh connection when failed or disconnected. */
	connect(authority: string): Promise<IRemoteHostConnection>;
	disconnect(authority: string): Promise<void>;

	/** True iff enabled, the authority is defined and differs from the primary authority. */
	isSecondary(authority: string | undefined): boolean;

	/** The primary environment for undefined/primary authorities; otherwise the connected host's environment (connecting if needed). */
	getEnvironment(authority: string | undefined): Promise<IRemoteAgentEnvironment | null>;
}

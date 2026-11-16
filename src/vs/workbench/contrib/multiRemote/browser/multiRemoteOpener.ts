/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IOpener, IOpenerService, OpenExternalOptions, OpenInternalOptions } from '../../../../platform/opener/common/opener.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { getWorkbenchContribution, IWorkbenchContribution } from '../../../common/contributions.js';
import { IMultiRemoteService, RemoteHostState } from '../../../services/remote/common/multiRemoteService.js';
import { WorkbenchOpenerContribution } from '../../opener/browser/opener.contribution.js';
import { IHostDemandService } from './hostDemand.js';

/**
 * Connects the host of a remote resource that only a collapsed workspace group uses before
 * the other openers look at the resource, so that opening a file of a collapsed group (links,
 * `vscode.open`) connects its host on demand. Never handles the resource itself.
 */
export class MultiRemoteOpener implements IOpener {

	constructor(
		private readonly multiRemoteService: IMultiRemoteService,
		private readonly hostDemandService: IHostDemandService,
		private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService
	) { }

	async open(resource: URI | string, options?: OpenInternalOptions | OpenExternalOptions): Promise<boolean> {
		if (options && 'openExternal' in options && options.openExternal) {
			return false;
		}
		const uri = typeof resource === 'string' ? URI.parse(resource) : resource;
		const authority = uri.scheme === Schemas.vscodeRemote ? uri.authority : undefined;
		if (
			authority &&
			this.workspaceTrustManagementService.isWorkspaceTrusted() &&
			this.hostDemandService.hasRoots(authority) &&
			!this.hostDemandService.isWanted(authority) &&
			this.multiRemoteService.getState(authority) !== RemoteHostState.Connected
		) {
			// A failure is surfaced through the host state and by the opener that then reads the resource
			await this.multiRemoteService.connect(authority).catch(() => { });
		}
		return false;
	}
}

/** Registers `MultiRemoteOpener` ahead of the workbench opener, which reads the resource first. */
export class MultiRemoteOpenerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.multiRemoteOpener';

	constructor(
		@IOpenerService openerService: IOpenerService,
		@IMultiRemoteService multiRemoteService: IMultiRemoteService,
		@IHostDemandService hostDemandService: IHostDemandService,
		@IWorkspaceTrustManagementService workspaceTrustManagementService: IWorkspaceTrustManagementService
	) {
		super();

		if (!multiRemoteService.isEnabled) {
			return;
		}
		// Openers registered later are asked first: make sure the workbench opener is registered before this one
		try {
			getWorkbenchContribution(WorkbenchOpenerContribution.ID);
		} catch {
			// not part of this workbench
		}
		this._register(openerService.registerOpener(new MultiRemoteOpener(multiRemoteService, hostDemandService, workspaceTrustManagementService)));
	}
}

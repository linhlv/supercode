/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { RemoteFileSystemRouter } from '../../../services/remote/browser/remoteFileSystemRouter.js';
import { IMultiRemoteService } from '../../../services/remote/common/multiRemoteService.js';
import { AddRemoteFolderToWorkspaceAction } from './multiRemoteActions.js';
import { IHostDemandService } from './hostDemand.js';
import { MultiRemoteStatusContribution } from './multiRemoteStatus.js';
import { MultiRemoteTerminalContribution } from './multiRemoteTerminal.js';
import { MultiRemoteWorkspaceContribution, ReconnectHostAction } from './multiRemoteWorkspace.js';

/** Registers the host-routing `vscode-remote` file system provider in local windows. */
export class MultiRemoteFileSystemContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.multiRemoteFileSystem';

	constructor(
		@IMultiRemoteService multiRemoteService: IMultiRemoteService,
		@IFileService fileService: IFileService,
		@ILabelService labelService: ILabelService,
		@IWorkspaceTrustManagementService workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IHostDemandService hostDemandService: IHostDemandService
	) {
		super();

		if (multiRemoteService.isEnabled) {
			const router = this._register(new RemoteFileSystemRouter(
				multiRemoteService,
				undefined,
				authority => labelService.getHostLabel(Schemas.vscodeRemote, authority),
				// Only wanted hosts of a trusted workspace connect on their own; everything else needs a user action
				authority => workspaceTrustManagementService.isWorkspaceTrusted() && hostDemandService.isWanted(authority)
			));
			this._register(fileService.registerProvider(Schemas.vscodeRemote, router));
		}
	}
}

registerWorkbenchContribution2(MultiRemoteFileSystemContribution.ID, MultiRemoteFileSystemContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(MultiRemoteTerminalContribution.ID, MultiRemoteTerminalContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(MultiRemoteWorkspaceContribution.ID, MultiRemoteWorkspaceContribution, WorkbenchPhase.BlockStartup);
registerAction2(ReconnectHostAction);
registerWorkbenchContribution2(MultiRemoteStatusContribution.ID, MultiRemoteStatusContribution, WorkbenchPhase.AfterRestored);
registerAction2(AddRemoteFolderToWorkspaceAction);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'multiRemote',
	order: 100,
	title: localize('multiRemote.configurationTitle', "Remote Hosts"),
	type: 'object',
	properties: {
		'multiRemote.idleDisconnectDelay': {
			type: 'number',
			default: 300,
			minimum: 0,
			description: localize('multiRemote.idleDisconnectDelay', "Seconds an SSH host stays connected after only collapsed workspace groups use it.")
		}
	}
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { RemoteFileSystemRouter } from '../../../services/remote/browser/remoteFileSystemRouter.js';
import { IMultiRemoteService } from '../../../services/remote/common/multiRemoteService.js';
import { MultiRemoteTerminalContribution } from './multiRemoteTerminal.js';

/** Registers the host-routing `vscode-remote` file system provider in local windows. */
export class MultiRemoteFileSystemContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.multiRemoteFileSystem';

	constructor(
		@IMultiRemoteService multiRemoteService: IMultiRemoteService,
		@IFileService fileService: IFileService,
		@ILabelService labelService: ILabelService
	) {
		super();

		if (multiRemoteService.isEnabled) {
			const router = this._register(new RemoteFileSystemRouter(multiRemoteService, undefined, authority => labelService.getHostLabel(Schemas.vscodeRemote, authority)));
			this._register(fileService.registerProvider(Schemas.vscodeRemote, router));
		}
	}
}

registerWorkbenchContribution2(MultiRemoteFileSystemContribution.ID, MultiRemoteFileSystemContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(MultiRemoteTerminalContribution.ID, MultiRemoteTerminalContribution, WorkbenchPhase.AfterRestored);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { RemoteNameContext } from '../../../common/contextkeys.js';
import { IMultiRemoteService, IRemoteHostConnection } from '../../../services/remote/common/multiRemoteService.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';

/**
 * Connects to a remote host, lets the user pick folders on it and adds them to the workspace.
 * Called with the host's `authority` (for example by the SSH extension).
 */
export class AddRemoteFolderToWorkspaceAction extends Action2 {

	static readonly ID = 'workbench.action.addRemoteFolderToWorkspace';

	constructor() {
		super({
			id: AddRemoteFolderToWorkspaceAction.ID,
			title: localize2('multiRemote.addRemoteFolder', "Add Remote Folder to Workspace"),
			f1: false,
			precondition: RemoteNameContext.isEqualTo('')
		});
	}

	override async run(accessor: ServicesAccessor, authority?: string): Promise<void> {
		const multiRemoteService = accessor.get(IMultiRemoteService);
		const progressService = accessor.get(IProgressService);
		const fileDialogService = accessor.get(IFileDialogService);
		const workspaceEditingService = accessor.get(IWorkspaceEditingService);
		const notificationService = accessor.get(INotificationService);
		const labelService = accessor.get(ILabelService);

		if (!authority) {
			return;
		}
		const host = labelService.getHostLabel(Schemas.vscodeRemote, authority) || authority;

		let connected: IRemoteHostConnection;
		try {
			connected = await progressService.withProgress(
				{ location: ProgressLocation.Notification, title: localize('multiRemote.connectingTo', "Connecting to {0}…", host) },
				() => multiRemoteService.connect(authority)
			);
		} catch (error) {
			notificationService.error(localize('multiRemote.connectFailed', "Could not connect to {0}: {1}", host, getErrorMessage(error)));
			return;
		}

		const picked = await fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: true,
			defaultUri: URI.from({ scheme: Schemas.vscodeRemote, authority, path: connected.environment.userHome.path }),
			availableFileSystems: [Schemas.vscodeRemote]
		});
		if (picked && picked.length > 0) {
			// Name each root after its host, so that the same path on two hosts can be told apart
			await workspaceEditingService.addFolders(picked.map(uri => ({ uri, name: localize('multiRemote.rootName', "{0} [{1}]", basename(uri), host) })));
		}
	}
}

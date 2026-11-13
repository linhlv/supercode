/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import SSHDestination from './ssh/sshDestination';

/**
 * The workspace suffix of an SSH host's resource labels: `SSH: [user@]host[:port]`, with the user
 * and port only when the destination names them, so that `alice@box` and `bob@box` read differently.
 */
export function hostLabelSuffix(destination: SSHDestination): string {
	return `SSH: ${destination.toString()}`;
}

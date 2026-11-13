/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Whether `authority` is the remote authority of the window itself (a window opened on that host),
 * as opposed to an additional host of a local window. Only a failed resolve of the window's own
 * authority may interrupt the user (output panel, modal with "Retry"/"Close Remote", both of which
 * act on the whole window); an additional host fails in the background.
 */
export function isWindowAuthority(windowRemoteAuthority: string | undefined, authority: string): boolean {
	return !!windowRemoteAuthority && windowRemoteAuthority.toLowerCase() === authority.toLowerCase();
}

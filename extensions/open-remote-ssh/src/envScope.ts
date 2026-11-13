/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Returns the indexes of the workspace folders that belong to the remote `authority`
 * (case-insensitive). Terminal environment set for one host (e.g. its forwarded
 * `SSH_AUTH_SOCK`) is scoped to exactly these folders, so it never leaks into terminals
 * of other hosts.
 */
export function selectFoldersOfAuthority(folders: readonly { readonly uri: { readonly authority: string } }[] | undefined, authority: string): number[] {
	const wanted = authority.toLowerCase();
	const result: number[] = [];
	(folders ?? []).forEach((folder, index) => {
		if (folder.uri.authority.toLowerCase() === wanted) {
			result.push(index);
		}
	});
	return result;
}

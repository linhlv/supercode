/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import SSHDestination from '../ssh/sshDestination';

/**
 * Builds the arguments of the `ssh` process that carries one host's connection.
 *
 * The connection is established without any user interaction: `BatchMode=yes`
 * makes ssh fail instead of asking for a password, passphrase or host-key
 * confirmation, and `ConnectTimeout=15` bounds the time an unreachable host can
 * block the window. `extra` (e.g. `-D <port>`, `-F <file>`) goes before the destination.
 */
export function buildNativeSshArgs(dest: SSHDestination, extra: string[]): string[] {
	const args: string[] = ['-v', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...extra];
	if (dest.port) {
		args.push('-p', String(dest.port));
	}
	if (dest.user) {
		args.push('-l', dest.user);
	}
	args.push(dest.hostname);
	return args;
}

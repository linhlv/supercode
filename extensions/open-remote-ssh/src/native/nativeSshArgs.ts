/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
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

/**
 * Environment of the helper process that owns one host's `ssh` process. ssh must never
 * ask for anything through an askpass program (also for ProxyJump/ProxyCommand children,
 * which inherit this environment), so `SSH_ASKPASS` is not set and askpass use is disabled.
 */
export function buildNativeServerEnv(display: string | undefined): Record<string, string> {
	return {
		DISPLAY: display || '1',
		ELECTRON_RUN_AS_NODE: '1',
		SSH_ASKPASS_REQUIRE: 'never',
	};
}

/**
 * Filesystem-safe registry key of a destination. Derived from the full destination
 * (user, host and port), so `alice@box` and `bob@box:2222` never share a running server.
 */
export function nativeRegistryKey(dest: SSHDestination): string {
	return createHash('sha256').update(dest.toEncodedString()).digest('hex').substring(0, 24);
}

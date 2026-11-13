/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';

/**
 * Localizes `message` (like `localize`) through `vscode.l10n.t` when running inside VS Code and falls back to
 * plain `{n}` substitution otherwise (the unit tests run in plain node, without `vscode`).
 */
function t(message: string, ...args: string[]): string {
	try {
		const vscode = require('vscode') as typeof import('vscode');
		return vscode.l10n.t(message, ...args);
	} catch {
		return message.replace(/\{(\d+)\}/g, (match, index: string) => args[Number(index)] ?? match);
	}
}

/** What `uname -s`, `uname -m` and the libc probe report about a remote host. */
export interface RemoteServerPlatform {
	kernel: string;
	machine: string;
	isMusl: boolean;
}

/**
 * Returns the basename of the server tarball built by `scripts/supercode/build.sh` for a remote platform.
 * Throws a localized error for 32-bit ARM and for any platform without a server build.
 */
export function pickServerPackage(p: RemoteServerPlatform): string {
	if (p.kernel === 'Linux') {
		switch (p.machine) {
			case 'x86_64':
				return p.isMusl ? 'vscode-reh-linux-alpine.tar.gz' : 'vscode-reh-linux-x64.tar.gz';
			case 'aarch64':
			case 'arm64':
				return p.isMusl ? 'vscode-reh-alpine-arm64.tar.gz' : 'vscode-reh-linux-arm64.tar.gz';
			case 'armv7l':
			case 'armv8l':
				throw new Error(t('32-bit ARM isn\'t supported'));
		}
	}
	throw new Error(t('Unsupported platform {0} {1}', p.kernel, p.machine));
}

/** Directory the server of one build is unpacked into; keyed by the commit so builds never share files. */
export function serverInstallDir(dataFolder: string, commit: string): string {
	return `${dataFolder}/bin/${commit}`;
}

/** Folder on the Mac that `scripts/supercode/build.sh` writes the server tarballs of `commit` to. */
export function localServerPackageDir(commit: string, home: string = os.homedir()): string {
	return path.join(home, '.supercode', 'server-packages', commit);
}

/**
 * Returns the path of the local tarball, or throws when it was not built. There is deliberately
 * no download fallback: the fork's server is not published anywhere.
 */
export async function requireLocalServerPackage(dir: string, basename: string, platformLabel: string): Promise<string> {
	const file = path.join(dir, basename);
	if (!await fs.promises.access(file).then(() => true, () => false)) {
		throw new Error(t('No server package for {0} in {1}. Run scripts/supercode/build.sh.', platformLabel, dir));
	}
	return file;
}

/** Remote location of the uploaded tarball; `server-setup.sh` extracts it from here. */
export function remoteTarballPath(dataFolder: string, commit: string, basename: string): string {
	return `${dataFolder}/${commit}-${basename}`;
}

/**
 * Remote command that stores stdin as the tarball. It writes a `.part` file first and renames it, so an
 * interrupted upload is never mistaken for a complete package. `dataFolder` may start with `$HOME`, which the
 * remote shell expands, so it must not contain characters that could end the double quoted string.
 */
export function buildUploadCommand(dataFolder: string, commit: string, basename: string): string {
	if (/["`\\\n\r]/.test(dataFolder)) {
		throw new Error(t('Invalid server install path: {0}', dataFolder));
	}
	const target = remoteTarballPath(dataFolder, commit, basename);
	const script = `mkdir -p "${dataFolder}" && cat > "${target}.part" && mv -f "${target}.part" "${target}"`;
	return `sh -c '${script.replace(/'/g, `'\\''`)}'`;
}

/** Drops `-D <port>` (and the verbose flag) so a second ssh process does not bind the session's SOCKS port. */
export function stripForwardingArgs(sshArgs: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < sshArgs.length; i++) {
		if (sshArgs[i] === '-D') {
			i++;
		} else if (sshArgs[i] !== '-v') {
			result.push(sshArgs[i]);
		}
	}
	return result;
}

export interface UploadServerPackageOptions {
	sshExecutable: string;
	/** The session's ssh arguments (`buildNativeSshArgs`, including `BatchMode=yes`). */
	sshArgs: string[];
	localFile: string;
	dataFolder: string;
	commit: string;
	basename: string;
}

/**
 * Streams the local tarball to the remote host through the system `ssh` (non-interactive, same
 * destination and options as the session). The file is piped, never read into memory.
 */
export async function uploadServerPackage(o: UploadServerPackageOptions): Promise<void> {
	const args = [...stripForwardingArgs(o.sshArgs), buildUploadCommand(o.dataFolder, o.commit, o.basename)];
	const child = cp.spawn(o.sshExecutable, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });

	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	exited.catch(() => undefined); // observed below; keeps an early spawn error from being unhandled

	try {
		await pipeline(fs.createReadStream(o.localFile), child.stdin);
	} catch (error) {
		// ssh exiting early (auth failure, no space) surfaces as EPIPE; report ssh's own reason.
		child.kill();
		const spawnError = await exited.then(() => undefined, (e: unknown) => e);
		const reason = spawnError ?? error;
		throw new Error(t('Uploading the server package failed: {0}', stderr.trim() || (reason instanceof Error ? reason.message : String(reason))));
	}

	const code = await exited;
	if (code !== 0) {
		throw new Error(t('Uploading the server package failed: {0}', stderr.trim() || `ssh exited with code ${code}`));
	}
}

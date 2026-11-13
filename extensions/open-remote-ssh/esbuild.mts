/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

/**
 * Static files the extension reads from its install folder at runtime
 * (`<extensionPath>/dist/...`), copied next to the bundles.
 */
const staticFiles: [from: string, to: string][] = [
	['scripts/server-setup.sh', 'scripts'],
	['scripts/server-setup.ps1', 'scripts'],
	['native/askpass/askpass.sh', 'native'],
	['native/askpass/askpass.ps1', 'native'],
];

function copyStaticFiles(outdir: string): void {
	for (const [from, toDir] of staticFiles) {
		const target = path.join(outdir, toDir);
		fs.mkdirSync(target, { recursive: true });
		const destination = path.join(target, path.basename(from));
		fs.copyFileSync(path.join(srcDir, from), destination);
		fs.chmodSync(destination, 0o755);
	}
}

run({
	platform: 'node',
	entryPoints: {
		'extension': path.join(srcDir, 'extension.ts'),
		'native/askpass-node': path.join(srcDir, 'native', 'askpass', 'askpass-node.ts'),
		'native/nativeSshServer': path.join(srcDir, 'native', 'nativeSshServer.ts'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		// Optional native add-ons of ssh2; it falls back to pure JS without them.
		external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node', 'bufferutil', 'utf-8-validate'],
	},
}, process.argv, copyStaticFiles);

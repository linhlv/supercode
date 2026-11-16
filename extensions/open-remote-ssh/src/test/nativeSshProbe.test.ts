/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as net from 'net';
import socks from 'simple-socks';
import { isRemoteServerReachable } from '../native/nativeSshProbe';

function listen(server: net.Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
	});
}

function close(server: net.Server): Promise<void> {
	return new Promise(resolve => server.close(() => resolve()));
}

suite('isRemoteServerReachable', () => {

	test('tells a live remote server from one that has exited', async () => {
		// The SOCKS proxy stands in for `ssh -D`; the TCP servers for the remote VS Code server.
		const proxy = socks.createServer();
		const live = net.createServer(socket => socket.end());
		const exited = net.createServer();
		try {
			const socksPort = await listen(proxy);
			const livePort = await listen(live);
			const exitedPort = await listen(exited);
			await close(exited);

			const result = {
				live: await isRemoteServerReachable(socksPort, livePort, 2_000),
				exited: await isRemoteServerReachable(socksPort, exitedPort, 2_000),
			};

			assert.deepStrictEqual(result, { live: true, exited: false });
		} finally {
			await close(live);
			proxy.close();
		}
	});
});

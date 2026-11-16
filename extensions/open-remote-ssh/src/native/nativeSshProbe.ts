/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SocksClient } from 'socks';

/**
 * Whether the remote VS Code server answers on `remotePort` through the SOCKS proxy of a running
 * `ssh -D` helper. A healthy helper whose remote server has exited must not be adopted: its cached
 * port refuses every connection, and only a fresh helper re-runs the setup that restarts the server.
 */
export async function isRemoteServerReachable(socksPort: number, remotePort: number, timeoutMs: number): Promise<boolean> {
    try {
        const { socket } = await SocksClient.createConnection({
            proxy: { host: '127.0.0.1', port: socksPort, type: 5 },
            command: 'connect',
            destination: { host: '127.0.0.1', port: remotePort },
            timeout: timeoutMs,
        });
        socket.destroy();
        return true;
    } catch {
        return false;
    }
}

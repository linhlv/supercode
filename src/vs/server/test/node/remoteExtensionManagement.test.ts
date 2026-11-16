/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ISocket, PersistentProtocol, SocketCloseEvent, SocketDiagnosticsEventType } from '../../../base/parts/ipc/common/ipc.net.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { ManagementConnection } from '../../node/remoteExtensionManagement.js';
import { ServerLifetimeService } from '../../node/serverLifetimeService.js';

class TestSocket implements ISocket {
	private readonly _onData = new Emitter<VSBuffer>();
	readonly onData: Event<VSBuffer> = this._onData.event;
	private readonly _onClose = new Emitter<SocketCloseEvent>();
	readonly onClose: Event<SocketCloseEvent> = this._onClose.event;
	private readonly _onEnd = new Emitter<void>();
	readonly onEnd: Event<void> = this._onEnd.event;

	write(_buffer: VSBuffer): void { }
	end(): void { }
	async drain(): Promise<void> { }
	traceSocketEvent(_type: SocketDiagnosticsEventType, _data?: unknown): void { }
	dispose(): void {
		this._onData.dispose();
		this._onClose.dispose();
		this._onEnd.dispose();
	}
}

suite('ManagementConnection', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the server alive until the client disconnects', () => {
		// A window whose host runs no extension host (an additional Supercode host) only has a
		// management connection; the server must not auto-shutdown while it is connected.
		const lifetime = ds.add(new ServerLifetimeService({}, () => undefined as never, new NullLogService()));
		const socket = ds.add(new TestSocket());
		const protocol = new PersistentProtocol({ socket, sendKeepAlive: false });
		new ManagementConnection(new NullLogService(), 'token-1', '127.0.0.1', protocol, 60_000, lifetime);

		const whileConnected = lifetime.hasActiveConsumers;
		protocol.acceptDisconnect();

		assert.deepStrictEqual({ whileConnected, afterDisconnect: lifetime.hasActiveConsumers }, { whileConnected: true, afterDisconnect: false });
	});
});

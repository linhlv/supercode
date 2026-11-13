/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { SessionRegistry } from '../sessionRegistry';

class FakeSession {
	disposed = 0;
	dispose(): void {
		this.disposed++;
	}
}

suite('SessionRegistry', () => {

	test('keeps independent sessions per host', () => {
		const registry = new SessionRegistry<FakeSession>();
		let created = 0;
		const create = () => {
			created++;
			return new FakeSession();
		};

		const a = registry.getOrCreate('ssh-remote+a', create);
		const b = registry.getOrCreate('ssh-remote+b', create);
		const aAgain = registry.getOrCreate('SSH-REMOTE+A', create);

		assert.deepStrictEqual({ created, distinct: a !== b, sameA: a === aAgain }, { created: 2, distinct: true, sameA: true });
	});

	test('disposing one session leaves the other', () => {
		const registry = new SessionRegistry<FakeSession>();
		const a = registry.getOrCreate('ssh-remote+a', () => new FakeSession());
		const b = registry.getOrCreate('ssh-remote+b', () => new FakeSession());

		registry.delete('ssh-remote+a');

		assert.deepStrictEqual(
			{ aDisposed: a.disposed, bDisposed: b.disposed, aGone: registry.get('ssh-remote+a') === undefined, bKept: registry.get('ssh-remote+b') === b },
			{ aDisposed: 1, bDisposed: 0, aGone: true, bKept: true });
	});

	test('dispose disposes every session', () => {
		const registry = new SessionRegistry<FakeSession>();
		const a = registry.getOrCreate('ssh-remote+a', () => new FakeSession());
		const b = registry.getOrCreate('ssh-remote+b', () => new FakeSession());

		registry.dispose();

		assert.deepStrictEqual({ a: a.disposed, b: b.disposed, empty: registry.get('ssh-remote+a') }, { a: 1, b: 1, empty: undefined });
	});
});

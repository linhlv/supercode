/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Keyed collection of per-host sessions. Keys are remote authorities
 * (`ssh-remote+<host>`); they are compared case-insensitively because the
 * authority of a vscode-remote URI is lowercased on the way back to the resolver.
 */
export class SessionRegistry<T extends { dispose(): void }> {

	private readonly sessions = new Map<string, T>();

	private static key(authority: string): string {
		return authority.toLowerCase();
	}

	/** Returns the session of `authority`, creating it with `create` when there is none. */
	getOrCreate(authority: string, create: () => T): T {
		const key = SessionRegistry.key(authority);
		let session = this.sessions.get(key);
		if (!session) {
			session = create();
			this.sessions.set(key, session);
		}
		return session;
	}

	get(authority: string): T | undefined {
		return this.sessions.get(SessionRegistry.key(authority));
	}

	/** Removes and disposes the session of `authority`, leaving all others untouched. */
	delete(authority: string): void {
		const key = SessionRegistry.key(authority);
		const session = this.sessions.get(key);
		if (session) {
			this.sessions.delete(key);
			session.dispose();
		}
	}

	/** Disposes and removes every session. */
	dispose(): void {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		for (const session of sessions) {
			session.dispose();
		}
	}
}

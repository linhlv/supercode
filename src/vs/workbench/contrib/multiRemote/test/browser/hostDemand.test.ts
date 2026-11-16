/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IVisibleEditorsChangeEvent, IEditorService } from '../../../../services/editor/common/editorService.js';
import { RemoteFileSystemRouter } from '../../../../services/remote/browser/remoteFileSystemRouter.js';
import { IMultiRemoteService, RemoteHostState } from '../../../../services/remote/common/multiRemoteService.js';
import { IWorkspaceGroup, IWorkspaceGroupsService } from '../../../../services/workspaceGroups/common/workspaceGroups.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { HostDemandService } from '../../browser/hostDemand.js';

suite('HostDemand', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const A = 'ssh-remote+a';
	const B = 'ssh-remote+b';

	let folders: IWorkspaceFolder[];
	let groups: IWorkspaceGroup[];
	let visible: URI[];
	let terminals: string[];
	let ready: () => void;
	let foldersEmitter: Emitter<IWorkspaceFoldersChangeEvent>;
	let groupsEmitter: Emitter<void>;
	let editorsEmitter: Emitter<IVisibleEditorsChangeEvent>;
	let createdEmitter: Emitter<ITerminalInstance>;
	let disposedEmitter: Emitter<ITerminalInstance>;

	const uri = (authority: string, path = '/w') => URI.from({ scheme: Schemas.vscodeRemote, authority, path });
	const folder = (u: URI, index = 0): IWorkspaceFolder => ({ uri: u, name: 'w', index, toResource: p => URI.joinPath(u, p) });
	const group = (name: string, members: URI[], collapsed: boolean): IWorkspaceGroup => ({ name, folders: members, collapsed });

	function create(options: { ready?: boolean } = {}): HostDemandService {
		const contextService = {
			getWorkspace: () => ({ folders }),
			onDidChangeWorkspaceFolders: foldersEmitter.event
		} as Partial<IWorkspaceContextService> as IWorkspaceContextService;
		const groupsService = {
			whenReady: new Promise<void>(resolve => { ready = resolve; }),
			get groups() { return groups; },
			onDidChange: groupsEmitter.event,
			getGroupOf: (f: URI) => groups.find(g => g.folders.some(m => m.toString() === f.toString()))
		} as Partial<IWorkspaceGroupsService> as IWorkspaceGroupsService;
		const editorService = {
			get visibleEditors() { return visible.map(resource => ({ resource, typeId: 'test', matches: () => false, toUntyped: () => ({ resource }) }) as unknown as EditorInput); },
			onDidVisibleEditorsChange: editorsEmitter.event
		} as Partial<IEditorService> as IEditorService;
		const terminalService = {
			get instances() { return terminals.map(remoteAuthority => ({ remoteAuthority }) as ITerminalInstance); },
			onDidCreateInstance: createdEmitter.event,
			onDidDisposeInstance: disposedEmitter.event
		} as Partial<ITerminalService> as ITerminalService;
		const service = store.add(new HostDemandService(contextService, groupsService, editorService, terminalService));
		if (options.ready !== false) {
			ready();
		}
		return service;
	}

	setup(() => {
		folders = [];
		groups = [];
		visible = [];
		terminals = [];
		foldersEmitter = store.add(new Emitter());
		groupsEmitter = store.add(new Emitter());
		editorsEmitter = store.add(new Emitter());
		createdEmitter = store.add(new Emitter());
		disposedEmitter = store.add(new Emitter());
	});

	async function whenReady(service: HostDemandService): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
		void service;
	}

	test('ungrouped remote root is wanted', async () => {
		folders = [folder(uri(A))];
		const service = create();
		await whenReady(service);
		assert.deepStrictEqual({ wanted: service.getWantedHosts(), roots: service.getRootHosts(), isWanted: service.isWanted(A) }, { wanted: [A], roots: [A], isWanted: true });
	});

	test('nothing is wanted before the groups are read; onDidChange fires once they are', async () => {
		folders = [folder(uri(A))];
		const service = create({ ready: false });
		let fired = 0;
		store.add(service.onDidChange(() => fired++));
		const before = { wanted: service.isWanted(A), hosts: service.getWantedHosts(), roots: service.hasRoots(A), fired };

		ready();
		await whenReady(service);

		assert.deepStrictEqual({ before, after: { wanted: service.isWanted(A), fired } }, {
			before: { wanted: false, hosts: [], roots: true, fired: 0 },
			after: { wanted: true, fired: 1 }
		});
	});

	test('root only in a collapsed group is not wanted', async () => {
		folders = [folder(uri(A))];
		groups = [group('g', [uri(A)], true)];
		const service = create();
		await whenReady(service);
		assert.deepStrictEqual({ wanted: service.isWanted(A), roots: service.hasRoots(A), inUse: service.isInUse(A) }, { wanted: false, roots: true, inUse: true });
	});

	test('host with roots in an expanded and a collapsed group is wanted', async () => {
		folders = [folder(uri(A, '/x'), 0), folder(uri(A, '/y'), 1)];
		groups = [group('open', [uri(A, '/x')], false), group('shut', [uri(A, '/y')], true)];
		const service = create();
		await whenReady(service);
		assert.strictEqual(service.isWanted(A), true);
	});

	test('visible editor on a collapsed group\'s host makes it wanted; a background tab does not', async () => {
		folders = [folder(uri(A)), folder(uri(B))];
		groups = [group('g', [uri(A), uri(B)], true)];
		const service = create();
		await whenReady(service);
		visible = [uri(A, '/w/file.ts')];
		assert.deepStrictEqual({ a: service.isWanted(A), b: service.isWanted(B) }, { a: true, b: false });
	});

	test('terminal on a collapsed group\'s host makes it wanted', async () => {
		folders = [folder(uri(A))];
		groups = [group('g', [uri(A)], true)];
		const service = create();
		await whenReady(service);
		terminals = [A];
		assert.strictEqual(service.isWanted(A), true);
	});

	test('host without roots is never wanted', async () => {
		visible = [uri(A, '/file.ts')];
		terminals = [A];
		const service = create();
		await whenReady(service);
		assert.deepStrictEqual({ wanted: service.isWanted(A), roots: service.hasRoots(A), inUse: service.isInUse(A) }, { wanted: false, roots: false, inUse: true });
	});

	test('authorities compare case-insensitively', async () => {
		folders = [folder(uri('SSH-remote+A', '/x'), 0), folder(uri('ssh-remote+a', '/y'), 1)];
		groups = [group('g', [uri('SSH-remote+A', '/x'), uri('ssh-remote+a', '/y')], true)];
		const service = create();
		await whenReady(service);
		visible = [uri('ssh-remote+A', '/z')];
		assert.deepStrictEqual({ roots: service.getRootHosts(), wanted: service.isWanted('Ssh-Remote+a'), hasRoots: service.hasRoots('SSH-REMOTE+A') }, { roots: ['SSH-remote+A'], wanted: true, hasRoots: true });
	});

	test('fires onDidChange when a group is expanded', async () => {
		folders = [folder(uri(A))];
		groups = [group('g', [uri(A)], true)];
		const service = create();
		await whenReady(service);
		let fired = 0;
		store.add(service.onDidChange(() => fired++));
		groups = [group('g', [uri(A)], false)];
		groupsEmitter.fire();
		foldersEmitter.fire({ added: [], removed: [], changed: [] });
		editorsEmitter.fire({} as IVisibleEditorsChangeEvent);
		createdEmitter.fire({} as ITerminalInstance);
		disposedEmitter.fire({} as ITerminalInstance);
		assert.deepStrictEqual({ fired, wanted: service.isWanted(A) }, { fired: 5, wanted: true });
	});

	test('router does not auto-connect an unwanted host and fails fast with Unavailable', async () => {
		folders = [folder(uri(A)), folder(uri(B))];
		groups = [group('g', [uri(B)], true)];
		const demand = create();
		await whenReady(demand);

		const connectCalls: string[] = [];
		const multiRemoteService = {
			onDidChangeHostState: store.add(new Emitter()).event,
			getState: (): RemoteHostState | undefined => undefined,
			getConnected: () => undefined,
			getHosts: () => [],
			connect: async (authority: string) => { connectCalls.push(authority); throw new Error('no'); }
		} as unknown as IMultiRemoteService;
		const router = store.add(new RemoteFileSystemRouter(multiRemoteService, undefined, undefined, authority => demand.isWanted(authority)));

		const error = await router.stat(uri(B)).then(() => undefined, (e: Error) => e);
		await router.stat(uri(A)).then(() => undefined, () => undefined);

		assert.deepStrictEqual({ code: error && toFileSystemProviderErrorCode(error), connectCalls }, { code: FileSystemProviderErrorCode.Unavailable, connectCalls: [A] });
	});
});

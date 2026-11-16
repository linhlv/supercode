/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { parse } from '../../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../../base/common/jsonEdit.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceFolderCreationData } from '../../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceFolder, IWorkspaceFoldersChangeEvent, IWorkspaceIdentifier, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IJSONEditingService, IJSONValue } from '../../../configuration/common/jsonEditing.js';
import { WORKSPACE_GROUPS_KEY } from '../../common/workspaceGroups.js';
import { WorkspaceGroupsService } from '../../browser/workspaceGroupsService.js';

suite('WorkspaceGroupsService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const configPath = URI.parse('file:///w/main.code-workspace');
	const a = URI.parse('file:///a');
	const b = URI.parse('file:///b');
	const c = URI.parse('file:///c');

	let fileService: FileService;
	let storageService: InMemoryStorageService;
	let state: WorkbenchState;
	let folders: IWorkspaceFolder[];
	let foldersEmitter: Emitter<IWorkspaceFoldersChangeEvent>;
	let remoteAuthority: string | undefined;
	let log: string[];
	let writes: number;
	let untitledConfigPath: URI;

	function toFolder(uri: URI, index: number): IWorkspaceFolder {
		return { uri, name: uri.path, index, toResource: p => URI.joinPath(uri, p) };
	}

	function setFolders(uris: URI[]): void {
		folders = uris.map(toFolder);
	}

	async function writeFile(resource: URI, json: object): Promise<void> {
		await fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify(json)));
	}

	async function readJson(resource: URI = configPath): Promise<any> {
		return parse((await fileService.readFile(resource)).value.toString());
	}

	async function seed(groups: { name: string; folders: URI[] }[] | undefined, workspaceFolders: URI[] = [a, b, c]): Promise<void> {
		setFolders(workspaceFolders);
		await writeFile(configPath, {
			folders: workspaceFolders.map(f => ({ uri: f.toString() })),
			...(groups ? { [WORKSPACE_GROUPS_KEY]: groups.map(g => ({ name: g.name, folders: g.folders.map(f => f.toString()) })) } : {})
		});
	}

	function create(): WorkspaceGroupsService {
		const contextService = {
			getWorkbenchState: () => state,
			getWorkspace: () => ({ folders, configuration: state === WorkbenchState.WORKSPACE ? configPath : null }),
			onDidChangeWorkspaceFolders: foldersEmitter.event
		};
		const jsonEditingService: IJSONEditingService = {
			_serviceBrand: undefined,
			write: async (resource: URI, values: IJSONValue[]) => {
				log.push('write');
				writes++;
				let text = (await fileService.readFile(resource)).value.toString();
				for (const value of values) {
					text = applyEdits(text, setProperty(text, value.path, value.value, { insertSpaces: false, tabSize: 4, eol: '\n' }));
				}
				await fileService.writeFile(resource, VSBuffer.fromString(text));
			}
		};
		const workspaceEditingService = {
			addFolders: async (toAdd: IWorkspaceFolderCreationData[]) => {
				log.push('addFolders');
				const added = toAdd.map((f, i) => toFolder(f.uri, folders.length + i));
				folders = [...folders, ...added];
				foldersEmitter.fire({ added, removed: [], changed: [] });
			},
			removeFolders: async (toRemove: URI[]) => {
				log.push('removeFolders');
				const removed = folders.filter(f => toRemove.some(r => extUri.isEqual(r, f.uri)));
				folders = folders.filter(f => !removed.includes(f)).map((f, i) => toFolder(f.uri, i));
				foldersEmitter.fire({ added: [], removed, changed: [] });
			},
			enterWorkspace: async (path: URI) => { log.push(`enterWorkspace ${path.toString()}`); }
		};
		const workspacesService = {
			createUntitledWorkspace: async (toCreate?: IWorkspaceFolderCreationData[]): Promise<IWorkspaceIdentifier> => {
				log.push(`createUntitledWorkspace ${(toCreate ?? []).map(f => f.uri.toString()).join(',')}`);
				await writeFile(untitledConfigPath, { folders: (toCreate ?? []).map(f => ({ uri: f.uri.toString() })) });
				return { id: 'untitled', configPath: untitledConfigPath };
			}
		};
		const environmentService = { remoteAuthority };
		const userDataProfileService = { currentProfile: { isDefault: true } };
		const userDataProfilesService = { setProfileForWorkspace: async () => { } };
		return store.add(new WorkspaceGroupsService(
			contextService as never, fileService, jsonEditingService, workspaceEditingService as never, workspacesService as never,
			storageService, environmentService as never, { extUri } as never, userDataProfileService as never, userDataProfilesService as never));
	}

	function summarize(service: WorkspaceGroupsService) {
		return service.groups.map(g => ({ name: g.name, collapsed: g.collapsed, folders: g.folders.map(f => f.toString()) }));
	}

	function storedOf(json: any) {
		return json[WORKSPACE_GROUPS_KEY];
	}

	async function created(service: WorkspaceGroupsService): Promise<WorkspaceGroupsService> {
		await service.whenReady;
		return service;
	}

	setup(async () => {
		fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		storageService = store.add(new InMemoryStorageService());
		foldersEmitter = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		state = WorkbenchState.WORKSPACE;
		remoteAuthority = undefined;
		log = [];
		writes = 0;
		untitledConfigPath = URI.parse('file:///untitled/workspace.code-workspace');
		setFolders([a, b, c]);
	});

	test('reads groups from the workspace file and reports them collapsed by default', async () => {
		await seed([{ name: 'g', folders: [a, b] }]);
		const service = await created(create());
		assert.deepStrictEqual(summarize(service), [{ name: 'g', collapsed: true, folders: [a.toString(), b.toString()] }]);
		assert.strictEqual(service.getGroupOf(b)?.name, 'g');
		assert.strictEqual(service.getGroupOf(c), undefined);
	});

	test('setCollapsed persists in workspace storage and fires onDidChange', async () => {
		await seed([{ name: 'g', folders: [a] }]);
		const service = await created(create());
		let fired = 0;
		store.add(service.onDidChange(() => fired++));
		const before = writes;

		service.setCollapsed('g', false);

		assert.deepStrictEqual({ fired, collapsed: service.groups[0].collapsed, writes: writes - before }, { fired: 1, collapsed: false, writes: 0 });
		assert.deepStrictEqual(JSON.parse(storageService.get('workspaceGroups.collapsed', StorageScope.WORKSPACE)!), { g: false });
	});

	test('collapsed state is read from workspace storage by lowercased name', async () => {
		storageService.store('workspaceGroups.collapsed', JSON.stringify({ g: false }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		await seed([{ name: 'G', folders: [a] }, { name: 'other', folders: [b] }]);
		const service = await created(create());
		assert.deepStrictEqual(service.groups.map(g => g.collapsed), [false, true]);
	});

	test('createGroup adds folders to the workspace and lists them under a unique name', async () => {
		await seed([{ name: 'g', folders: [a] }], [a]);
		const service = await created(create());

		const name = await service.createGroup('g', [{ uri: b }, { uri: c }]);

		assert.strictEqual(name, 'g (2)');
		assert.deepStrictEqual(storedOf(await readJson()), [
			{ name: 'g', folders: [a.toString()] },
			{ name: 'g (2)', folders: [b.toString(), c.toString()] }
		]);
		assert.deepStrictEqual(summarize(service).map(g => g.name), ['g', 'g (2)']);
	});

	test('createGroup in a folder window writes the group into the new workspace file before entering it', async () => {
		state = WorkbenchState.FOLDER;
		setFolders([a]);
		const service = create();

		const name = await service.createGroup('g', [{ uri: b }]);

		assert.strictEqual(name, 'g');
		assert.deepStrictEqual(log, [
			`createUntitledWorkspace ${a.toString()},${b.toString()}`,
			'write',
			`enterWorkspace ${untitledConfigPath.toString()}`
		]);
		assert.deepStrictEqual(storedOf(await readJson(untitledConfigPath)), [{ name: 'g', folders: [b.toString()] }]);
		assert.deepStrictEqual(service.groups, []);
	});

	test('createGroup in an empty window creates a workspace of only the new folders', async () => {
		state = WorkbenchState.EMPTY;
		setFolders([]);
		await create().createGroup('g', [{ uri: b }]);
		assert.deepStrictEqual(log, [`createUntitledWorkspace ${b.toString()}`, 'write', `enterWorkspace ${untitledConfigPath.toString()}`]);
	});

	test('mutators other than createGroup are no-ops in a folder window', async () => {
		state = WorkbenchState.FOLDER;
		setFolders([a]);
		const service = create();
		await service.renameGroup('x', 'y').catch(() => { });
		await service.moveFolder(a, 'x');
		await service.removeGroup('x', false);
		service.setCollapsed('x', false);
		assert.deepStrictEqual({ log, groups: service.groups }, { log: [], groups: [] });
	});

	test('renameGroup moves its collapsed state', async () => {
		await seed([{ name: 'g', folders: [a] }]);
		const service = await created(create());
		service.setCollapsed('g', false);

		await service.renameGroup('g', ' h ');

		assert.deepStrictEqual(summarize(service), [{ name: 'h', collapsed: false, folders: [a.toString()] }]);
		assert.deepStrictEqual(JSON.parse(storageService.get('workspaceGroups.collapsed', StorageScope.WORKSPACE)!), { h: false });
		assert.deepStrictEqual(storedOf(await readJson()), [{ name: 'h', folders: [a.toString()] }]);
	});

	test('renameGroup rejects an invalid name', async () => {
		await seed([{ name: 'g', folders: [a] }, { name: 'h', folders: [b] }]);
		const service = await created(create());
		await assert.rejects(service.renameGroup('g', 'H'), /A group named 'H' already exists\./);
		await assert.rejects(service.renameGroup('g', '  '), /A group name is required\./);
		await service.renameGroup('g', 'G');
		assert.deepStrictEqual(service.groups.map(g => g.name), ['G', 'h']);
	});

	test('removeGroup with keepFolders leaves the roots ungrouped', async () => {
		await seed([{ name: 'g', folders: [a, b] }]);
		const service = await created(create());

		await service.removeGroup('g', true);

		assert.deepStrictEqual({ groups: service.groups, key: storedOf(await readJson()), folders: folders.length }, { groups: [], key: undefined, folders: 3 });
	});

	test('removeGroup without keepFolders removes its roots from the workspace', async () => {
		await seed([{ name: 'g', folders: [a, b] }, { name: 'h', folders: [c] }]);
		const service = await created(create());

		await service.removeGroup('g', false);

		assert.deepStrictEqual({ folders: folders.map(f => f.uri.toString()), groups: summarize(service).map(g => g.name) }, { folders: [c.toString()], groups: ['h'] });
		assert.deepStrictEqual(storedOf(await readJson()), [{ name: 'h', folders: [c.toString()] }]);
	});

	test('moveFolder moves a root between groups and to ungrouped', async () => {
		await seed([{ name: 'g', folders: [a, b] }, { name: 'h', folders: [c] }]);
		const service = await created(create());

		await service.moveFolder(a, 'h');
		assert.deepStrictEqual(summarize(service).map(g => g.folders), [[b.toString()], [a.toString(), c.toString()]]);

		await service.moveFolder(b, undefined);
		assert.deepStrictEqual(storedOf(await readJson()), [{ name: 'g', folders: [] }, { name: 'h', folders: [a.toString(), c.toString()] }]);
	});

	test('folders added while a group is focused join it', async () => {
		await seed([{ name: 'g', folders: [a] }, { name: 'h', folders: [] }], [a]);
		const service = await created(create());
		service.setFocusedGroup('g');

		let changed = Event.toPromise(service.onDidChange);
		folders = [...folders, toFolder(b, 1)];
		foldersEmitter.fire({ added: [folders[1]], removed: [], changed: [] });
		await changed;
		assert.deepStrictEqual(summarize(service).map(g => g.folders), [[a.toString(), b.toString()], []]);

		changed = Event.toPromise(service.onDidChange);
		await service.addFolders('h', [{ uri: c }]);
		await changed;
		assert.deepStrictEqual(summarize(service).map(g => g.folders), [[a.toString(), b.toString()], [c.toString()]]);
	});

	test('removing a root from the workspace drops it from its group on the next write', async () => {
		await seed([{ name: 'g', folders: [a, b] }]);
		const service = await created(create());
		setFolders([a]);
		foldersEmitter.fire({ added: [], removed: [toFolder(b, 1)], changed: [] });

		service.setFocusedGroup(undefined);
		await service.renameGroup('g', 'g2');

		assert.deepStrictEqual(storedOf(await readJson()), [{ name: 'g2', folders: [a.toString()] }]);
	});

	test('reloads when the workspace file changes on disk', async () => {
		await seed([{ name: 'g', folders: [a] }]);
		const service = await created(create());

		const changed = Event.toPromise(service.onDidChange);
		await seed([{ name: 'other', folders: [b, c] }]);
		await changed;

		assert.deepStrictEqual(summarize(service), [{ name: 'other', collapsed: true, folders: [b.toString(), c.toString()] }]);
	});

	test('importWorkspaceFile skips folders already in the window and reports them', async () => {
		await seed(undefined, [a]);
		const service = await created(create());
		const file = URI.parse('file:///imports/shop.code-workspace');
		await writeFile(file, { folders: [{ uri: a.toString() }, { uri: b.toString() }, { uri: c.toString() }] });

		const result = await service.importWorkspaceFile(file);

		assert.deepStrictEqual({ groups: result.groups, skipped: result.skipped.map(s => s.toString()), added: folders.map(f => f.uri.toString()) },
			{ groups: ['shop'], skipped: [a.toString()], added: [a.toString(), b.toString(), c.toString()] });
		assert.deepStrictEqual(storedOf(await readJson()), [{ name: 'shop', folders: [b.toString(), c.toString()] }]);
	});

	test('importWorkspaceFile imports the groups of a file that has its own', async () => {
		await seed(undefined, [a]);
		const service = await created(create());
		const file = URI.parse('file:///imports/shop.code-workspace');
		await writeFile(file, { folders: [{ uri: b.toString() }, { uri: c.toString() }], [WORKSPACE_GROUPS_KEY]: [{ name: 'x', folders: [b.toString()] }, { name: 'y', folders: [c.toString()] }] });

		const result = await service.importWorkspaceFile(file);

		assert.deepStrictEqual(result.groups, ['x', 'y']);
		assert.deepStrictEqual(summarize(service).map(g => g.folders), [[b.toString()], [c.toString()]]);
	});

	test('importWorkspaceFile rejects remote workspace files', async () => {
		await seed(undefined, [a]);
		const service = await created(create());
		const file = URI.parse('file:///imports/remote.code-workspace');
		await writeFile(file, { folders: [{ path: '/srv' }], remoteAuthority: 'ssh-remote+box' });

		await assert.rejects(service.importWorkspaceFile(file), /remote\.code-workspace/);
	});

	test('whenReady resolves after the initial read with the stored groups', async () => {
		await seed([{ name: 'g', folders: [a] }]);
		const service = create();
		assert.strictEqual(service.groups.length, 0);
		await service.whenReady;
		assert.deepStrictEqual(service.groups.map(g => g.name), ['g']);
	});

	test('whenReady resolves immediately in an inactive window', async () => {
		state = WorkbenchState.FOLDER;
		setFolders([a]);
		const service = create();
		await service.whenReady;
		assert.deepStrictEqual(service.groups, []);
	});

	test('whenReady resolves when the initial read fails', async () => {
		const service = create(); // the workspace file does not exist
		await service.whenReady;
		assert.deepStrictEqual(service.groups, []);
	});

	test('is empty and inert in a remote window', async () => {
		remoteAuthority = 'ssh-remote+box';
		await seed([{ name: 'g', folders: [a] }]);
		const service = create();

		const name = await service.createGroup('x', [{ uri: b }]);
		await service.moveFolder(a, undefined);
		await service.removeGroup('g', false);

		assert.deepStrictEqual({ groups: service.groups, log, writes, name }, { groups: [], log: [], writes: 0, name: 'x' });
	});
});

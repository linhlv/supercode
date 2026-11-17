/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { WorkspaceFolderCwdPair, getCwdForSplit, pickCwdForNewTerminal, pickCwdForSplit, shrinkWorkspaceFolderCwdPairs } from '../../browser/terminalActions.js';
import { ITerminalConfigurationService, ITerminalInstance } from '../../browser/terminal.js';
import { ITerminalConfiguration } from '../../common/terminal.js';

function makeFakeFolder(name: string, uri: URI): IWorkspaceFolder {
	return {
		name,
		uri,
		index: 0,
		toResource: () => uri,
	};
}

function makePair(folder: IWorkspaceFolder, cwd?: URI | IWorkspaceFolder, isAbsolute?: boolean): WorkspaceFolderCwdPair {
	return {
		folder,
		cwd: !cwd ? folder.uri : (cwd instanceof URI ? cwd : cwd.uri),
		isAbsolute: !!isAbsolute,
		isOverridden: !!cwd && cwd.toString() !== folder.uri.toString(),
	};
}

suite('terminalActions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const root: URI = URI.file('/some-root');
	const a = makeFakeFolder('a', URI.joinPath(root, 'a'));
	const b = makeFakeFolder('b', URI.joinPath(root, 'b'));
	const c = makeFakeFolder('c', URI.joinPath(root, 'c'));
	const d = makeFakeFolder('d', URI.joinPath(root, 'd'));

	async function pick(folders: IWorkspaceFolder[], run: typeof pickCwdForNewTerminal = pickCwdForNewTerminal, splitCwd: ITerminalConfiguration['splitCwd'] = 'askInMultiRoot'): Promise<{ result: { cwd: URI | undefined } | undefined; offered: string[] }> {
		const offered: string[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() {
			override getWorkspace() { return { id: 'w', folders, uri: undefined }; }
		});
		instantiationService.stub(IQuickInputService, new class extends mock<IQuickInputService>() {
			override async pick<T extends IQuickPickItem>(picks: Promise<QuickPickInput<T>[]> | QuickPickInput<T>[]): Promise<T | undefined> {
				const items = (Array.isArray(picks) ? picks : await picks).filter((item): item is T => item.type !== 'separator');
				offered.push(...items.map(item => item.label));
				return items[items.length - 1];
			}
		});
		instantiationService.stub(ILabelService, { getUriLabel: (uri: URI) => uri.path });
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IConfigurationResolverService, {});
		instantiationService.stub(IModelService, {});
		instantiationService.stub(ILanguageService, {});
		instantiationService.stub(ITerminalConfigurationService, new class extends mock<ITerminalConfigurationService>() {
			override config = new class extends mock<ITerminalConfiguration>() { override splitCwd = splitCwd; };
		});
		const result = await instantiationService.invokeFunction(run);
		return { result, offered };
	}

	suite('pickCwdForNewTerminal', () => {
		test('asks which root to start in when the workspace has several', async () => {
			deepStrictEqual(await pick([a, b]), { result: { cwd: b.uri }, offered: ['a', 'b'] });
		});

		test('leaves the cwd to the terminal service with a single root', async () => {
			deepStrictEqual(await pick([a]), { result: { cwd: undefined }, offered: [] });
		});
	});

	suite('pickCwdForSplit', () => {
		test('asks which root to start in when the workspace has several', async () => {
			deepStrictEqual(await pick([a, b], pickCwdForSplit), { result: { cwd: b.uri }, offered: ['a', 'b'] });
		});

		test('leaves the cwd to the terminal service with a single root', async () => {
			deepStrictEqual(await pick([a], pickCwdForSplit), { result: { cwd: undefined }, offered: [] });
		});

		test('does not ask unless splitCwd is askInMultiRoot', async () => {
			deepStrictEqual(await pick([a, b], pickCwdForSplit, 'workspaceRoot'), { result: { cwd: undefined }, offered: [] });
		});
	});

	suite('getCwdForSplit', () => {
		test('uses the cwd of the parent for askInMultiRoot without asking', async () => {
			const instance = new class extends mock<ITerminalInstance>() { override async getSpeculativeCwd() { return '/parent-current'; } };
			const commandService = new class extends mock<ICommandService>() { override executeCommand(): never { throw new Error('asked for a folder'); } };
			const configService = new class extends mock<ITerminalConfigurationService>() {
				override config = new class extends mock<ITerminalConfiguration>() { override splitCwd = 'askInMultiRoot' as const; };
			};
			deepStrictEqual(await getCwdForSplit(instance, [a, b], commandService, configService), '/parent-current');
		});
	});

	suite('shrinkWorkspaceFolderCwdPairs', () => {
		test('should return empty when given array is empty', () => {
			deepStrictEqual(shrinkWorkspaceFolderCwdPairs([]), []);
		});

		test('should return the only single pair when given argument is a single element array', () => {
			const pairs = [makePair(a)];
			deepStrictEqual(shrinkWorkspaceFolderCwdPairs(pairs), pairs);
		});

		test('should return all pairs when no repeated cwds', () => {
			const pairs = [makePair(a), makePair(b), makePair(c)];
			deepStrictEqual(shrinkWorkspaceFolderCwdPairs(pairs), pairs);
		});

		suite('should select the pair that has the same URI when repeated cwds exist', () => {
			test('all repeated', () => {
				const pairA = makePair(a);
				const pairB = makePair(b, a); // CWD points to A
				const pairC = makePair(c, a); // CWD points to A
				deepStrictEqual(shrinkWorkspaceFolderCwdPairs([pairA, pairB, pairC]), [pairA]);
			});

			test('two repeated + one different', () => {
				const pairA = makePair(a);
				const pairB = makePair(b, a); // CWD points to A
				const pairC = makePair(c);
				deepStrictEqual(shrinkWorkspaceFolderCwdPairs([pairA, pairB, pairC]), [pairA, pairC]);
			});

			test('two repeated + two repeated', () => {
				const pairA = makePair(a);
				const pairB = makePair(b, a); // CWD points to A
				const pairC = makePair(c);
				const pairD = makePair(d, c);
				deepStrictEqual(shrinkWorkspaceFolderCwdPairs([pairA, pairB, pairC, pairD]), [pairA, pairC]);
			});

			test('two repeated + two repeated (reverse order)', () => {
				const pairB = makePair(b, a); // CWD points to A
				const pairA = makePair(a);
				const pairD = makePair(d, c);
				const pairC = makePair(c);
				deepStrictEqual(shrinkWorkspaceFolderCwdPairs([pairA, pairB, pairC, pairD]), [pairA, pairC]);
			});
		});
	});
});

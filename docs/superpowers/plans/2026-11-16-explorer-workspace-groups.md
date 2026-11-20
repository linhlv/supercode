# Explorer Workspace Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named, collapsible workspace groups in the Supercode Explorer, so 15–20 workspaces (each a mix of local and SSH folders) live in one window, and a collapsed group's SSH hosts stay disconnected.

**Architecture:** The window keeps one `.code-workspace`. A new `IWorkspaceGroupsService` owns group membership (stored under the top-level `"supercode.groups"` key of that file) and collapsed state (workspace storage). The Explorer shows each group as an `ExplorerGroupItem`: a synthetic, read-only `ExplorerItem` whose children are the existing root items, so roots keep `isRoot` and every root command. A new `IHostDemandService` decides which hosts are *wanted*; background connect, the file-system router's auto-connect, the idle disconnect and the Hosts status bar all use it.

**Tech Stack:** TypeScript, VS Code workbench DI/services, `WorkbenchCompressibleAsyncDataTree`, `IJSONEditingService`, `base/common/json`, mocha (tdd UI) unit tests, `vscode-api-tests` multiremote integration suite with the test resolver.

**Spec:** `/Users/linh/Documents/Projects/supercode/docs/superpowers/specs/2026-11-16-explorer-workspace-groups-design.md`

## Global Constraints

- Code lives in `/Users/linh/Documents/Projects/supercode/vscode`. Work on a new branch `workspace-groups` created from `multi-host`. Paths below are relative to `vscode/`.
- Node `24.22.1` (`.nvmrc`), `pnpm`. macOS arm64 only.
- Groups are active **only** in a local desktop window: `IWorkbenchEnvironmentService.remoteAuthority === undefined && !isWeb`, and `contextService.getWorkbenchState() === WorkbenchState.WORKSPACE`. Otherwise `groups` is `[]` and the Explorer is unchanged.
- Storage key in the workspace file: exactly `"supercode.groups"`; value: `[{ "name": string, "folders": string[] /* full URI strings */ }]`. Collapsed state: workspace storage key `workspaceGroups.collapsed`, JSON `{ [lowercased name]: boolean }`. A group with no stored state is **collapsed**.
- Group names: trimmed, non-empty, unique **case-insensitively**. Duplicate on create/import gets ` (2)`, ` (3)`, … appended.
- Group resource URI: scheme `supercode-group`, path `/` + `encodeURIComponent(name)`.
- Host identity: `vscode-remote` authority compared **case-insensitively** (same as multi-host).
- Idle disconnect delay: setting `multiRemote.idleDisconnectDelay`, seconds, default `300`, minimum `0`.
- No `supercode.groups` key → Explorer, connections and status bar behave exactly as before this plan.
- Keep upstream diffs small: new code goes in `services/workspaceGroups/`, `contrib/multiRemote/` and `contrib/files/common/explorerGroupItem.ts`; upstream files get hooks only. List touched upstream files in each commit body.
- Every new `.ts` file starts with the Microsoft MIT header from a neighbouring file; user-visible strings via `localize`/`localize2`; respect layer folders.
- Before each commit: `pnpm exec eslint <changed files>` and `pnpm run valid-layers-check` pass. Unit tests run with `./scripts/test.sh --grep "<suite>"` against compiled output (keep `pnpm run watch` running). Commit messages use the `area: lower-case summary` style of the branch (`workspaceGroups: …`, `multiRemote: …`, `explorer: …`) and end with the session attribution lines.

## Deviations from the spec (decided while planning)

- **Removing the last root of a host** still disconnects it immediately, as today; the idle delay applies only to hosts that still have roots but are no longer wanted (collapsed groups). Keeps existing tests and behaviour.
- **A failed host is not retried** just because its group is expanded again; it keeps its `!` and Reconnect, as today.
- **The idle delay is a setting** (`multiRemote.idleDisconnectDelay`) rather than a constant, so the integration test can shorten it.
- **Rename Group uses an input box**, not inline editing in the tree (inline editing is file-rename machinery).
- **The group context menu is its own menu** (`MenuId.ExplorerGroupContext`), so no upstream Explorer menu item needs a new `when` clause.
- **"Add into the selected group"** for File → Add Folder and Add SSH Folder works through the groups service: the Explorer reports the focused group, and folders added while a group is focused (and not added through a group command) are assigned to it.
- **Wanted needs roots:** a visible editor or terminal keeps a host wanted only if the host has a root; hosts without roots keep today's rules.

## Review Focus

1. **Expanding a group whose roots were read while it was collapsed.** Watchers and settings touched those roots at startup and got "Unavailable", so the roots may show an error. Expected: once the host connects, the roots fill in without a manual refresh. Test: Task 8 `expanding a group connects its host and lists its root`.
2. **A workspace file edited by hand or by stock VS Code:** stale URIs, duplicate names, a folder in two groups, a non-array value. Expected: no error, and the result is reconciled as the spec describes. Tests: Task 1 `reconcileGroups …`.
3. **A host with roots in both a collapsed group and an expanded group (or ungrouped).** Expected: the host stays connected. Test: Task 3 `host with roots in an expanded and a collapsed group is wanted`.
4. **Collapsing and re-expanding within the delay.** Expected: no disconnect and no reconnect. Test: Task 4 `wanted again before the delay keeps the host connected`.
5. **The first Add Workspace in a single-folder window,** which reloads the window into an untitled workspace. Expected: the new group exists after the reload, and the original folder stays ungrouped. Test: Task 2 `createGroup in a folder window writes the group into the new workspace file before entering it`.

---

### Task 0: Branch and green baseline

**Files:** none

- [ ] **Step 1:** `git checkout multi-host && git checkout -b workspace-groups`.
- [ ] **Step 2:** `pnpm install && pnpm run compile`. Expected: exit 0.
- [ ] **Step 3:** `./scripts/test.sh --grep "MultiRemote|RemoteFileSystemRouter|ExplorerModel|ExplorerView"` and `./scripts/test-multi-remote-integration.sh`. Expected: all pass. Record any test that already fails, so later tasks aren't blamed.

---

### Task 1: Group model: parsing, reconciling, naming, import parsing

**Files:**
- Create: `src/vs/workbench/services/workspaceGroups/common/workspaceGroups.ts`
- Test: `src/vs/workbench/services/workspaceGroups/test/common/workspaceGroups.test.ts` (suite `WorkspaceGroups - model`)

**Interfaces:**
- Produces:
  - `const WORKSPACE_GROUPS_KEY = 'supercode.groups'`, `const WORKSPACE_GROUP_SCHEME = 'supercode-group'`
  - `interface IStoredWorkspaceGroup { readonly name: string; readonly folders: readonly string[] }`
  - `interface IGroupMembership { readonly name: string; readonly folders: readonly URI[] }`
  - `interface IWorkspaceGroup extends IGroupMembership { readonly collapsed: boolean }`
  - `groupResource(name: string): URI` / `groupNameOf(resource: URI): string | undefined`
  - `reconcileGroups(raw: unknown, workspaceFolders: readonly URI[], extUri: IExtUri): IGroupMembership[]`
  - `toStoredGroups(groups: readonly IGroupMembership[]): IStoredWorkspaceGroup[]`
  - `uniqueGroupName(name: string, existing: readonly string[]): string`
  - `validateGroupName(name: string, existing: readonly string[], current?: string): string | undefined` (localized error, or `undefined` when valid; `current` is the group being renamed, so a case-only rename is allowed)
  - `interface IImportedWorkspace { readonly name: string; readonly folders: IWorkspaceFolderCreationData[]; readonly groups: IGroupMembership[] | undefined }`
  - `parseWorkspaceFileForImport(content: string, file: URI, extUri: IExtUri): IImportedWorkspace | { readonly error: 'invalid' | 'remote' }`
  - `IWorkspaceGroupsService` decorator + interface (implemented in Task 2):
    ```ts
    readonly onDidChange: Event<void>;            // membership, order, names, collapsed state
    readonly groups: readonly IWorkspaceGroup[];  // display order
    getGroupOf(folder: URI): IWorkspaceGroup | undefined;
    setCollapsed(name: string, collapsed: boolean): void;
    setFocusedGroup(name: string | undefined): void;
    createGroup(name: string, folders?: readonly IWorkspaceFolderCreationData[]): Promise<string>; // returns the unique name used
    addFolders(group: string, folders: readonly IWorkspaceFolderCreationData[]): Promise<void>;
    renameGroup(name: string, newName: string): Promise<void>;
    removeGroup(name: string, keepFolders: boolean): Promise<void>;
    moveFolder(folder: URI, group: string | undefined): Promise<void>; // undefined = ungroup
    importWorkspaceFile(file: URI): Promise<{ readonly groups: string[]; readonly skipped: URI[] }>;
    ```

- [ ] **Step 1: Write the failing tests**
  - `reconcileGroups ignores a missing or non-array value` → `reconcileGroups(undefined | {} | 'x', [a], extUri)` returns `[]`.
  - `reconcileGroups drops stale folders and keeps workspace order`: raw `[{name:'g', folders:[b, 'file:///gone', a]}]`, workspace `[a, b]` → `[{name:'g', folders:[a, b]}]`.
  - `reconcileGroups keeps the first of duplicate names (case-insensitive) and of a folder listed twice`: `[{name:'G',folders:[a]},{name:'g',folders:[b]},{name:'h',folders:[a,b]}]` → `[{name:'G',[a]},{name:'h',[b]}]`.
  - `reconcileGroups matches remote authorities case-insensitively`: stored `vscode-remote://ssh-remote+DevBox/srv` matches workspace folder `vscode-remote://ssh-remote+devbox/srv`; the result uses the workspace folder's URI.
  - `reconcileGroups trims names, drops empty names and malformed entries, keeps empty groups`.
  - `uniqueGroupName` → `('g', ['G'])` gives `'g (2)'`; `('g', ['g','g (2)'])` gives `'g (3)'`; `('x', [])` gives `'x'`.
  - `validateGroupName` → empty/whitespace and existing names (case-insensitive) give a message; `('Shop', ['shop'], 'shop')` gives `undefined`.
  - `groupResource round-trips names with slashes and spaces` through `groupNameOf`; `groupNameOf(file URI)` gives `undefined`.
  - `parseWorkspaceFileForImport resolves relative paths and uri entries`: file `file:///w/x.code-workspace` with `{"folders":[{"path":"app"},{"uri":"vscode-remote://ssh-remote+h/srv","name":"srv [SSH: h]"}]}` → name `'x'`, folders `file:///w/app` and the remote URI (with its name), `groups: undefined`.
  - `parseWorkspaceFileForImport returns its own groups when present` (reconciled against its own folders).
  - `parseWorkspaceFileForImport refuses remote workspaces and bad JSON` → a top-level `remoteAuthority` gives `{error:'remote'}`; `'{'` or a missing `folders` gives `{error:'invalid'}`. Comments and trailing commas are accepted.
  - `rewriting folders keeps the groups key and comments`: apply `jsonEdit.setProperty(content, ['folders'], newFolders, fmt)` (the same edit VS Code uses) to a file with `// comment` and `"supercode.groups"`. Both survive.
- [ ] **Step 2:** `./scripts/test.sh --grep "WorkspaceGroups - model"`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** in `workspaceGroups.ts`. Use `parse` from `base/common/json.js` (with `allowTrailingComma`), `toWorkspaceFolders` from `platform/workspaces/common/workspaces.js` for import paths, and `extUri.isEqual` for URI matching. The import name is the file's basename without `.code-workspace`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Commit** `workspaceGroups: add the group model and its storage format`.

---

### Task 2: `WorkspaceGroupsService`

**Files:**
- Create: `src/vs/workbench/services/workspaceGroups/browser/workspaceGroupsService.ts` (`registerSingleton(IWorkspaceGroupsService, WorkspaceGroupsService, InstantiationType.Delayed)`)
- Modify: `src/vs/workbench/workbench.common.main.ts` (import next to `./services/remote/browser/multiRemoteService.js`)
- Test: `src/vs/workbench/services/workspaceGroups/test/browser/workspaceGroupsService.test.ts` (suite `WorkspaceGroupsService`)

**Interfaces:**
- Consumes: Task 1 functions and interface.
- Produces: the service as declared in Task 1.

- [ ] **Step 1: Write the failing tests.** Use `workbenchInstantiationService`, an `InMemoryFileSystemProvider` for `file`, a `TestContextService` with a workspace whose `configuration` is `file:///w/main.code-workspace`, and a fake `IJSONEditingService` whose `write` applies `jsonEdit.setProperty` to the in-memory file.
  - `reads groups from the workspace file and reports them collapsed by default`.
  - `setCollapsed persists in workspace storage and fires onDidChange`, and does not write the file.
  - `createGroup adds folders to the workspace and lists them under a unique name`: existing `'g'` → returns `'g (2)'`, and the file has both groups.
  - `createGroup in a folder window writes the group into the new workspace file before entering it`: with `WorkbenchState.FOLDER`, it calls `workspacesService.createUntitledWorkspace([current folder, ...new])`, writes `supercode.groups` into the returned `configPath`, then calls `workspaceEditingService.enterWorkspace(configPath)` (assert the call order).
  - `renameGroup moves its collapsed state`; `renameGroup rejects an invalid name` (throws the `validateGroupName` message).
  - `removeGroup with keepFolders leaves the roots ungrouped`; `removeGroup without keepFolders removes its roots from the workspace`.
  - `moveFolder moves a root between groups and to ungrouped`.
  - `folders added while a group is focused join it`: `setFocusedGroup('g')`, then fire `onDidChangeWorkspaceFolders` with an added folder → the folder is in `'g'`. A folder added through `addFolders('h', …)` goes to `'h'` even when `'g'` is focused.
  - `removing a root from the workspace drops it from its group on the next write`.
  - `reloads when the workspace file changes on disk`.
  - `importWorkspaceFile skips folders already in the window and reports them`; `importWorkspaceFile rejects remote workspace files` with a message naming the file.
  - `is empty and inert in a remote window` (`remoteAuthority` set): `groups` is `[]` and writes are no-ops.
- [ ] **Step 2:** `./scripts/test.sh --grep "WorkspaceGroupsService"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Reads: `fileService.readFile(configPath)`, then `reconcileGroups` against `contextService.getWorkspace().folders`.
  - Re-reads on `onDidChangeWorkspaceFolders`, on `fileService.onDidFilesChange` containing `configPath`, and after its own writes.
  - Writes: `jsonEditingService.write(configPath, [{ path: [WORKSPACE_GROUPS_KEY], value }], true)`, with `value: undefined` when no groups remain.
  - Adding folders goes through `IWorkspaceEditingService.addFolders`; a URI set marks those adds as explicit, so the focused-group rule skips them.
  - Collapsed state: `IStorageService`, `StorageScope.WORKSPACE`, `StorageTarget.MACHINE`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Commit** `workspaceGroups: add the service that owns groups and their collapsed state`.

---

### Task 3: Wanted hosts and router gating

**Files:**
- Create: `src/vs/workbench/contrib/multiRemote/browser/hostDemand.ts` (`registerSingleton(IHostDemandService, HostDemandService, InstantiationType.Delayed)`, imported from `multiRemote.contribution.ts`)
- Modify: `src/vs/workbench/contrib/multiRemote/browser/multiRemote.contribution.ts:41` (router `canAutoConnect`)
- Modify: `src/vs/workbench/contrib/multiRemote/browser/multiRemoteWorkspace.ts:30-39` (`hasRoots`/`isHostInUse` delegate to the demand service or are removed; update callers in `multiRemoteActions.ts:77` and `multiRemoteStatus.ts:78`)
- Test: `src/vs/workbench/contrib/multiRemote/test/browser/hostDemand.test.ts` (suite `HostDemand`)

**Interfaces:**
- Consumes: `IWorkspaceGroupsService.groups`, `.getGroupOf`, `.onDidChange`.
- Produces:
  ```ts
  IHostDemandService {
    readonly onDidChange: Event<void>;
    hasRoots(authority: string): boolean;
    isWanted(authority: string): boolean; // hasRoots && (a root ungrouped or in an expanded group || a visible editor on it || a terminal on it)
    getRootHosts(): string[];   // authorities with roots, first spelling, deduped case-insensitively
    getWantedHosts(): string[];
    isInUse(authority: string): boolean; // today's isHostInUse: hasRoots || a terminal on it
  }
  ```
  `onDidChange` fires on workspace-folder, group, `editorService.onDidVisibleEditorsChange`, and terminal instance create/dispose events. Visible editors are read with `EditorResourceAccessor.getCanonicalUri(editor, { supportSideBySide: SideBySideEditor.BOTH })`.

- [ ] **Step 1: Write the failing tests.**
  - `ungrouped remote root is wanted`.
  - `root only in a collapsed group is not wanted`.
  - `host with roots in an expanded and a collapsed group is wanted`.
  - `visible editor on a collapsed group's host makes it wanted; a background tab does not`.
  - `terminal on a collapsed group's host makes it wanted`.
  - `host without roots is never wanted` (even with a visible editor).
  - `authorities compare case-insensitively`.
  - `fires onDidChange when a group is expanded`.
  - Router (in `RemoteFileSystemRouter` suite or here): `router does not auto-connect an unwanted host and fails fast with Unavailable`.
- [ ] **Step 2:** `./scripts/test.sh --grep "HostDemand|MultiRemote|RemoteFileSystemRouter"`. Expected: the new tests FAIL; existing tests pass.
- [ ] **Step 3: Implement.** The router's lambda becomes `authority => workspaceTrustManagementService.isWorkspaceTrusted() && hostDemand.isWanted(authority)`; resolve `IHostDemandService` through the contribution's constructor.
- [ ] **Step 4:** Re-run. Expected: all PASS (existing `MultiRemote*` suites unchanged, since their workspaces have no groups).
- [ ] **Step 5: Commit** `multiRemote: connect only hosts that a workspace group or editor wants`.

---

### Task 4: Connect on expand, idle disconnect, status bar, group decorations

**Files:**
- Modify: `src/vs/workbench/contrib/multiRemote/browser/multiRemoteWorkspace.ts` (connect logic, idle timers, decorations for group URIs)
- Modify: `src/vs/workbench/contrib/multiRemote/browser/multiRemoteStatus.ts` (counts and picker)
- Modify: `src/vs/workbench/contrib/multiRemote/browser/multiRemote.contribution.ts` (register setting `multiRemote.idleDisconnectDelay`: `type: 'number'`, `default: 300`, `minimum: 0`, description `"Seconds an SSH host stays connected after only collapsed workspace groups use it."`)
- Test: `src/vs/workbench/contrib/multiRemote/test/browser/multiRemoteWorkspace.test.ts` (extend suite `MultiRemoteWorkspace`, fake timers via `runWithFakedTimers`)

**Interfaces:**
- Consumes: `IHostDemandService` (Task 3), `IWorkspaceGroupsService`, `groupNameOf` (Task 1).

- [ ] **Step 1: Write the failing tests.**
  - `connects only wanted hosts at startup`: a host only in a collapsed group stays untouched (`getState` is `undefined`).
  - `expanding a group connects its hosts in the background`.
  - `does not retry a failed host when its group is expanded`.
  - `disconnects a host idle for the delay after its group collapses`: with delay 300, nothing happens at 299 s and a disconnect happens at 300 s.
  - `wanted again before the delay keeps the host connected` (no disconnect, no reconnect).
  - `a host without roots used only by a terminal is never idle-disconnected`.
  - `removing a host's last root still disconnects it immediately`.
  - Status: `Hosts n/m counts wanted hosts`; `the picker lists idle hosts with roots as Not connected and Connect calls connect`.
  - Decorations: `a group with a failed host shows ! with each host's state in the tooltip`; `an expanded group with a connecting host shows …`; `a collapsed group shows no letter`.
- [ ] **Step 2:** `./scripts/test.sh --grep "MultiRemoteWorkspace"`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - On startup, on trust granted, and on `hostDemand.onDidChange`, connect each wanted host whose state is `undefined` or `Disconnected`.
  - Keep `Map<lowercased authority, IDisposable>` timers. An unwanted host that has roots and is `Connecting/Connected/Reconnecting` gets a timer for `delay * 1000` ms, unless it has one. When the timer fires, it re-checks `isWanted` before `disconnect`. A host that is wanted again has its timer cancelled.
  - The decorations provider also answers `supercode-group:` URIs, from the group's hosts and `getState`.
- [ ] **Step 4:** Re-run with `--grep "MultiRemote|HostDemand"`. Expected: PASS.
- [ ] **Step 5: Commit** `multiRemote: connect hosts of expanded groups and disconnect idle ones`.

---

### Task 5: Group level in the Explorer tree

**Files:**
- Create: `src/vs/workbench/contrib/files/common/explorerGroupItem.ts`
- Modify: `src/vs/workbench/contrib/files/common/files.ts` (context key `ExplorerGroupContext = new RawContextKey<boolean>('explorerResourceIsGroup', false)`)
- Modify: `src/vs/workbench/contrib/files/browser/views/explorerView.ts` (`setTreeInput`, collapse sync, `selectResource`, `collapseAll`, `getContext`, focus → context keys and `setFocusedGroup`, context menu)
- Modify: `src/vs/workbench/contrib/files/browser/views/explorerViewer.ts` (renderer: label and description for groups; `ExplorerCompressionDelegate`: groups are incompressible)
- Test: `src/vs/workbench/contrib/files/test/browser/explorerGroupItem.test.ts` (suite `ExplorerGroupItem`)

**Interfaces:**
- Consumes: `IWorkspaceGroupsService`, `groupResource` (Task 1).
- Produces:
  - `class ExplorerGroupItem extends ExplorerItem`, with `constructor(group: IWorkspaceGroup, roots: ExplorerItem[], fileService, configService, filesConfigService)`. It has `resource = groupResource(group.name)`, `isDirectory = true`, `readonly = true`, `name = group.name`; it overrides `isRoot` to return `false` and `fetchChildren()` to return `roots`; and it exposes `readonly groupName: string` and `readonly roots: ExplorerItem[]`.
  - `isExplorerGroupItem(item: unknown): item is ExplorerGroupItem`.
  - `const ExplorerGroupContextMenu = new MenuId('ExplorerGroupContext')` (exported from `explorerGroupItem.ts`).

- [ ] **Step 1: Write the failing tests.**
  - `group item is not a root and lists its roots as children`.
  - `group item id is stable for a name` (`getId()` equals `groupResource(name).toString()`).
  - `roots inside a group keep isRoot true`.
  - `ExplorerView` (extend `explorerView.test.ts`): `getContext drops group items`.
- [ ] **Step 2:** `./scripts/test.sh --grep "ExplorerGroupItem|ExplorerView"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `setTreeInput`: when `groups.length > 0`, input = `[...groupItems, ...ungroupedRoots]`. After `setInput`, expand or collapse each group to match `groups[i].collapsed`.
  - The "expand up to five roots" and "expand newly added roots" loops skip group items. They expand a new root only if it is ungrouped or its group is expanded.
  - `tree.onDidChangeCollapseState` on a group calls `setCollapsed`. `groupsService.onDidChange` calls `setTreeInput`. Only call `expand`/`collapse` when the state differs, to avoid loops.
  - `selectResource`: if the resource's root sits in a collapsed group, expand the group only when `reveal === 'force'`; otherwise return without selecting.
  - `collapseAll` also collapses every group.
  - On focus, set `ExplorerGroupContext`; for a group, set `ExplorerFolderContext` and `ExplorerRootContext` to false. Call `setFocusedGroup` with the focused group or the group of the focused item's root.
  - Right-clicking a group opens `ExplorerGroupContextMenu` instead of `MenuId.ExplorerContext`.
  - Renderer: a group shows its name with `FileKind.ROOT_FOLDER` and the root count as the description.
- [ ] **Step 4:** Re-run, then run `./scripts/code.sh` with a hand-written `.code-workspace` holding two groups. Check by eye that the groups render, expand and collapse states survive a reload, and a workspace without the key looks unchanged.
- [ ] **Step 5: Commit** `explorer: show workspace groups above their roots`.

---

### Task 6: Group commands and menus

**Files:**
- Create: `src/vs/workbench/contrib/multiRemote/browser/workspaceGroupsActions.ts` (registered from `multiRemote.contribution.ts`)
- Test: `src/vs/workbench/contrib/multiRemote/test/browser/workspaceGroupsActions.test.ts` (suite `WorkspaceGroupsActions`)

**Interfaces:**
- Consumes: `IWorkspaceGroupsService`, `ExplorerGroupItem`/`ExplorerGroupContextMenu`/`ExplorerGroupContext` (Task 5), `AddRemoteFolderToWorkspaceAction.ID` flow (`multiRemoteActions.ts`).
- Produces these command IDs. When a command is invoked from a group node, its first argument is the group's resource URI. The integration test passes the listed arguments.

| ID | Title | Menus | Programmatic args |
|---|---|---|---|
| `supercode.workspaceGroups.add` | Add Workspace… | Explorer view title (`navigation`), Command Palette, `MenubarFileMenu` next to Add Folder to Workspace | `{ name: string }` creates an empty group; `{ file: URI }` imports |
| `supercode.workspaceGroups.addFolder` | Add Folder to Group… | group menu | – |
| `supercode.workspaceGroups.addSshFolder` | Add SSH Folder to Group… | group menu | – |
| `supercode.workspaceGroups.rename` | Rename Group | group menu, `F2` when `explorerResourceIsGroup && filesExplorerFocus` | – |
| `supercode.workspaceGroups.remove` | Remove Group | group menu (confirm dialog) | – |
| `supercode.workspaceGroups.ungroup` | Ungroup | group menu | `(groupName: string)` |
| `supercode.workspaceGroups.moveTo` | Move to Group… | `MenuId.ExplorerContext` when `explorerResourceIsRoot` and groups are enabled | `(folder: URI, groupName: string \| undefined)` |
| `supercode.workspaceGroups.newTerminal` | New Terminal in Group | group menu | – |
| `_workspaceGroups.setCollapsed` | (hidden) | – | `(groupName: string, collapsed: boolean)` |
| `_multiRemote.getHostStates` | (hidden) | – | returns `{ authority: string; state: 'connecting' \| 'connected' \| 'reconnecting' \| 'disconnected' \| 'failed' \| 'none' }[]` for `getRootHosts()` |

- All group commands are hidden in remote windows. Add Workspace is shown in local folder, empty and workspace windows. Commands that act on a group need `explorerResourceIsGroup`.
- **Add Workspace:** a quick pick with "Import .code-workspace File…" (local `showOpenDialog`, filter `code-workspace`) and "New Empty Group…" (input box validated by `validateGroupName`). After an import, show an info message listing the skipped folders, if any. Errors use `notificationService.error`.
- **Add SSH Folder to Group:** run the existing SSH host pick → `AddRemoteFolderToWorkspaceAction` flow with the group focused, so Task 2's focused-group rule places the folder. Check this in the test with a stubbed command service.
- **New Terminal in Group:** offer the group's roots in the existing root picker, then `terminalService.createTerminal({ config: { cwd: root } })`.

- [ ] **Step 1: Write the failing tests:** `add with a name creates an empty group`, `add with a file imports and reports skipped folders`, `add rejects a remote workspace file with a message`, `rename validates the name`, `remove asks for confirmation and removes the roots`, `ungroup keeps the roots`, `moveTo moves a root`, `newTerminal offers only the group's roots`, `getHostStates reports none for untouched hosts`.
- [ ] **Step 2:** `./scripts/test.sh --grep "WorkspaceGroupsActions"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Re-run. Expected: PASS. Then in `./scripts/code.sh`: import two workspace files, rename one, ungroup one, and remove one. Check that the `.code-workspace` file content matches after each step.
- [ ] **Step 5: Commit** `workspaceGroups: add Add Workspace and group commands`.

---

### Task 7: Drag and drop roots between groups

**Files:**
- Modify: `src/vs/workbench/contrib/files/browser/views/explorerViewer.ts` (`ExplorerDragAndDrop.onDragOver` ~l.1581, `drop` ~l.1763)
- Test: extend `src/vs/workbench/contrib/files/test/browser/explorerView.test.ts` or a new `explorerGroupDnd.test.ts` (suite `ExplorerGroupDragAndDrop`)

**Interfaces:**
- Consumes: `isExplorerGroupItem`, `IWorkspaceGroupsService.moveFolder`.
- Produces: a drop decision helper, `getGroupDropTarget(dragged: readonly ExplorerItem[], target: ExplorerItem | undefined, groupsService: IWorkspaceGroupsService): { move: true; group: string | undefined } | { move: false } | undefined`. It returns `undefined` when group drag-and-drop doesn't apply, so the existing logic runs.

- [ ] **Step 1: Write the failing tests** for `getGroupDropTarget`:
  - roots dropped on a group → move into that group;
  - roots dropped on a root inside a group → that root's group;
  - roots dropped on an ungrouped root or on empty space (`target === undefined`) → move to `undefined` (ungroup);
  - files (non-roots) dropped on a group → `{ move: false }`;
  - a group being dragged → `{ move: false }`;
  - no groups exist → `undefined`.
- [ ] **Step 2:** `./scripts/test.sh --grep "ExplorerGroupDragAndDrop"`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper in `explorerGroupItem.ts`. Call it first in `onDragOver`/`drop`: `move: false` → reject, `move: true` → `moveFolder` for each dragged root.
- [ ] **Step 4:** Re-run. Then drag by hand in `./scripts/code.sh`: today's reordering of ungrouped roots still works when there are no groups.
- [ ] **Step 5: Commit** `explorer: move roots between workspace groups by drag and drop`.

---

### Task 8: Integration tests, manual checklist, README

**Files:**
- Create: `extensions/vscode-api-tests/src/multiremote-tests/workspaceGroups.test.ts` (suite `workspace groups`, same runner as `multiRemote.test.ts`)
- Modify: `docs/supercode/manual-test.md`, `/Users/linh/Documents/Projects/supercode/README.md`

- [ ] **Step 1: Write the integration tests.** In `setup`, close all editors and terminals and set `multiRemote.idleDisconnectDelay` to `1` (Global). `multiRemote.test.ts` kills `test+b`'s server, so if `test+b` reports `failed`, restart it the way that suite's own recovery does (check `vscode-testresolver` commands), then run `ReconnectHostAction.ID` with its authority. In `teardown`, ungroup, reset the setting, and close editors.
  - `a collapsed group's host disconnects and stays disconnected`: `add {name:'g-b'}`, then `moveTo(rootB,'g-b')`. Poll `_multiRemote.getHostStates` until `test+b` is `disconnected` (≤ 10 s). `workspace.fs.stat(rootB)` rejects as unavailable, and `test+b` is still `disconnected` 2 s later.
  - `expanding a group connects its host and lists its root`: `_workspaceGroups.setCollapsed('g-b', false)` → poll `connected`; `workspace.fs.readDirectory(rootB)` succeeds.
  - `opening a file from a collapsed group's host connects it`: collapse, wait for `disconnected`, run `vscode.open` on a file in `rootB`, poll `connected`, and the file's text loads.
  - `the workspace file stores the group`: parse `workspace.workspaceFile` → `"supercode.groups"` has `g-b` with `rootB.toString()`.
  - `test+a stays connected throughout` (ungrouped).
- [ ] **Step 2:** `./scripts/test-multi-remote-integration.sh`. Expected: new and existing suites PASS.
- [ ] **Step 3:** Add rows to `manual-test.md`:
  - import 3 workspace files with real hosts;
  - collapsed groups don't connect at startup (Hosts n/m);
  - expand → connect;
  - collapse → disconnect after 5 min;
  - drag a root between groups;
  - a stock VS Code edit of the file is reconciled.

  Update the README: describe groups under "What it does" and "Using it", add `services/workspaceGroups/*` and `hostDemand.ts` to the "How it works" table, and add the setting.
- [ ] **Step 4:** Run the full unit grep `./scripts/test.sh --grep "WorkspaceGroups|HostDemand|MultiRemote|RemoteFileSystemRouter|Explorer"` and `./scripts/test-remote-integration.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `workspaceGroups: integration tests, manual checklist and docs`.

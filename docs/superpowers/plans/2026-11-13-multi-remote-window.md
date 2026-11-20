# Multi-host Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code fork where one local window holds local folders plus folders on several SSH hosts, with explorer, editing and terminals working on all of them at once.

**Architecture:** The window stays local. A new `IMultiRemoteService` opens one management-only connection (no remote extension host) per SSH host, reusing VS Code's existing `RemoteAgentConnection` and server. A `vscode-remote` file system router dispatches each call by URI authority to that host's `RemoteFileSystemProviderClient`; terminals get one `RemoteTerminalBackend` per host. A vendored open-remote-ssh extension resolves `ssh-remote+<host>` authorities with the system OpenSSH binary and installs the fork's server on each host.

**Tech Stack:** TypeScript, Electron, VS Code workbench DI/services, mocha (tdd UI) unit tests, VS Code extension integration tests, `vscode-test-resolver`, open-remote-ssh (MIT), gulp packaging.

**Spec:** `/Users/linh/Documents/Projects/supercode/docs/superpowers/specs/2026-11-13-multi-remote-window-design.md`

## Global Constraints

- Code lives in `/Users/linh/Documents/Projects/supercode/vscode`, branch `multi-host` created from `daa23473`. Paths below are relative to that folder.
- Node `24.22.1` (from `.nvmrc`), `pnpm`. Local machine: macOS arm64 only.
- Remote platforms: `linux-x64`, `linux-arm64`, `alpine-x64` (gulp target `linux-alpine`), `alpine-arm64`. 32-bit ARM (`armv7l`/`armhf`) is rejected with a clear message.
- Multi-host behaviour is active **only** when `IWorkbenchEnvironmentService.remoteAuthority` is `undefined` and `!isWeb`. Single-remote windows and the web build behave exactly as before.
- A host's identity is the `vscode-remote` URI authority (e.g. `ssh-remote+devbox`), compared **case-insensitively** everywhere (map keys are `authority.toLowerCase()`).
- Nothing in the startup path awaits the network. A call for a host that is not connected fails immediately with `FileSystemProviderErrorCode.Unavailable`.
- Hosts in the workspace connect automatically in the background when the window opens and when a remote folder is added.
- SSH is non-interactive: open-remote-ssh's `native` backend with `-o BatchMode=yes -o ConnectTimeout=15`. A host that would need a password or passphrase fails with a message; it never prompts.
- No per-host settings layer. Each host's terminal uses that host's login shell unless the user set a profile.
- Every new `.ts` file starts with the standard Microsoft MIT header copied from a neighbouring file; user-visible strings go through `localize`; respect layer folders (`common` ↛ `browser` ↛ `electron-browser`).
- Before each commit: `pnpm exec eslint <changed files>` and `pnpm run valid-layers-check` pass. Commit messages end with the session attribution lines.
- Unit tests run with `./scripts/test.sh --grep "<suite name>"` against compiled output; keep `pnpm run watch` running (or run `pnpm run compile` first).

## Deviations from the spec (decided while planning)

- **Explorer reconnect:** the explorer has no inline actions on items, so "Reconnect" is in the explorer root's **context menu** and in the Hosts status bar picker, not an inline button.
- **Restored editors:** an editor for a host that hasn't connected yet shows VS Code's normal "could not open" pane with the host named in the message. It **reloads automatically** when the host connects, instead of using a custom "connecting…" placeholder.
- **Add SSH Folder UI:** the host picker lives in the vendored SSH extension, because it owns `~/.ssh/config` parsing and authority encoding. It calls a core command that does the connect → folder dialog → add root steps.
- **Product identity:** the fork uses its own `applicationName`/`dataFolderName`/`serverDataFolderName` (`supercode`, `.supercode`, `.supercode-server`) so it never clashes with an installed VS Code.

## Review Focus

1. **Same host spelled differently / two hosts with the same path.** `ssh-remote+DevBox` and `ssh-remote+devbox` must be one host, and `/srv/app` on two hosts must never cross-wire. Tests: Task 2 `authority keys are case-insensitive`, Task 3 `routes each call to the client of the URI authority`.
2. **Dragging or moving a file from host A to host B.** Expected: a clear error and nothing changed on either host. Test: Task 3 `rename and copy across hosts fail without touching either host`.
3. **A host drops while you save.** Expected: the save fails with an error naming the host, the editor stays dirty, and a save after reconnecting works. Tests: Task 3 `unconnected host fails fast with Unavailable`; Task 7 `saving to a dead host fails and leaves other hosts working`.
4. **Opening the workspace while one host is unreachable or would ask for a password.** Expected: the window opens, other roots work, that root shows failed, and no prompt appears. Tests: Task 5 `connects every remote root at startup without awaiting`; Task 8 `native ssh args are non-interactive`.
5. **After updating the fork, a host still has the old server.** Expected: the new commit's server is installed next to the old one, with no "version mismatch" dead end. Test: Task 9 `install directory is keyed by commit`.

---

### Task 0: Workspace setup and green baseline

**Files:** none (environment only)

- [ ] **Step 1: Toolchain.** Run `nvm install 24.22.1 && nvm use 24.22.1 && corepack enable`. Run `brew install git-lfs && git lfs install`, because the global git config requires LFS for `extensions/copilot`. Check free disk space: at least 25 GB is needed (it was 22 GB when this plan was written). Stop and tell the user if there's less.
- [ ] **Step 2: Branch.** `git checkout -b multi-host` (HEAD must be `daa23473`).
- [ ] **Step 3: Install and compile.** Run `pnpm install && pnpm run compile`. Expected: exits 0.
- [ ] **Step 4: Baseline tests.** Run `./scripts/test.sh --grep "TerminalInstanceService|TerminalProcessManager|ExtensionService"`. Expected: all pass. Record any test that already fails on this commit so later tasks don't get blamed for it.

---

### Task 1: Resolve any remote authority on demand

**Files:**
- Modify: `src/vs/workbench/services/extensions/common/extensions.ts` (`IExtensionService` ~l.415, `NullExtensionService` ~l.598)
- Modify: `src/vs/workbench/services/extensions/common/abstractExtensionService.ts` (near `_resolveAuthorityAgain`, ~l.675)
- Test: `src/vs/workbench/services/extensions/test/browser/extensionService.test.ts`

**Interfaces:**
- Produces: `IExtensionService.resolveRemoteAuthority(remoteAuthority: string): Promise<void>`. It resolves through the local-process extension host's resolver extensions and publishes the result to `IRemoteAuthorityResolverService`, so `resolveAuthority(remoteAuthority)` callers complete. On failure it publishes the error with `_setResolvedAuthorityError` and rethrows.

- [ ] **Step 1: Write failing tests** in the existing suite, using `MyTestExtensionService` with a settable resolve hook:
  - `resolveRemoteAuthority publishes the resolved authority`: the hook returns `{ authority: { authority: 'test+a', connectTo: new WebSocketRemoteConnection('127.0.0.1', 9001), connectionToken: 'tok' } }`. After `await service.resolveRemoteAuthority('test+a')`, `(await resolverService.resolveAuthority('test+a')).authority.connectTo` deep-equals `{ type: WebSocket, host: '127.0.0.1', port: 9001 }`.
  - `resolveRemoteAuthority publishes and rethrows errors`: the hook throws `new RemoteAuthorityResolverError('nope', RemoteAuthorityResolverErrorCode.NotAvailable)`. Both `service.resolveRemoteAuthority('test+b')` and `resolverService.resolveAuthority('test+b')` reject with code `NotAvailable`.
- [ ] **Step 2: Run** `./scripts/test.sh --grep "ExtensionService"`. Expected: FAIL, `resolveRemoteAuthority is not a function`.
- [ ] **Step 3: Implement.** Add the method to the interface. `NullExtensionService` rejects with `new Error('Not supported')`. `AbstractExtensionService`: `await this.whenInstalledExtensionsRegistered()`. Then call `this._remoteAuthorityResolverService.resolveAuthority(a).catch(() => {})` so a pending request exists for `_setResolvedAuthority` to complete. Then call `_resolveAuthorityInitial(a)` (it retries 5×) and `_setResolvedAuthority(result.authority, result.options)`; on error, `_setResolvedAuthorityError` and rethrow.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with message `extensions: resolve additional remote authorities on demand`.

---

### Task 2: `IMultiRemoteService` — one connection per host

**Files:**
- Modify: `src/vs/workbench/services/remote/common/abstractRemoteAgentService.ts` (export `class RemoteAgentConnection`; no behaviour change)
- Create: `src/vs/workbench/services/remote/common/multiRemoteService.ts` (interface, enum, decorator)
- Create: `src/vs/workbench/services/remote/browser/multiRemoteService.ts` (implementation + `registerSingleton(IMultiRemoteService, MultiRemoteService, InstantiationType.Delayed)`)
- Modify: `src/vs/workbench/workbench.common.main.ts` (import the browser file)
- Test: `src/vs/workbench/services/remote/test/browser/multiRemoteService.test.ts`

**Interfaces:**
- Consumes: Task 1 `resolveRemoteAuthority`.
- Produces (in `common/multiRemoteService.ts`):
```ts
export const IMultiRemoteService = createDecorator<IMultiRemoteService>('multiRemoteService');
export const enum RemoteHostState { Connecting = 'connecting', Connected = 'connected', Reconnecting = 'reconnecting', Disconnected = 'disconnected', Failed = 'failed' }
export interface IRemoteHostStatus { readonly authority: string; readonly state: RemoteHostState; readonly error?: string }
export interface IRemoteHostConnection { readonly authority: string; readonly connection: IRemoteAgentConnection; readonly environment: IRemoteAgentEnvironment }
export interface IMultiRemoteService {
  readonly _serviceBrand: undefined;
  readonly isEnabled: boolean;                       // !environment.remoteAuthority && !isWeb
  readonly onDidChangeHostState: Event<IRemoteHostStatus>;
  getHosts(): readonly IRemoteHostStatus[];
  getState(authority: string): RemoteHostState | undefined;
  getConnected(authority: string): IRemoteHostConnection | undefined;
  connect(authority: string): Promise<IRemoteHostConnection>;   // idempotent; in-flight promise shared; on Failed/Disconnected starts a fresh connection
  disconnect(authority: string): Promise<void>;
  isSecondary(authority: string | undefined): boolean;          // true iff enabled, authority defined and != primary
  getEnvironment(authority: string | undefined): Promise<IRemoteAgentEnvironment | null>; // undefined/primary → IRemoteAgentService.getEnvironment(); secondary → connected env (connects if needed)
}
```
- The implementation has two protected seams for tests: `_createConnection(authority: string): IRemoteAgentConnection` (default `new RemoteAgentConnection(authority, product.commit, product.quality, …)`) and `_fetchEnvironment(connection: IRemoteAgentConnection): Promise<IRemoteAgentEnvironment>` (default `RemoteExtensionEnvironmentChannelClient.getEnvironmentData(connection.getChannel('remoteextensionsenvironment'), authority, profileId)`, then `_setAuthorityConnectionToken`).
- Connection lifecycle, mirroring the primary at `nativeExtensionService.ts:425-431`:
  - `ConnectionLost` → `_clearResolvedAuthority(a)`, state `Reconnecting`.
  - `onReconnecting` → `resolveRemoteAuthority(a)`.
  - `ConnectionGain` → `Connected`.
  - `ReconnectionPermanentFailure` → `Failed`, connection disposed.

- [ ] **Step 1: Write failing tests** (suite `MultiRemoteService`). Use a test subclass with a fake connection whose `onDidStateChange`/`onReconnecting` are emitters you fire:
  - `is disabled in a remote window`: environment `remoteAuthority = 'ssh-remote+primary'`. `isEnabled === false`; `connect('ssh-remote+b')` rejects.
  - `connect goes connecting → connected and returns the environment`: recorded states equal `['connecting', 'connected']`; `result.environment.userHome.path === '/home/a'`.
  - `concurrent connect calls share one connection`: two parallel `connect('ssh-remote+a')` calls; `_createConnection` is called once.
  - `authority keys are case-insensitive`: `connect('ssh-remote+DevBox')` then `getConnected('ssh-remote+devbox')` is defined; one connection created.
  - `resolver failure marks only that host failed`: resolve rejects for `+b` only. States are `+a: connected`, `+b: failed`, and `+b`'s `error` contains the resolver message.
  - `connection lost → reconnecting → connected`: fire `ConnectionLost`; state `reconnecting` and `_clearResolvedAuthority` called with `'ssh-remote+a'`. Fire `ConnectionGain`; state `connected`.
  - `permanent failure then connect creates a new connection`: fire `ReconnectionPermanentFailure`; state `failed`; `connect` again → `_createConnection` call count 2.
  - `getEnvironment delegates to the primary for undefined`: `getEnvironment(undefined)` returns the stubbed `IRemoteAgentService.getEnvironment()` value.
  - `disconnect ends and disposes the connection`: `end()` called; state `disconnected`.
- [ ] **Step 2: Run** `./scripts/test.sh --grep "MultiRemoteService"`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the interface file, then `MultiRemoteService extends Disposable`, using the signatures above. Host map: `Map<string /*lowercased*/, { status, connectPromise?, host?, disposables }>`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `pnpm run valid-layers-check`.
- [ ] **Step 5: Commit** with message `remote: add IMultiRemoteService for per-host management connections`.

---

### Task 3: `vscode-remote` file system router

**Files:**
- Modify: `src/vs/workbench/services/remote/common/remoteFileSystemProviderClient.ts` (add `static create(environment: IRemoteAgentEnvironment, connection: IRemoteAgentConnection): RemoteFileSystemProviderClient`)
- Create: `src/vs/workbench/services/remote/browser/remoteFileSystemRouter.ts`
- Create: `src/vs/workbench/contrib/multiRemote/browser/multiRemote.contribution.ts` (registers contributions for Tasks 3–6)
- Modify: `src/vs/workbench/workbench.desktop.main.ts` (import `./contrib/multiRemote/browser/multiRemote.contribution.js`)
- Test: `src/vs/workbench/services/remote/test/browser/remoteFileSystemRouter.test.ts`

**Interfaces:**
- Consumes: Task 2 `IMultiRemoteService` (`getConnected`, `getState`, `connect`, `onDidChangeHostState`).
- Produces: `class RemoteFileSystemRouter extends Disposable`. It implements the same provider interfaces as `DiskFileSystemProviderClient` (`platform/files/common/diskFileSystemProviderClient.ts:24-33`), with constructor `(multiRemoteService: IMultiRemoteService, createClient: (host: IRemoteHostConnection) => DiskFileSystemProviderClient = h => RemoteFileSystemProviderClient.create(h.environment, h.connection))`.
- Capabilities: the same constant set as `DiskFileSystemProviderClient` plus `PathCaseSensitive`, without `Trash`.
- Behaviour:
  - Each call is routed to the client for `uri.authority`. Clients are created or recreated when the host's `IRemoteHostConnection.connection` object changes.
  - An unconnected host (state `Connecting`/`Reconnecting`/`undefined`): start `connect()` if the state is `undefined`, then throw `createFileSystemProviderError(localize('hostNotConnected', "{0} is not connected yet.", hostLabel), FileSystemProviderErrorCode.Unavailable)`.
  - A `Failed`/`Disconnected` host: throw `Unavailable` and don't reconnect. The user reconnects explicitly.
  - `rename`/`copy`/`renameFileAtomic`/`cloneFile` whose source and target authorities differ throw `localize('crossHost', "Moving or copying between different remote machines isn't supported yet.")` before calling any client.
  - Router file descriptors come from a router-level counter mapped to `{ client, innerFd }`.
  - The router remembers active `watch` requests and re-issues them on the new client when a host reconnects. `onDidChangeFile`/`onDidWatchError` merge all clients.
  - `readFileStream` for an unconnected host returns a stream that errors with the same `Unavailable` error.
- `MultiRemoteFileSystemContribution` (`WorkbenchPhase.BlockStartup`): if `multiRemoteService.isEnabled`, `fileService.registerProvider(Schemas.vscodeRemote, router)`.

- [ ] **Step 1: Write failing tests** (suite `RemoteFileSystemRouter`), with two fake clients and a stub multi-remote service:
  - `routes each call to the client of the URI authority`: `stat(vscode-remote://ssh-remote+a/srv/app)` hits client A only; the same path on `+b` hits B only.
  - `authority match is case-insensitive`: `ssh-remote+A` routes to A's client.
  - `unconnected host fails fast with Unavailable`: state `undefined` → `readFile` rejects with `toFileSystemProviderErrorCode(e) === Unavailable`, the message contains the host, and `connect` is called once.
  - `failed host fails fast without reconnecting`: state `failed` → rejects `Unavailable`; `connect` is not called.
  - `rename and copy across hosts fail without touching either host`: both reject with the cross-host message; neither client got a call.
  - `file descriptors from two hosts never collide`: both clients return fd `1`; the router fds differ; `read(routerFdB, …)` calls B with fd `1`; after `close`, the router fd is released.
  - `watches are re-established when a host reconnects`: `watch` on A; fire a state change with a new connection object; the new client's `watch` is called with the same resource and options.
  - `file change events from all hosts are forwarded`: events fired by A and B both reach `router.onDidChangeFile`.
- [ ] **Step 2: Run** `./scripts/test.sh --grep "RemoteFileSystemRouter"`. Expected: FAIL.
- [ ] **Step 3: Implement** the router, `RemoteFileSystemProviderClient.create`, and the contribution file with `MultiRemoteFileSystemContribution` registered via `registerWorkbenchContribution2`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Run `pnpm run valid-layers-check`.
- [ ] **Step 5: Commit** with message `remote: route vscode-remote file system calls by host in local windows`.

---

### Task 4: Terminals on any connected host

**Files:**
- Modify: `src/vs/platform/terminal/common/terminal.ts` (~l.1250–1282: add `unregisterTerminalBackend(remoteAuthority: string | undefined): void` to `ITerminalBackendRegistry` and `TerminalBackendRegistry`)
- Modify: `src/vs/workbench/contrib/terminal/browser/remoteTerminalBackend.ts` (export `RemoteTerminalBackend`; replace the `IRemoteAgentService` uses at ~l.169, 292–296, 309 with `IMultiRemoteService.getEnvironment(this.remoteAuthority)` and `this.remoteAuthority`)
- Modify: `src/vs/workbench/contrib/terminal/browser/terminalInstanceService.ts` (`getBackend` ~l.86; `_backendRegistration` keys lowercased)
- Modify: `src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts` (~l.286 and ~l.627: environment from `IMultiRemoteService.getEnvironment(this.remoteAuthority)`)
- Modify: `src/vs/platform/terminal/common/terminalEnvironment.ts` (add a helper)
- Modify: `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts` (set `hostLabel` after the process manager is created)
- Create: `src/vs/workbench/contrib/multiRemote/browser/multiRemoteTerminal.ts`
- Tests: `src/vs/workbench/contrib/terminal/test/browser/terminalInstanceService.test.ts`, `terminalProcessManager.test.ts`, `src/vs/platform/terminal/test/common/terminalEnvironment.test.ts`

**Interfaces:**
- Consumes: Task 2 (`connect`, `getEnvironment`, `isSecondary`, `onDidChangeHostState`, `getConnected`).
- Produces:
  - `getSecondaryHostLabel(remoteAuthority: string | undefined, primaryAuthority: string | undefined, getHostLabel: (authority: string) => string): string | undefined` in `terminalEnvironment.ts`. It returns `undefined` for local or primary terminals.
  - `TerminalInstance` sets `shellLaunchConfig.hostLabel` (shown by the default `${host}` in `terminal.integrated.tabs.description`) when the label is unset, using `labelService.getHostLabel(Schemas.vscodeRemote, authority)`.
  - `MultiRemoteTerminalContribution` (`WorkbenchPhase.AfterRestored`): on `Connected` with a new connection object, unregister any old backend for that authority. Then register `new RemoteTerminalBackend(authority, new RemoteTerminalChannelClient(authority, connection.getChannel(REMOTE_TERMINAL_CHANNEL_NAME)))`, call `terminalInstanceService.didRegisterBackend(backend)` and `backend.setReady()` (no revival in v1).
  - Command `workbench.action.terminal.newOnRemoteHost` (title "New Terminal on Remote Host…"): picks a connected host, then `terminalService.createTerminal({ config: { cwd } })`. `cwd` is the host's first workspace root, or else `vscode-remote://<authority><environment.userHome.path>`. It also appears in `MenuId.TerminalNewDropdownContext`.
- `getBackend(remoteAuthority)`: if no backend is registered and `multiRemoteService.isSecondary(remoteAuthority)`, `await connect(remoteAuthority)`, then await the lazily created registration promise for that lowercased key.

- [ ] **Step 1: Write failing tests:**
  - `TerminalBackendRegistry`: `unregisterTerminalBackend allows re-registering the same authority` (register `+a`, unregister `'SSH-REMOTE+A'`, register `+a` again: no throw).
  - `TerminalInstanceService`: `getBackend connects a secondary host on demand`. The stub `connect` registers a fake backend for `ssh-remote+b` and calls `didRegisterBackend`; the result is that backend and `connect` was called once. `getBackend does not connect when multi-remote is disabled` (`isSecondary` → false): resolves `undefined` and `connect` was not called.
  - `TerminalProcessManager`: `uses the secondary host's OS and home`. Stub `IMultiRemoteService.getEnvironment('ssh-remote+b')` → `{ os: OperatingSystem.Linux, userHome: URI.file('/home/b') }`, and use a cwd of `vscode-remote://ssh-remote+b/srv`. Expect `manager.remoteAuthority === 'ssh-remote+b'`, `manager.os === OperatingSystem.Linux`, `manager.userHome === '/home/b'`.
  - `terminalEnvironment`: `getSecondaryHostLabel` returns `'devbox'` for (`'ssh-remote+devbox'`, `undefined`, `a => 'devbox'`). It returns `undefined` for (`undefined`, `undefined`, …) and for (`'ssh-remote+x'`, `'ssh-remote+X'`, …).
- [ ] **Step 2: Run** `./scripts/test.sh --grep "TerminalBackendRegistry|TerminalInstanceService|TerminalProcessManager|terminalEnvironment"`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the modifications listed under Files and the new contribution and command. Register the contribution in `multiRemote.contribution.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS, including all pre-existing tests in those suites (the primary remote path is unchanged).
- [ ] **Step 5: Commit** with message `terminal: one remote terminal backend per connected host`.

---

### Task 5: Background connect at startup, refresh on connect, root status

**Files:**
- Create: `src/vs/workbench/contrib/multiRemote/browser/multiRemoteWorkspace.ts`
- Modify: `src/vs/workbench/contrib/multiRemote/browser/multiRemote.contribution.ts`
- Test: `src/vs/workbench/contrib/multiRemote/test/browser/multiRemoteWorkspace.test.ts`

**Interfaces:**
- Consumes: Task 2 service; `IWorkspaceContextService`, `IWorkbenchConfigurationService.reloadConfiguration(folder)`, `IExplorerService.refresh()`, `IEditorGroupsService`, `IDecorationsService`.
- Produces:
  - `MultiRemoteWorkspaceContribution` (`WorkbenchPhase.BlockStartup`; constructor must not await). It calls `void connect(a)` for every distinct `vscode-remote` authority among workspace folders, at construction and on `onDidChangeWorkspaceFolders` (added folders).
  - On a host reaching `Connected`:
    - `reloadConfiguration(folder)` for each root of that host;
    - `explorerService.refresh()`;
    - for each group whose `activeEditor?.resource?.authority` matches (case-insensitive), `group.openEditor(group.activeEditor, { preserveFocus: true, forceReload: true })`.
  - A decorations provider for workspace-root URIs of hosts not `Connected`:
    - `Connecting`/`Reconnecting`: letter `…`, tooltip "Connecting to {host}…";
    - `Failed`: letter `!`, color `listErrorForeground`, tooltip "{host}: {error}";
    - `Disconnected`: letter `–`, tooltip "{host} is disconnected".
  - Explorer context-menu action `multiRemote.reconnectHost` ("Reconnect Host"), when `explorerResourceIsRoot && resourceScheme == vscode-remote`, calls `connect(authority)`.

- [ ] **Step 1: Write failing tests** (suite `MultiRemoteWorkspace`):
  - `connects every remote root at startup without awaiting`: workspace = local folder + `ssh-remote+a` + `ssh-remote+b` (two roots on `+a`). `connect` returns never-settling promises; the contribution constructor returns, and `connect` was called exactly for `['ssh-remote+a', 'ssh-remote+b']`.
  - `local folders never trigger connect`: a local-only workspace leads to zero `connect` calls.
  - `adding a remote folder connects its host`: fire `onDidChangeWorkspaceFolders` with an added `ssh-remote+c` root, and `connect('ssh-remote+c')` is called.
  - `reloads configuration only for the connected host's roots`: fire `Connected` for `+a`; `reloadConfiguration` was called with the two `+a` folders only.
  - `failed host decorates its roots`: state `failed` with error `'Permission denied'` gives a decoration with letter `!` and a tooltip containing `Permission denied`.
- [ ] **Step 2: Run** `./scripts/test.sh --grep "MultiRemoteWorkspace"`. Expected: FAIL.
- [ ] **Step 3: Implement** the contribution, decorations provider and action, and register them.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with message `multiRemote: connect hosts in background and refresh roots on connect`.

---

### Task 6: Add-remote-folder flow and Hosts status bar

**Files:**
- Modify: `src/vs/workbench/services/dialogs/browser/simpleFileDialog.ts` (use the authority of `options.defaultUri` as the target remote when `multiRemoteService.isSecondary(defaultUri.authority)`, and take the home path from `multiRemoteService.getEnvironment(authority)`)
- Create: `src/vs/workbench/contrib/multiRemote/browser/multiRemoteActions.ts`
- Create: `src/vs/workbench/contrib/multiRemote/browser/multiRemoteStatus.ts`
- Test: `src/vs/workbench/contrib/multiRemote/test/browser/multiRemoteActions.test.ts`

**Interfaces:**
- Consumes: Task 2; Task 4's `workbench.action.terminal.newOnRemoteHost`; Task 5's `multiRemote.reconnectHost`.
- Produces:
  - Command `workbench.action.addRemoteFolderToWorkspace` with argument `authority: string` (required; called by the SSH extension in Task 8):
    1. `connect(authority)` inside `IProgressService` notification "Connecting to {host}…";
    2. `fileDialogService.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, defaultUri: URI.from({ scheme: Schemas.vscodeRemote, authority, path: env.userHome.path }), availableFileSystems: [Schemas.vscodeRemote] })`;
    3. `workspaceEditingService.addFolders(picked.map(uri => ({ uri })))`.
    On connect failure: `notificationService.error` naming the host, and nothing is added.
  - Status bar entry id `status.multiRemote`, left side, visible only when ≥1 remote root exists. Text: `$(remote) {connected}/{total}`. Tooltip lists each host and its state. Clicking opens a quick pick with one item per host, with buttons Reconnect / Disconnect / New Terminal, plus an item "Add SSH Folder to Workspace…" that runs `remote-ssh.addFolderToWorkspace` (Task 8).

- [ ] **Step 1: Write failing tests** (suite `MultiRemoteActions`):
  - `adds picked folders from the host's home`: env `userHome` `/home/a`. The dialog is called with a `defaultUri` where `isEqual(defaultUri, URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+a', path: '/home/a' }))` holds, and returns two URIs; `addFolders` receives both.
  - `cancelled dialog adds nothing`: the dialog returns `undefined`, and `addFolders` is not called.
  - `connection failure reports and adds nothing`: `connect` rejects with `'Host key verification failed'`. `notificationService.error` gets a message containing it; neither the dialog nor `addFolders` is called.
  - `status text counts connected hosts`: hosts `+a` connected and `+b` failed give the entry text `$(remote) 1/2`.
- [ ] **Step 2: Run** `./scripts/test.sh --grep "MultiRemoteActions"`. Expected: FAIL.
- [ ] **Step 3: Implement** the command, the status bar contribution and the `SimpleFileDialog` target-authority change, and register them.
- [ ] **Step 4: Run** the same command. Expected: PASS. (The `SimpleFileDialog` change has no unit suite; Task 10 Step 1 covers it on real hosts.)
- [ ] **Step 5: Commit** with message `multiRemote: add remote folder command and hosts status bar`.

---

### Task 7: Two "hosts" in one window — integration tests without SSH

**Files:**
- Modify: `extensions/vscode-test-resolver/src/extension.ts`. Replace the single global `extHostProcess` (l.17) with `Map<string, cp.ChildProcess>` keyed by authority; each spawned server gets its own data dir. Add command `vscode-testresolver.killServer(authority: string)`.
- Create: `extensions/vscode-api-tests/src/multiremote-tests/index.ts`, `extensions/vscode-api-tests/src/multiremote-tests/multiRemote.test.ts`
- Create: `scripts/test-multi-remote-integration.sh`. It builds a temp `.code-workspace` with folders `[<tmpLocal>, vscode-remote://test+a<tmpA>, vscode-remote://test+b<tmpB>]`, then launches like `scripts/test-remote-integration.sh` does but with `--file-uri=<workspace>`, `--enable-proposed-api=vscode.vscode-test-resolver`, and `--extensionTestsPath=…/out/multiremote-tests`.

**Interfaces:**
- Consumes: everything from Tasks 1–6, through the public `vscode` API.

- [ ] **Step 1: Write the integration tests** (mocha tdd, suite `multi-remote window`; each waits up to 30 s for both hosts):
  - `reads and writes files on two hosts and a local folder`: `vscode.workspace.fs.writeFile` of `a.txt`/`b.txt`/`l.txt` into each root, then read back. Contents are equal, and `a.txt` exists only under `tmpA`.
  - `terminals start on the right host in the root folder`: `vscode.window.createTerminal({ cwd: rootA })`, then `sendText('pwd > where.txt')`. Poll `rootA/where.txt` via `workspace.fs` until its content is `tmpA`. Same for B.
  - `watcher reports changes made on a host`: `createFileSystemWatcher(new RelativePattern(rootA, '*.txt'))`. A terminal on A runs `touch watched.txt`, and `onDidCreate` fires for `rootA/watched.txt` within 10 s.
  - `saving to a dead host fails and leaves other hosts working`: run `vscode-testresolver.killServer` with `'test+b'`. Then `workspace.fs.writeFile(rootB/x.txt)` rejects within 5 s with `FileSystemError` code `Unavailable`, and `workspace.fs.readFile(rootA/a.txt)` still succeeds.
- [ ] **Step 2: Run** `./scripts/test-multi-remote-integration.sh` before the resolver change. Expected: FAIL, because the second authority can't be resolved while the first server is running.
- [ ] **Step 3: Implement** the test-resolver changes and the launch script.
- [ ] **Step 4: Run** `./scripts/test-multi-remote-integration.sh`. Expected: 4 passing. Also run `./scripts/test-remote-integration.sh` (single remote), which must stay green to show single-remote windows are unchanged.
- [ ] **Step 5: Commit** with message `test: multi-remote integration suite with two test-resolver hosts`.

---

### Task 8: Vendored open-remote-ssh — sessions per host, non-interactive native SSH, add-folder command

**Files:**
- Create: `extensions/open-remote-ssh/**`, copied from `github.com/jeanp413/open-remote-ssh` v0.6.1, including `LICENSE` (MIT). Record the source commit in `extensions/open-remote-ssh/VENDORED.md`.
- Modify: `extensions/open-remote-ssh/src/authResolver.ts`. Move the per-connection fields of `RemoteSSHResolver` (l.212–226: `proxyConnections`, `sshConnection`, `sshAgentSock`, `proxyCommandProcess`, `agentForwardSession`, `socksTunnel`, `tunnels`, `labelFormatterDisposable`, `nativeSshKeepalive`, `nativeManager`, `nativeAskpassServer`) into `class SSHSession implements vscode.Disposable`, stored in a `SessionRegistry`.
- Create: `extensions/open-remote-ssh/src/sessionRegistry.ts`
- Modify: `extensions/open-remote-ssh/package.json` (default `remote.SSH.connectionBackend` → `"native"`; add command `remote-ssh.addFolderToWorkspace` "Add SSH Folder to Workspace…" in the command palette and in `view/title` when `view == workbench.explorer.fileView`)
- Modify: native ssh argument construction in `extensions/open-remote-ssh/src/native/*` (where `ssh` args are built)
- Modify: `product.json` (`extensionEnabledApiProposals` entry for the extension id: `["resolvers", "contribViewsRemote"]`) and the built-in extensions build list (as other `extensions/*` folders are wired in `build/gulpfile.extensions.ts`)
- Test: `extensions/open-remote-ssh/src/test/sessionRegistry.test.ts`, `extensions/open-remote-ssh/src/test/nativeArgs.test.ts` (plain node mocha, no `vscode` import)

**Interfaces:**
- Consumes: Task 6 command `workbench.action.addRemoteFolderToWorkspace(authority)`.
- Produces:
  - `class SessionRegistry<T extends { dispose(): void }> { getOrCreate(authority: string, create: () => T): T; get(authority: string): T | undefined; delete(authority: string): void; dispose(): void }`, with case-insensitive keys.
  - `buildNativeSshArgs(dest: SSHDestination, extra: string[]): string[]` (extracted pure function). It always includes `-o BatchMode=yes` and `-o ConnectTimeout=15`.
  - Command `remote-ssh.addFolderToWorkspace`: a quick pick of hosts from `~/.ssh/config` (reuse the parser behind `hostTreeView.ts`) plus "Enter user@host…". Encode the choice with the existing `SSHDestination` encoding as `ssh-remote+<encoded>`, then execute the Task 6 command with that authority.

- [ ] **Step 1: Write failing tests:**
  - `SessionRegistry keeps independent sessions per host`: `getOrCreate('ssh-remote+a')` and `getOrCreate('ssh-remote+b')` create two objects; `getOrCreate('SSH-REMOTE+A')` returns the first object with no new create call.
  - `disposing one session leaves the other`: `delete('ssh-remote+a')` disposes A only; `get('ssh-remote+b')` is still defined.
  - `native ssh args are non-interactive`: `buildNativeSshArgs(dest('me@devbox'), [])` contains the pairs `['-o', 'BatchMode=yes']` and `['-o', 'ConnectTimeout=15']`.
- [ ] **Step 2: Run** the extension's mocha tests (`pnpm -C extensions/open-remote-ssh exec mocha out/test/*.test.js` after compiling). Expected: FAIL.
- [ ] **Step 3: Implement** the vendoring, `SessionRegistry`, the `SSHSession` refactor, `buildNativeSshArgs`, the default-backend change, the add-folder command and the `product.json`/build wiring. If pnpm can't install the git dependency `ssh2` (`git+https://github.com/jeanp413/ssh2#master`), pin the npm `ssh2` release closest to it and note that in `VENDORED.md`. The `native` backend is the default either way.
- [ ] **Step 4: Run** the tests again (expected: PASS), then `pnpm run compile`. Expected: the extension compiles into the built-ins.
- [ ] **Step 5: Commit** with message `extensions: vendor open-remote-ssh with per-host sessions and non-interactive native ssh`.

---

### Task 9: Server packages for every remote platform, uploaded from the Mac

**Files:**
- Modify: `product.json`: `applicationName: "supercode"`, `dataFolderName: ".supercode"`, `serverApplicationName: "supercode-server"`, `serverDataFolderName: ".supercode-server"`, `nameShort`/`nameLong: "Supercode"`.
- Create: `scripts/supercode/build.sh`. It runs `pnpm run gulp vscode-darwin-arm64-min` and the four server targets `vscode-reh-linux-x64-min`, `vscode-reh-linux-arm64-min`, `vscode-reh-linux-alpine-min`, `vscode-reh-alpine-arm64-min` (the Alpine ones need Docker running). It tars each server folder into `~/.supercode/server-packages/<commit>/vscode-reh-<target>.tar.gz`, where `<commit>` is `git rev-parse HEAD`.
- Create: `extensions/open-remote-ssh/src/serverPackage.ts`
- Modify: `extensions/open-remote-ssh/src/serverSetup.ts` and `src/scripts/server-setup.sh`. Detect musl, and before running the install script upload the local package when the server isn't installed. The script uses `SERVER_LOCAL_TARBALL` when it is set and the file exists, instead of downloading.
- Test: `extensions/open-remote-ssh/src/test/serverPackage.test.ts`

**Interfaces:**
- Consumes: Task 8 session and native ssh exec.
- Produces:
  - `pickServerPackage(p: { kernel: string; machine: string; isMusl: boolean }): string`. It returns the tarball basename or throws `localize`d text "32-bit ARM isn't supported" / "Unsupported platform {kernel} {machine}". Mapping:
    - `Linux x86_64` → `vscode-reh-linux-x64.tar.gz`
    - `Linux aarch64` → `vscode-reh-linux-arm64.tar.gz`
    - `Linux x86_64 + musl` → `vscode-reh-linux-alpine.tar.gz`
    - `Linux aarch64 + musl` → `vscode-reh-alpine-arm64.tar.gz`
    - `armv7l` → throws
  - `serverInstallDir(dataFolder: string, commit: string): string` returns `${dataFolder}/bin/${commit}`.
  - The upload streams the local file over the session's native ssh: `cat > <dataFolder>/<commit>-<basename>`. A missing local package fails with "No server package for {platform} in {dir}. Run scripts/supercode/build.sh."

- [ ] **Step 1: Write failing tests:**
  - `pickServerPackage maps every supported platform`: the four mappings above, exact strings.
  - `pickServerPackage rejects 32-bit ARM`: `{ kernel: 'Linux', machine: 'armv7l', isMusl: false }` throws, and the message contains `32-bit ARM`.
  - `install directory is keyed by commit`: `serverInstallDir('~/.supercode-server', 'abc')` → `'~/.supercode-server/bin/abc'`, and differs for commit `'def'`.
- [ ] **Step 2: Run** the extension mocha tests. Expected: FAIL.
- [ ] **Step 3: Implement** `serverPackage.ts`, the upload path, the script change, the `product.json` identity and `build.sh`.
- [ ] **Step 4: Run** the tests (expected: PASS). Then run `scripts/supercode/build.sh` and check that five artifacts exist: the app in `../VSCode-darwin-arm64/` and four tarballs under `~/.supercode/server-packages/<commit>/`.
- [ ] **Step 5: Commit** with message `build: fork identity and per-platform server packages uploaded over ssh`.

---

### Task 10: End-to-end check on real machines

**Files:**
- Create: `docs/supercode/manual-test.md`, the checklist below with a results column

- [ ] **Step 1:** Install the built app. Create a workspace with one local folder plus folders on two real SSH hosts (at least one Linux x64; include ARM64 or Alpine if available) via "Add SSH Folder to Workspace…".
- [ ] **Step 2:** Check that the explorer browses all three roots, edit and save a file on each host, and confirm the change with `ssh host cat <file>`.
- [ ] **Step 3:** Open a terminal on each host (`hostname` prints the right machine; the tab shows the host).
- [ ] **Step 4:** Change a file on host A from outside (`ssh hostA touch …`); the explorer shows it within a few seconds.
- [ ] **Step 5:** Turn Wi-Fi off for 30 s and back on. Terminals resume and the status bar goes `n/n` → `0/n` → `n/n`.
- [ ] **Step 6:** Quit and reopen. The window is usable immediately, the roots show "…" and then fill in, and the previously open editors load their content.
- [ ] **Step 7:** Make host B unreachable (wrong `HostName` in `~/.ssh/config`) and reopen. Host B's root shows `!` with the error, there's no password prompt, and A and local work.
- [ ] **Step 8:** Drag a file from host A onto host B's root. You get the "between different remote machines" error, and no file changes.
- [ ] **Step 9:** Record the results in `docs/supercode/manual-test.md` and commit with message `docs: multi-host manual test results`.

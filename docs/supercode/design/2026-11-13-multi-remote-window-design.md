# Multi-host window: several SSH machines + local folders in one VS Code window

Date: 2026-11-13
Codebase: fork of `microsoft/vscode` at `daa23473` (cloned to `supercode/vscode`)

## 1. Intent and why

Today one VS Code window talks to at most one remote machine. Working across
several SSH machines (plus local folders) means juggling one window per machine.
The goal is a fork where a **single window** shows folders from the local disk
and from **several SSH machines at once**, and lets you browse, open, edit and
run terminals on all of them side by side.

The user's needs on remote machines are deliberately narrow: **file explorer,
viewing/editing files, terminals.** Extensions running on the remote machines
(language servers, git, debugging) are not needed. That narrowness is what keeps
this a contained fork rather than a rewrite of the workbench.

## 2. Goals, non-goals, anti-goals

**Goals (v1)**
- A *local* window can contain any mix of local folders and folders on N SSH
  hosts as roots of a multi-root workspace (`.code-workspace`).
- Explorer: browse, create, rename, delete, move, drag-and-drop within a host;
  live updates when files change on the remote (server-side watcher).
- Editors: open, edit, save remote files; dirty/conflict handling as for any file.
- Terminals: open a terminal on any host; it starts in the chosen root's folder.
  Terminals survive short network drops (existing reconnect logic).
- One host being down or slow never blocks the rest of the window.
- Workspace re-opens with all roots; all hosts reconnect in the background.

**Non-goals (v1)**
- Extensions on remote hosts (IntelliSense, git/SCM, debug, tasks) for
  secondary hosts. Language features for remote files come only from local
  extensions that work on any URI (syntax highlighting, basic editing).
- Quick Open (Ctrl+P) file search and Find in Files over remote roots
  (planned as phase 2: add a search channel to the server).
- Reviving remote terminals after a full window reload (phase 2).
- Port forwarding for secondary hosts.
- Windows as a remote host; the web (browser) build.
- Changing the behaviour of today's single-remote windows (they keep working
  exactly as now; the multi-host features live in local windows).

**Anti-goals (failure even if it "works")**
- A dead or slow host freezing the window, the explorer, or startup.
- Silently writing to the wrong machine (e.g. two hosts with the same path).
- A diff so spread through core that rebasing on upstream becomes impractical.

## 3. Constraints (found in the code)

- A window has a single `remoteAuthority`. `AbstractRemoteAgentService` opens
  exactly one connection for it
  (`src/vs/workbench/services/remote/common/abstractRemoteAgentService.ts:41`).
- The remote file system client is registered once for the whole
  `vscode-remote` scheme against that one connection
  (`src/vs/workbench/services/remote/common/remoteFileSystemProviderClient.ts:35`).
- Remote terminal backends are registered per authority, but only for the
  window's connection (`src/vs/workbench/contrib/terminal/browser/remoteTerminalBackend.ts:44-47`).
  The backend registry itself is keyed by authority
  (`src/vs/platform/terminal/common/terminal.ts:1273`).
- A terminal already picks its authority from its `cwd` URI
  (`src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts:188-192`).
- Authority resolution (SSH login, server install, port tunnel) is done by a
  resolver extension in the local extension host
  (`nativeExtensionService.ts:275` → `_resolveAuthorityOnExtensionHosts`), and
  the result is pushed into `RemoteAuthorityResolverService._setResolvedAuthority`
  (`src/vs/platform/remote/electron-browser/remoteAuthorityResolverService.ts:80`).
  Today this only runs for the window's own authority.
- Adding folders filters out other-authority `vscode-remote` folders, but only
  in remote windows (`abstractWorkspaceEditingService.ts:327-331`). Local
  windows do not filter.
- The server exposes `remoteFilesystem` and `remoteterminal` channels on the
  management connection (`src/vs/server/node/serverServices.ts:380,389`), so a
  connection with no remote extension host is enough for our scope.
- Built servers reject clients with a different commit
  (`src/vs/server/node/remoteExtensionHostAgentServer.ts:351-356`): every host
  must run the server built from the fork's exact commit.
- Microsoft's Remote-SSH extension is proprietary and licensed only for official
  builds. The fork needs an open-source SSH resolver: **open-remote-ssh**
  (`jeanp413/open-remote-ssh`, used by VSCodium/Gitpod). It uses the proposed
  `resolvers` API, which must be enabled for it in `product.json`.
- The built-in `extensions/vscode-test-resolver` keeps a single global server
  process, so it resolves only one authority at a time today.

## 4. Approaches considered

**A. Reuse VS Code's own remote server per host — CHOSEN.** The window stays
local; for each SSH host it opens an additional *management-only* connection to
the VS Code server on that host (no remote extension host). Files and terminals
route to the right connection by the URI's authority. SSH login/server install
is done by open-remote-ssh through the existing resolver mechanism.
Trade-offs: real-time file watching and resilient terminals come for free from
the server; requires the fork's server on each host (Linux/macOS, recent glibc);
touches several core services.

**B. Talk SSH directly (SFTP + shells from the main process), nothing installed
on remotes.** Works with any sshd and is a small core diff, but file changes are
found by polling, big trees are slow, terminals die on disconnect, and it
re-implements what the server already does. Rejected: daily-use reliability
matters more than unusual hosts.

**C. Make the workbench fully multi-remote (extension host per host).** Would
give IntelliSense/git/debug per host, but touches ~200 workbench files that read
the single `remoteAuthority`. Rejected: far beyond the stated need.

The user picked A.

## 5. Design (approach A)

### 5.1 URIs and identity
- A remote root is `vscode-remote://ssh-remote+<host>/<abs path>`, exactly what
  Remote-SSH/open-remote-ssh produce. The authority (`ssh-remote+<host>`) is the
  identity of the host everywhere: file routing, terminal backend lookup,
  labels, connection state. Two hosts with the same path are therefore always
  distinct URIs (anti-goal "wrong machine").
- Labels come from open-remote-ssh's `resourceLabelFormatters` contribution
  (`… [SSH: host]`); explorer roots get the host as a suffix.

### 5.2 New service: `IMultiRemoteService` (workbench, electron-browser)
Owns secondary connections. One instance per window.
- `getOrConnect(authority): Promise<IRemoteAgentConnection>` — lazily resolves
  the authority (new public path on the extension service, see 5.3), creates a
  `RemoteAgentConnection` (the existing class in
  `abstractRemoteAgentService.ts`, made reusable), fetches the remote
  environment, registers the per-host terminal backend.
- `getConnection(authority)`, `onDidChangeConnectionState(authority, state)`
  with states `connecting | connected | reconnecting | disconnected | failed`.
- `disconnect(authority)`; disposal on window close.
- Ignores the window's own `remoteAuthority` (if any) — that stays with
  `IRemoteAgentService`.
- **Connect all hosts in the background as the window opens** (user's
  choice). The window is usable immediately; nothing in the startup path
  waits on the network. Each remote root shows a "connecting" state and fills
  in when its host is up. A timeout marks a dead host `failed` with a
  Reconnect action, without affecting other roots.
- Startup readers that touch remote roots must not block on them:
  - folder configuration (`configurationService.ts` `loadFolderConfigurations`)
    treats a not-yet-connected remote root as empty and fires a configuration
    change when the host connects and its `.vscode/settings.json` arrives;
  - restored editors for remote files show a "connecting…" placeholder and load
    when the host is up (or an error with Reconnect);
  - the explorer shows the root collapsed with a status row until connected,
    then restores its expanded state.
  The builder decides the exact mechanism (e.g. the router answering calls for
  an unconnected host by awaiting the connection with a short timeout, versus
  failing fast with a dedicated "unavailable" error that these readers handle).
- Authentication is **SSH keys/ssh-agent only** (user's setup), so
  background connects are silent. Connections run non-interactively
  (`BatchMode=yes`): if a host would need a password or other prompt, it fails
  with a clear message rather than popping up dialogs at startup.

### 5.3 Resolving additional authorities
- Add a method on the extension service (e.g.
  `resolveAdditionalAuthority(authority)`) that calls the existing
  `_resolveAuthorityWithLogging` / `_resolveAuthorityOnExtensionHosts(LocalProcess, …)`
  for an arbitrary authority and then `_setResolvedAuthority` on the resolver
  service. Re-resolution on reconnect mirrors `_resolveAuthorityAgain` but
  per authority.
- Activation event `onResolveRemoteAuthority:ssh-remote` already activates the
  resolver extension in the local extension host.

### 5.4 File system routing
- Replace the single registration of `RemoteFileSystemProviderClient` for
  `vscode-remote` with a **routing provider** that dispatches every call by
  `uri.authority`:
  - window's own authority → existing connection (unchanged behaviour);
  - any other `vscode-remote` authority → `IMultiRemoteService.getOrConnect`,
    then a per-host `RemoteFileSystemProviderClient`.
- Capabilities (notably path case sensitivity) differ per host; the router
  reports the conservative set and per-host clients handle their own. (Builder
  to verify how `IFileService` uses capabilities and choose accordingly.)
- Watches are forwarded per host and re-established after reconnect.
- In a local window the router is registered too (today nothing serves
  `vscode-remote` in a local window).

### 5.5 Terminals
- When a host connects, register a `RemoteTerminalBackend` for its authority
  (same code path as `remoteTerminalBackend.ts:44-47`, parameterised by
  connection).
- New terminal in a multi-root window already asks which root to use as `cwd`;
  a remote root's URI selects that host's backend via `getRemoteAuthority(cwd)`.
  Make sure `getBackend(authority)` triggers `getOrConnect` instead of failing
  when the host is not yet connected.
- The terminal "+" dropdown gets one "New Terminal on <host>" entry per
  connected/known host. Terminal tabs show the host.
- Default profile/shell/env for a host come from that host's backend and
  remote environment (paths already parameterised by `remoteAuthority`).

### 5.6 Workspace & UI
- **Add SSH Folder to Workspace…** command (also in Explorer title menu and
  File menu): pick host (from `~/.ssh/config` via open-remote-ssh, or type
  `user@host`), connect, then pick a folder with the simple file dialog
  pointed at that host (the dialog today assumes the window's authority; it
  needs to accept a target authority). Adds the root to the workspace.
- Saved `.code-workspace` files store remote roots as URIs; re-opening the
  workspace shows all roots immediately and connects hosts lazily.
- Explorer root of a host that is connecting/failed shows a status decoration
  and a "Reconnect" inline action; its tree shows an error row instead of
  hanging.
- Status bar item "Hosts (n)" opens a quick pick: per host state,
  Connect/Disconnect/Reconnect, Open terminal.
- The existing remote indicator (bottom-left) is unchanged for single-remote
  windows.
- Workspace trust is per folder URI, so remote roots get the normal trust flow.

### 5.7 SSH resolver and server delivery
- Vendor **open-remote-ssh** (v0.6.1 at time of writing) into the fork as a
  built-in extension and enable the `resolvers` proposal for it in
  `product.json`.
- Use its **`native` connection backend (system OpenSSH binary)** by default
  rather than the `ssh2` JS library (setting `remote.SSH.connectionBackend`,
  verified in its `package.json`). That way `~/.ssh/config`, ssh-agent,
  ProxyJump/bastions, hardware keys and certificates behave exactly as in the
  terminal `ssh`. (My call.)
- Patch it so all its state (SSH connection, tunnels, server install) is
  **per authority**; today it is likely written for one resolution per window
  (builder to confirm).
- Server delivery: the fork builds its own `vscode-reh-<os>-<arch>` packages.
  Default (my call): the extension **uploads the matching server tarball from
  the local machine over SSH** if it isn't on the host, so hosts without
  internet work and no download server is needed. A download URL template
  setting remains available as an alternative.

### 5.8 Testing
- Unit tests (existing mocha setup in `src/vs/**/test`): router dispatch by
  authority, lazy connect, failure isolation, terminal backend lookup with
  connect-on-demand, folder filter unchanged for remote windows.
- Integration: patch `extensions/vscode-test-resolver` so each authority
  (`test+a`, `test+b`) spawns its own local server with its own data dir, then
  test two "hosts" in one window without SSH: explorer, edit/save, watcher
  events, terminals, killing one server while the other keeps working.
- Manual: two real SSH hosts + local folders, network-drop test.

### 5.9 Settings per host
- There is exactly one remote-user-settings layer in the configuration model
  (the window's own remote). v1 adds **no per-host settings layer** (my call):
  each host gets local user settings (by OS key, e.g.
  `terminal.integrated.defaultProfile.linux`) plus each root's
  `.vscode/settings.json`. With no profile set, a host's terminal uses that
  host's login shell, so differing shells per host still work by default.

### 5.10 Build and shipping
- The fork is a **packaged build with a `commit` in `product.json`** (my call):
  from-source runs have no commit, which breaks the commit-keyed server install
  folder. Development uses the patched `vscode-test-resolver` instead of SSH.
- **Local side: macOS only** (user's choice). The app is built for the
  user's Mac architecture; no Windows/Linux client work or testing.
- **Remote platforms** (user's choice): Linux x64, Linux ARM64 (64-bit Raspberry
  Pi OS, Graviton), Alpine (musl). Server targets already exist in
  `build/gulpfile.reh.ts:53-57`: `linux-x64`, `linux-arm64`, `alpine-x64`
  (`linux-alpine`), `alpine-arm64`. All four are built. 32-bit ARM (`armhf`)
  is not supported (my call). Alpine builds need Docker on the build machine.
- The server install step on a host detects OS/arch/libc (`uname -m`, musl
  check) and picks the matching tarball.
- A build script produces these `vscode-reh-<os>-<arch>` tarballs; they are
  cached in the app's data folder (not bundled in the app) and uploaded to a
  host on first connect.

## 6. Decided by the user
- Remote hosts need only explorer, file view/edit, and terminals.
- Approach A (reuse the VS Code server, one extra connection per host).
- Reopening a workspace connects all hosts in the background.
- Authentication is by SSH keys.
- Local machine: macOS only. Remote: Linux x64, Linux ARM64, Alpine.

## 7. My calls (open to correction)
- Multi-host features live in local windows; single-remote windows unchanged.
- Background connects never block startup; non-interactive SSH (`BatchMode`).
- open-remote-ssh's native OpenSSH backend by default.
- No per-host settings layer; terminals default to each host's login shell.
- Packaged build with a commit; 32-bit ARM not supported.
- Server tarball uploaded from the local machine by default.
- Search and terminal revival after reload deferred to phase 2.
- open-remote-ssh vendored and patched rather than written from scratch.

## 8. Left to the builder
- Exact names/placement of new services and commands.
- How file-service capabilities are reported for the router.
- How to make `SimpleFileDialog` target a specific authority.
- Timeout values, retry/backoff details (reuse existing persistent-connection
  logic where possible).
- Build/packaging steps for the fork's server packages per OS/arch.

# Supercode

Supercode is a fork of [Visual Studio Code](https://github.com/microsoft/vscode). In it, **one window can hold local folders and folders on several SSH machines at the same time**. You can browse, open, edit and save files, and run terminals, on every machine side by side, without opening one window per machine.

```
Explorer
├─ notes              (local)
├─ app  [SSH: alice@devbox]
├─ app  [SSH: deploy@prod-1:2222]
└─ etl  [SSH: pi@raspberrypi]
```

## What it does

- **Mixed workspaces:** one local window holds a multi-root workspace (`.code-workspace`) that mixes local folders with folders on any number of SSH hosts.
- **Explorer and editing on every host:** create, rename, delete, move and save files on any host. The view updates live when files change on the remote machine.
- **Terminals on every host:** a terminal opened in a remote folder runs on that machine, and its tab shows the host. A short network drop doesn't kill it.
- **Background connections:** when you open a workspace, every host connects in the background. The window is usable immediately, and a slow or dead host never blocks the others.
- **Workspace groups:**
  - Roots can be organised into named, collapsible groups in the Explorer. Groups live in the `.code-workspace` file under `"supercode.groups"`, and the file stays a valid VS Code workspace file.
  - A new or imported group starts collapsed. A collapsed group's SSH hosts stay disconnected: they don't connect at startup, and they disconnect after an idle delay (default 5 minutes) once nothing but collapsed groups uses them.
  - Expanding a group connects its hosts. Opening a file, or a terminal, on a collapsed group's host also connects it.
  - A host you disconnect yourself from the Hosts picker stays disconnected until you reconnect it.
  - Groups only exist in a local window with a saved or untitled workspace. Without `"supercode.groups"` the Explorer behaves exactly as before.
- **Host status:**
  - Explorer roots show `…` while connecting and `!` on failure, with the error in the tooltip.
  - Right-click a root and choose **Reconnect Host** to retry.
  - The status bar item **Hosts n/m** opens a picker with Reconnect, Disconnect and New Terminal for each host.
- **Safety:**
  - SSH never prompts (BatchMode); a host that needs a password fails with a message instead.
  - Hosts in an untrusted workspace don't auto-connect.
  - Host names are validated before they reach `ssh`.
- **Normal Remote-SSH windows** (a whole window on one remote) behave exactly like stock VS Code.

**Not in v1:**
- Quick Open and Find in Files over remote folders.
- Extensions running on remote hosts (IntelliSense, git, debugging there).
- Bringing remote terminals back after a full window reload.
- Per-host settings.
- Windows as a remote host.

## Requirements

- **Your machine:** macOS on Apple silicon.
- **Remote hosts:** Linux x64, Linux ARM64, or Alpine (x64/ARM64). 32-bit ARM isn't supported.
- **SSH access:**
  - Log in with SSH keys or ssh-agent. Password and 2FA logins are not supported, by design.
  - Each host must already be in `~/.ssh/known_hosts`. Connect once with `ssh <host>` in a terminal first.
  - `~/.ssh/config` hosts, aliases and `ProxyJump` work as they do in your terminal, because Supercode uses the system `ssh`.

## Using it

1. Open Supercode as a normal local window.
2. Run **Add SSH Folder to Workspace…**, either from the Command Palette or from the button in the Explorer title bar.
3. Pick a host from `~/.ssh/config`, or type `user@host[:port]`.
4. Pick a folder on that host. It's added as a workspace root named `<folder> [SSH: user@host]`.
5. Repeat for more hosts, and add local folders with **File → Add Folder to Workspace…**.
6. Save the workspace (**File → Save Workspace As…**). Reopening it reconnects every host in the background.
7. To open a terminal on a host, use **New Terminal** in one of its folders, or **New Terminal on Remote Host…**.

### Workspace groups

- **Add Workspace…** (File menu, or the Explorer title bar) imports a `.code-workspace` file as a group, named after the file. **New Empty Group** creates an empty one.
- Right-click a group for Add Folder, Add SSH Folder, New Terminal in Group, Rename, Ungroup and Remove. Right-click a root and choose **Move to Group…**, or drag roots between groups.
- Click a group to expand it, which connects its hosts. Collapse it to let them disconnect after `multiRemote.idleDisconnectDelay` seconds (default `300`, minimum `0`).
- Search's **Reveal in Explorer** opens a collapsed group. Auto-reveal of the active editor does not.
- Editing the `.code-workspace` file by hand or with stock VS Code is fine: the groups are reconciled with the folders it lists.

The first time you connect to a host, Supercode uploads its server package to `~/.supercode-server/` on that host. The package comes from your Mac, so the host doesn't need internet access.

## Repository layout

```
supercode/
├─ README.md
├─ docs/superpowers/
│  ├─ specs/2026-11-13-multi-remote-window-design.md   design (why, goals, approach)
│  └─ plans/2026-11-13-multi-remote-window.md          implementation plan (tasks)
├─ vscode/                       the fork (git, branch `multi-host`, based on microsoft/vscode daa23473)
│  ├─ docs/supercode/manual-test.md                    checklist for real-host testing
│  ├─ scripts/supercode/build.sh                       packages the app + Linux/Alpine servers
│  └─ scripts/test-multi-remote-integration.sh         two-host integration tests
└─ VSCode-darwin-arm64/Supercode.app                   packaged app (build output)
```

### How it works

Supercode reuses VS Code's own remote server. The window stays local and opens one lightweight connection per SSH host. These connections carry files and terminals only; no remote extension host runs.

| Piece | Where |
|---|---|
| Per-host connections and their states (connecting, connected, reconnecting, failed, disconnected) | `src/vs/workbench/services/remote/{common,browser}/multiRemoteService.ts` |
| `vscode-remote` file system router, which sends each call to the right host | `src/vs/workbench/services/remote/browser/remoteFileSystemRouter.ts` |
| Resolving extra hosts through resolver extensions | `IExtensionService.resolveRemoteAuthority` (`abstractExtensionService.ts`) |
| Terminal backend per host | `src/vs/workbench/contrib/multiRemote/browser/multiRemoteTerminal.ts`, plus `terminal/browser/*` |
| Background connect, refresh on connect, root decorations, trust gating | `src/vs/workbench/contrib/multiRemote/browser/multiRemoteWorkspace.ts` |
| Add-folder command, Hosts status bar | `src/vs/workbench/contrib/multiRemote/browser/multiRemoteActions.ts`, `multiRemoteStatus.ts` |
| Workspace groups: model, storage in the workspace file (`"supercode.groups"`), collapsed state, import and reconcile | `src/vs/workbench/services/workspaceGroups/*` |
| Which hosts are wanted (ungrouped or expanded roots, visible editors and terminals), idle disconnect, `multiRemote.idleDisconnectDelay` | `src/vs/workbench/contrib/multiRemote/browser/hostDemand.ts` |
| Group commands (add, import, move, ungroup, rename, remove) and the group context menu | `src/vs/workbench/contrib/multiRemote/browser/workspaceGroupsActions.ts` |
| Group rows in the Explorer tree (group items, drop targets) | `src/vs/workbench/contrib/files/common/explorerGroupItem.ts`, with hooks in `contrib/files/browser/views/explorerViewer.ts` |
| SSH resolver: open-remote-ssh v0.6.1 (MIT), vendored, with a session per host and non-interactive native OpenSSH | `extensions/open-remote-ssh/` (changes listed in `VENDORED.md`) |

Each host is identified by its `vscode-remote` authority (`ssh-remote+…`), compared case-insensitively. Single-remote windows and the web build don't use any of this.

## Building

All commands run in `vscode/` with Node `24.22.1` (see `.nvmrc`) and pnpm.

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
corepack enable
pnpm install
pnpm run compile            # or: pnpm run build-fast --client-only
./scripts/code.sh           # run from source (dev)
```

To build the app and the server packages:

```bash
scripts/supercode/build.sh --dry-run   # print what it will do
scripts/supercode/build.sh             # needs Docker running and ~30 GB free disk
```

- The app is written to `../VSCode-darwin-arm64/Supercode.app`.
- The server packages are written to `~/.supercode/server-packages/<commit>/vscode-reh-<target>.tar.gz`.
- Each server is built inside a Linux container of its own architecture, so its native modules (node-pty, file watcher) are real Linux binaries. The script checks this after each build.
- Hosts must run the server built from the exact same commit as the app.

## Testing

```bash
./scripts/test.sh --grep "WorkspaceGroups|HostDemand|MultiRemote|RemoteFileSystemRouter|Explorer|Terminal|SimpleFileDialog|ExtensionService"
./scripts/test-multi-remote-integration.sh     # two stand-in hosts (test resolver), no SSH needed
./scripts/test-remote-integration.sh           # single-remote suites still green
pnpm -C extensions/open-remote-ssh exec mocha out/test/*.test.js   # after compiling the extension
```

To test against real machines, follow `vscode/docs/supercode/manual-test.md`.

## Status

- **Implemented and reviewed:** the design's 10 tasks, plus a whole-branch review and its fix round. Unit, integration and single-remote suites pass.
- **Packaging:** the macOS app builds. The Linux/Alpine server build script is being fixed for two issues: the end-of-life Debian 11 mirror, and Alpine builds needing their Node binary without Docker. Server packages haven't been produced yet.
- **Not yet done:** the hands-on test on real SSH hosts (`manual-test.md`).

## License

- The VS Code source is MIT, © Microsoft (see `vscode/LICENSE.txt`).
- open-remote-ssh is MIT, © jeanp413 (see `vscode/extensions/open-remote-ssh/LICENSE.txt`).
- "Visual Studio Code" is a Microsoft trademark. Supercode is an independent fork, built from the open-source code without Microsoft branding or the proprietary Remote-SSH extension.

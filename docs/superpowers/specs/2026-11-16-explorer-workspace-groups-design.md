# Workspace groups in the Explorer: several workspaces in one Supercode window

Date: 2026-11-16
Codebase: `supercode/vscode`, branch `multi-host` (builds on
`2026-11-13-multi-remote-window-design.md`)

## 1. Intent and why

Supercode already lets one window hold local folders and folders on several SSH
hosts. The user works across **15–20 workspaces**, each a mix of local and SSH
folders, and actively uses **about 5–7 of them at a time**. They want all of
them in **one window**, with the Explorer showing each workspace as its own
collapsible group, and the ability to **add another workspace from the
Explorer**, just as they add a folder today.

```
Explorer
├─ ▾ shop-platform          (group)
│   ├─ web     (local)
│   ├─ api     [SSH: alice@devbox]
│   └─ deploy  [SSH: deploy@prod-1]
├─ ▾ home-lab               (group)
│   ├─ etl     [SSH: pi@raspberrypi]
│   └─ notes   (local)
├─ ▸ client-x               (group, collapsed: its hosts are not connected)
└─ scratch  (local)          ungrouped root, shown as today
```

## 2. Goals, non-goals, anti-goals

**Goals**
- The Explorer shows named **groups**, each holding workspace roots (local or
  SSH). Roots not in any group show at the top level, as today.
- **Add Workspace…** (Explorer title bar + Command Palette): either import an
  existing `.code-workspace` file's folders as a new group (named after the
  file), or create an empty named group.
- Per group (context menu): Add Folder…, Add SSH Folder…, Rename, Remove Group
  (removes its roots from the window), New Terminal (picks one of its roots).
- Move a root between groups (drag and drop, plus a "Move to Group…" command).
- **Collapsed groups don't connect their hosts.** Expanding a group connects
  its hosts in the background (same non-blocking behaviour as today).
  Collapsing it lets hosts that nothing else uses disconnect after an idle
  delay.
- Groups and their collapsed/expanded state survive closing and reopening the
  window.
- Works with 20 groups and 50+ roots without the window or startup slowing
  down.

**Non-goals**
- Separate settings, trust, search scope, tasks or launch configs per group
  (approach C, rejected). All groups share the window's workspace.
- Keeping a group linked to the `.code-workspace` file it was imported from
  (approach B, possible later). Import is a one-time copy of the folder list.
  The imported file's `settings`, `tasks`, `launch` and `extensions` are not
  applied.
- Nested groups.
- Everything already listed as "not in v1" in the multi-host design (remote
  search/Quick Open, remote extensions, terminal revival after reload, per-host
  settings) stays out.

**Anti-goals**
- Opening a window with 20 groups starts dozens of SSH logins at once.
- An older `.code-workspace` (no groups) looks or behaves differently from
  today.
- Losing the group layout when VS Code rewrites the workspace file (for
  example when a folder is added or removed).
- A diff spread through the Explorer that makes rebasing on upstream hard.

## 3. Constraints (found in the code)

- A window has one workspace: `IWorkspaceContextService.getWorkspace().folders`
  is a flat list, and the Explorer builds its roots straight from it
  (`src/vs/workbench/contrib/files/common/explorerModel.ts:39`).
- Every folder add/remove rewrites the whole `folders` array, keeping only
  `path`/`uri` and `name` per entry
  (`src/vs/workbench/services/configuration/browser/configuration.ts:691`,
  `src/vs/platform/workspaces/common/workspaces.ts:137`). Any extra key on a
  folder entry is lost. Top-level keys other than `folders` are left
  untouched.
- A folder URI can appear only once in a workspace, so a root belongs to at
  most one group.
- The Explorer tree is typed on `ExplorerItem` throughout: data source,
  renderer, drag and drop, compression, find/filter, context keys
  (`explorerViewer.ts`, ~2100 lines; `explorerView.ts`; `explorerService.ts`).
- Host connection today: `MultiRemoteWorkspaceContribution` connects **every**
  host that has a root, at startup, on trust, and when roots are added
  (`src/vs/workbench/contrib/multiRemote/browser/multiRemoteWorkspace.ts`). A
  host stays connected while `isHostInUse` (it has roots or terminals). The
  `vscode-remote` file system router already connects a host on demand when a
  file on it is opened.
- Untitled workspaces (created when you add a second folder before saving) are
  real `.code-workspace` files in the user data folder, so the same storage
  works for them.

## 4. Approaches considered

**A. Groups inside the window's single workspace — CHOSEN.** The window keeps
one `.code-workspace`. Group membership is stored in that file under a new
top-level key. The Explorer adds a group level above the roots. Everything that
works per window (settings, trust, search, tasks) is shared by all groups;
per-folder `.vscode/settings.json` keeps working. Smallest change to core.

**B. A, plus each group stays linked to its source `.code-workspace` file**,
syncing changes both ways and applying the file's settings to the group's
folders. Not chosen for now: more work, and window-scoped settings can't be
limited to one group. Can be added later if the user keeps editing those files
outside Supercode.

**C. Each group as a fully separate workspace** (own trust, search, settings,
tasks). Rejected: it means making the workbench support several workspaces
per window, a core rewrite that breaks the "easy to rebase" anti-goal.

The user picked A.

## 5. Design

### 5.1 Storage

Groups live in the window's `.code-workspace` file under a top-level key:

```jsonc
{
  "folders": [
    { "path": "/Users/me/web", "name": "web" },
    { "uri": "vscode-remote://ssh-remote+alice@devbox/srv/api", "name": "api [SSH: alice@devbox]" },
    { "path": "/Users/me/scratch" }
  ],
  "supercode.groups": [
    {
      "name": "shop-platform",
      "folders": [
        "file:///Users/me/web",
        "vscode-remote://ssh-remote+alice@devbox/srv/api"
      ]
    }
  ]
}
```

- Each group has a `name` and the list of its roots as **full URI strings**,
  compared with the same URI identity rules the workspace uses
  (case-insensitive authority, as in the multi-host design).
- Group order in the array is display order. Root order within a group follows
  the order of `folders`.
- **Reconciliation:** a group entry whose URI is no longer in `folders` is
  dropped on the next write; a root in `folders` that no group lists is
  ungrouped. A file edited by hand or by stock VS Code therefore never breaks;
  stock VS Code just shows a flat list and ignores the key.
- Removing a root from the workspace (any way) also removes it from its group.
  Writes go through the JSON editing service (`IJSONEditingService`), like
  folder changes, so comments and formatting are kept.
- **Collapsed/expanded state is not stored in the file** (it would rewrite the
  file on every click). It goes in workspace-scoped storage
  (`IStorageService`, `StorageScope.WORKSPACE`), keyed by group name. A group
  with no stored state starts **collapsed** (my call: a freshly imported
  workspace doesn't start connecting hosts until the user opens it).

### 5.2 Explorer

- A new tree level: group node → its roots → files. Ungrouped roots show after
  the groups, at the top level, exactly as today. A workspace with no
  `supercode.groups` key looks exactly like it does today.
- Group node shows its name, a count of roots, and a status summary of its
  hosts (for example `2/3 hosts` while connecting, `!` if any host failed, with
  the per-host details in the tooltip). Root decorations from the multi-host
  work (`…`, `!`, Reconnect) stay on the roots.
- An explicit **Reveal in Explorer** (command, search results) expands the
  file's group. **Auto-reveal** (`explorer.autoReveal` following the active
  editor) does **not** expand a collapsed group: it reveals only when the
  group is already expanded (my call: otherwise a restored editor would open
  its group and connect every host in it).
- "Collapse Folders in Explorer" collapses groups too.
- Drag a root onto a group (or onto another group's root) to move it into that
  group; drag it to empty space below the groups to ungroup it. Dropping files
  onto a group node is not allowed.
- How to add the group level is left to the builder (see 5.6), within the
  "small, isolated diff" constraint.

### 5.3 Commands and menus

| Command | Where | Does |
|---|---|---|
| Add Workspace… | Explorer title bar, Command Palette, File menu | Quick pick: "Import .code-workspace file…" (file dialog, local files only) or "New empty group…" (asks for a name). |
| Add Folder to Group… | group context menu | Local folder dialog; adds the root to the workspace and the group. |
| Add SSH Folder to Group… | group context menu | Existing Add SSH Folder flow, then adds into this group. |
| Rename Group | group context menu, F2 | Renames; names must be unique (case-insensitive) and non-empty. |
| Remove Group | group context menu | Confirms, then removes the group **and its roots** from the window (files untouched). |
| Ungroup | group context menu | Removes the group but keeps its roots, ungrouped. |
| Move to Group… | root context menu | Quick pick of groups + "New group…" + "Ungrouped". |
| New Terminal in Group | group context menu | Asks which of the group's roots to start in (existing root picker, filtered). |

- Existing **Add SSH Folder to Workspace…** and **File → Add Folder to
  Workspace…** keep working and add ungrouped roots. If the Explorer selection
  is inside a group, they add into that group (my call).
- **Import details:** folders come from the file's `folders` (relative paths
  resolved against the file's location; both `path` and `uri` forms). A folder
  already in the window stays where it is and the user is told which ones were
  skipped. If a group with the file's name exists, a suffix is added
  (`name (2)`). An imported `.code-workspace` that itself has
  `supercode.groups` is imported as those groups instead of one (my call).
- If the window has no workspace yet (a single-folder or empty window), the
  first Add Workspace makes it an untitled multi-root workspace first, the
  same way Add Folder to Workspace does today.

### 5.4 When hosts connect

Replaces "connect every host that has a root":

- A host is **wanted** if any of: it has a root that is ungrouped or in an
  expanded group; a terminal runs on it; an editor **visible on screen** (the
  active editor of some editor group) shows one of its files. Background tabs
  don't count (my call): a restored background tab of an idle host shows the
  existing "connecting/unavailable" state when clicked, and loads once the
  host is up.
- **The file system router must use the same rule.** Today it connects any
  untouched host that has a root on the first `stat`/`readdir`/`watch`
  (`multiRemote.contribution.ts:41` → `remoteFileSystemRouter.ts:104`), and
  the workspace watcher, folder-settings loader and extensions touch every
  root at startup, so every host would still connect. Its `canAutoConnect`
  becomes "trusted and wanted". Calls to an unwanted host fail fast with the
  existing "Unavailable" error and do not connect it; watchers, folder
  settings and extensions already tolerate that error, and the existing
  on-connect refresh (settings reload, explorer refresh, watcher
  re-establish) runs when the host is wanted and connects later.
- On startup, trust granted, roots added, or a group expanded: connect every
  wanted host in the background (unchanged non-blocking connect, BatchMode,
  trust gating).
- On a group collapse or roots removed: a host that is no longer wanted
  disconnects after an **idle delay of 5 minutes** (my call), so quickly
  collapsing and re-expanding doesn't cause reconnects. Becoming wanted again
  cancels the timer.
- Opening a file from a collapsed group's host (for example a restored
  editor) still connects that host on demand through the file system router,
  as today, and the open editor keeps it wanted.
- The **Hosts n/m** status bar counts wanted hosts. Its picker lists all hosts
  with roots, including idle ones (shown as "Not connected", with Connect).
- `isHostInUse` / `hasRoots` in `multiRemoteWorkspace.ts` become the "wanted"
  check above.

### 5.5 Compatibility

- No `supercode.groups` key → Explorer and connections behave exactly as
  today (all roots ungrouped, so all hosts wanted).
- Single-remote windows: unchanged; all group commands hidden (same
  context-key gating as the multi-host commands).
- Single-folder and empty local windows: **Add Workspace…** is shown (it
  turns the window into a multi-root workspace, see 5.3); commands that act on
  an existing group are hidden.
- Stock VS Code opening a grouped file: shows a flat list. If it adds/removes
  folders, the key is kept (it only rewrites `folders`); stale entries are
  reconciled on the next Supercode write.

### 5.6 Left to the builder

- **How the group level goes into the Explorer tree.** Options include a group
  element type alongside `ExplorerItem` in the data source/renderer, or a
  wrapper the existing code treats as a pseudo-root. Pick whatever keeps the
  upstream diff smallest and isolated (new code in `contrib/multiRemote` or a
  new `contrib/workspaceGroups` where possible), and list the touched upstream
  files in the commit messages.
- Exact command IDs, menu group placement, icons.
- The service shape for groups (a small `IWorkspaceGroupsService` that owns
  the model, reconciliation and storage is the likely fit).
- How the explorer's compressed folders, find/filter and keyboard navigation
  interact with group nodes; behaviour should be the natural one.

### 5.7 Local roots in collapsed groups

Collapsing a group affects **only its SSH hosts**. Its local roots stay
normal workspace folders: watched, included in Quick Open / Find in Files,
scanned by git/SCM, and visible to extensions (user's choice). "Doesn't slow
down" in the goals means the Explorer stays responsive and startup doesn't
wait on or flood SSH; it does not mean idling local folders.

### 5.8 Import sources

The user's existing workspace files are **local** `.code-workspace` files on
the Mac (user's answer). Import uses the local file dialog only. A file with a
top-level `remoteAuthority` (saved from a Remote-SSH window) is refused with a
message rather than imported as wrong local paths.

### 5.9 Testing

Following the existing approach (mocha unit tests in `src/vs/**/test`, plus the
two-host integration script):

- Unit: parse/reconcile `supercode.groups` (stale URIs, missing key, duplicate
  names, case-insensitive authorities, relative paths on import); group model
  operations (add, rename, move, remove, ungroup); "wanted host" rules and the
  idle-disconnect timer (fake timers).
- Unit: workspace file round-trip: adding/removing folders keeps the
  `supercode.groups` key and comments.
- Integration (`scripts/test-multi-remote-integration.sh`, test resolver hosts
  `test+a`, `test+b`): a workspace with two groups, one per host; collapsed
  group's host stays disconnected; expanding connects it; collapsing
  disconnects after the delay (shortened in tests); opening a file from a
  collapsed group connects on demand.
- Add rows to `docs/supercode/manual-test.md` for groups on real hosts.

## 6. Decided by the user
- Several workspaces in one window, shown as groups in the Explorer, added
  from the Explorer.
- Scale: 15–20 workspaces; about 5–7 in active use at once.
- Approach A: groups inside the window's single workspace; shared settings,
  trust, search, tasks.
- Local roots in collapsed groups stay fully live.
- Existing workspace files to import are local files.

## 7. My calls (open to correction)
- Groups stored under a top-level `"supercode.groups"` key with full URIs;
  collapsed state in workspace storage, not the file.
- New and imported groups start collapsed.
- Idle hosts disconnect 5 minutes after nothing wants them.
- Only on-screen editors keep a host connected; background tabs don't.
- Auto-reveal doesn't expand a collapsed group; explicit Reveal does.
- Unwanted hosts fail fast as "Unavailable" instead of auto-connecting.
- Remove Group removes its roots; Ungroup keeps them.
- Add Folder / Add SSH Folder add into the selected group, if any.
- Importing a file that already has groups brings in those groups.
- Imported files' settings/tasks/launch are ignored (one-time folder copy).

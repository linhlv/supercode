# Supercode multi-host manual test

Run on a packaged build (`scripts/supercode/build.sh`, then install `../VSCode-darwin-arm64`). Use one local folder plus folders on two real SSH hosts (at least one Linux x64; add ARM64 or Alpine if available). Hosts must be reachable with SSH keys / ssh-agent and already in `~/.ssh/known_hosts`.

| # | Step | Expected | Result |
|---|------|----------|--------|
| 1 | "Add SSH Folder to Workspace…" for host A and host B; add a local folder | Explorer shows three roots, each browsable | |
| 2 | Edit and save a file on each host; check with `ssh host cat <file>` | Changes are on the right machine | |
| 3 | Open a terminal on each host (terminal "+" menu or "New Terminal on Remote Host…"); run `hostname` | Right machine; tab shows the host | |
| 4 | From outside, `ssh hostA touch <root>/new.txt` | Explorer shows `new.txt` within a few seconds | |
| 5 | Turn Wi-Fi off for 30 s, then on | Terminals resume; status bar goes n/n → 0/n → n/n | |
| 6 | Quit and reopen the workspace | Window usable immediately; remote roots show "…" then fill in; open editors load | |
| 7 | Make host B unreachable (wrong `HostName` in `~/.ssh/config`), reopen | B's root shows `!` with the error; no password prompt; A and local work | |
| 8 | Drag a file from host A onto host B's root | Error "between different remote machines"; nothing changes | |
| 9 | Open a normal Remote-SSH style single-remote window | Behaves as stock VS Code; no Hosts status item, no "New Terminal on Remote Host…" | |

## Workspace groups

Needs a local window with a saved workspace. Check the `.code-workspace` content (`"supercode.groups"`) after the steps that change groups.

| # | Step | Expected | Result |
|---|------|----------|--------|
| G1 | Import 3 workspace files with real hosts (File > Add Workspace… and the Explorer title icon; the pick offers both options) | Three groups appear, collapsed, each "N folders"; no SSH login starts; folders that overlap show a skipped-folder info | |
| G2 | Quit and reopen with all groups collapsed | Hosts n/m shows 0 connected for hosts used only by collapsed groups; no connecting; ungrouped hosts still connect | |
| G3 | Expand a group with an SSH root | Roots appear one level in; the host connects (`…` on the group); expanding the root lists files | |
| G4 | Collapse it again, wait 5 minutes (or set `multiRemote.idleDisconnectDelay` lower) | The host disconnects; Hosts n/m drops; its roots don't show `!` | |
| G5 | Reload the window | Each group returns in the state it was left in; roots in collapsed groups are not fetched | |
| G6 | Drag a root onto a group header, onto a root in another group, onto an ungrouped root, onto empty space | Membership follows each drop; files and groups can't be dropped onto a group; a group header can't be dragged; with no groups, root reordering by drag still works | |
| G7 | Root right-click > Move to Group… | Lists groups and Ungrouped; hidden in remote windows | |
| G8 | New Empty Group with a name that already exists | Validation error | |
| G9 | Group right-click: Add Folder, Add SSH Folder, New Terminal in Group, Rename (also F2), Ungroup, Remove (confirm) | Folder lands in that group; terminal starts in the group's root; the group menu opens, not the file menu | |
| G10 | Edit the `.code-workspace` with stock VS Code (rename a group, delete a folder, add a folder, then save) | The Explorer is reconciled with the file: removed folders leave their group, new folders are ungrouped | |
| G11 | A saved edit to the file made outside the window (another editor) | Same reconciliation, no duplicate groups | |
| G12 | Open a file from a collapsed group's host (Quick Open, recent files, editor history) | The host connects and the editor loads the file | |
| G13 | Run Search, then Reveal in Explorer on a result in a collapsed group; separately, activate a file there with `explorer.autoReveal` on | Reveal opens the group and selects the file; auto-reveal leaves the group collapsed | |
| G14 | Collapse Folders in Explorer | Every group collapses, as do folders inside roots | |
| G15 | With a group focused: Copy Path, Copy Relative Path, Delete, F2 (not Rename Group), Open to Side, title-bar New File/New Folder | Nothing happens; no `supercode-group:` path is copied; New File/Folder disabled | |
| G16 | Type in the Explorer to filter (filter and highlight modes) | Results come only from ungrouped roots and expanded groups; collapsed groups stay collapsed and their hosts don't connect; after closing the widget every group is as you left it | |
| G17 | Hosts n/m > Disconnect on a host whose group is expanded | It stays disconnected, even after collapse and expand, until you Reconnect | |
| G18 | A group whose host failed | The group shows `!` with the per-host tooltip | |
| G19 | Open a workspace without `"supercode.groups"` | Flat roots, same behaviour and expansion as before groups | |

Known limits in v1: Quick Open / Find in Files don't search remote roots; remote terminals are not revived after a full window reload; no per-host settings.

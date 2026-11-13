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

Known limits in v1: Quick Open / Find in Files don't search remote roots; remote terminals are not revived after a full window reload; no per-host settings.

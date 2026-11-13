# Vendored: open-remote-ssh

- Upstream: https://github.com/jeanp413/open-remote-ssh
- Tag: `v0.6.1`, commit `446edafb957328d2dd07c8970fce8cb3be41680e`
- License: MIT (see `LICENSE.txt`, unchanged)
- Copied: `src/`, `resources/`, `package.json`, `LICENSE.txt`, `README.md`, `docs/*.md`.
  Not copied: upstream tests (`test/`, docker based), CI, lockfile, webpack/vitest/eslint configs, `.github`.

## Changes against upstream

Build and packaging
- Built with the repo's esbuild extension build (`esbuild.mts`, output `dist/`) instead of webpack (`lib/`).
  Runtime file lookups of `lib/...` in `src/authResolver.ts` and `src/serverSetup.ts` now read `dist/...`.
- `tsconfig.json` extends `extensions/tsconfig.base.json`; `vscode` typings come from `src/vscode-dts`.
- `package.json`: scripts replaced, upstream dev tooling dependencies and npm `overrides` removed, `browser`
  entry and `galleryBanner` removed, `main` is `./dist/extension.js`. Runtime dependencies are unchanged except `semver` (7.7.4) and `socks` (2.8.8), pinned to versions already in the repo lockfile. The `ssh2`
  git dependency (`git+https://github.com/jeanp413/ssh2#master`) installs fine through pnpm, so it is not pinned to npm.
- Registered in `pnpm-workspace.yaml`, `build/gulpfile.extensions.ts` (type check) and `product.json`
  (`extensionEnabledApiProposals` for `jeanp413.open-remote-ssh`: `resolvers`, `contribViewsRemote`).

Behaviour
- `remote.SSH.connectionBackend` defaults to `native` (was `ssh2`).
- Native backend: ssh arguments are built by `buildNativeSshArgs` (`src/native/nativeSshArgs.ts`), which always adds
  `-o BatchMode=yes -o ConnectTimeout=15`. The `remote.SSH.connectTimeout` setting no longer applies to the native
  backend. `BatchMode` means ssh never prompts (password, passphrase, unknown host key): authentication must work
  with an agent or an unencrypted key, and the host must already be in `known_hosts`.
- Native backend askpass removed: the `AskPassServer` is no longer created and the helper process env
  (`buildNativeServerEnv`) sets no `SSH_ASKPASS` and `SSH_ASKPASS_REQUIRE=never`, so ProxyJump/ProxyCommand child
  ssh processes cannot prompt either. Only the `native` backend is non-interactive; the opt-in `ssh2` backend
  still prompts through VS Code input boxes. The askpass sources remain in the tree, unused.
- Native server registry (`ssh-host-<key>-...`) is keyed by a hash of the full encoded destination
  (`nativeRegistryKey`: user, host, port) instead of the hostname, so `alice@box` and `bob@box:2222` never adopt
  each other's running server.
- Terminal environment (forwarded `SSH_AUTH_SOCK`) is applied through `environmentVariableCollection.getScoped` only
  to the workspace folders of the session's authority (`src/envScope.ts`), re-applied on
  `onDidChangeWorkspaceFolders` and cleared when the session is disposed.
- Per-connection state moved from `RemoteSSHResolver` into `SSHSession`, kept in a `SessionRegistry`
  (`src/sessionRegistry.ts`) keyed by remote authority, so several hosts can be connected at once. A new resolve of
  an authority disposes only that authority's previous session; a failed resolve disposes its session.
- The resource label formatter is registered per authority (was only `ssh-remote+*`), with the suffix
  `SSH: [user@]host[:port]` (`hostLabelSuffix`, `src/hostLabel.ts`; user and port only when the destination names
  them), so `alice@box` and `bob@box` read differently. It is registered at the start of `resolve()` and by
  `remote-ssh.addFolderToWorkspace` before the host is connected, kept by the resolver (not the session) and so
  survives re-resolves and failures; it is disposed with the resolver.
- A failed resolve shows the output panel and the modal "Could not establish connection to …" (with "Retry" =
  reload window and "Close Remote") only for the window's own remote authority (`vscode.env.remoteAuthority`,
  `isWindowAuthority` in `src/windowAuthority.ts`). `resolveAttempt` is window-wide, so upstream showed it for the
  first additional host of a local window, whose "Retry"/"Close Remote" act on the whole local window. Additional
  hosts now just throw the resolver error.
- New command `remote-ssh.addFolderToWorkspace` ("Add SSH Folder to Workspace...", command palette and
  `view/title` of the Explorer) that runs the core `workbench.action.addRemoteFolderToWorkspace`.
- Server packages (fork-specific): the native backend no longer downloads the server for Linux remotes. Before the
  install script runs, and only when `<dataDir>/bin/<commit>/bin/<serverApplicationName>` is not there yet, it probes
  `uname -s`, `uname -m` and musl (`ldd --version`), picks the tarball with `pickServerPackage`
  (`src/serverPackage.ts`: x64/arm64, glibc or musl/Alpine) from `~/.supercode/server-packages/<commit>/`
  (written by `scripts/supercode/build.sh`) and streams it with a second system `ssh` process
  (same arguments and `BatchMode=yes`, minus `-D`/`-v`) as `cat > <dataDir>/<commit>-<tarball>`. A missing package or
  32-bit ARM fails the connection; there is no download fallback. Edits: `nativeSshManager.ts`
  (`uploadServerPackageIfNeeded`), `serverSetup.ts` (`localTarball` option, `resolveBashServerDataDir`),
  `scripts/server-setup.sh` (`SERVER_LOCAL_TARBALL` replaces the download when the file exists; musl via `ldd`
  also selects the `alpine` platform). The opt-in `ssh2` backend and non-Linux remotes are unchanged (still download).

## Tests
`src/test/*.test.ts` (plain node mocha, no `vscode` import): `pnpm -C extensions/open-remote-ssh test`.

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
- Per-connection state moved from `RemoteSSHResolver` into `SSHSession`, kept in a `SessionRegistry`
  (`src/sessionRegistry.ts`) keyed by remote authority, so several hosts can be connected at once. A new resolve of
  an authority disposes only that authority's previous session; a failed resolve disposes its session.
- The resource label formatter is registered per session for its exact authority (was `ssh-remote+*`), so each
  host gets its own `SSH: <host>` label; it is disposed with the session.
- New command `remote-ssh.addFolderToWorkspace` ("Add SSH Folder to Workspace...", command palette and
  `view/title` of the Explorer) that runs the core `workbench.action.addRemoteFolderToWorkspace`.

## Tests
`src/test/*.test.ts` (plain node mocha, no `vscode` import): `pnpm -C extensions/open-remote-ssh test`.

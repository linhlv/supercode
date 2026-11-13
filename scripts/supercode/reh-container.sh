#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------
#
# Runs inside the Linux containers that scripts/supercode/build.sh starts; never on the host.
# Everything is built from /in/source.tar (`git archive` of the commit) in the container's own
# file system or volume, so the host's node_modules folders are never touched.
#
#   reh-container.sh deps <target>
#     Container of the target's arch and libc. Installs remote/ (the server's dependencies, with
#     their native modules) and writes /out/<target>-remote-deps.tgz.
#
#   reh-container.sh package <target> <commit>
#     Container of the target's arch, with the builder volume at /w. Installs the repository once
#     per commit, puts /deps/<target>-remote-deps.tgz in place of remote/node_modules, runs the
#     gulp task <target>-min and writes /out/<target>.tar.gz.

set -euo pipefail

MODE="${1:?mode}"
TARGET="${2:?target}"

case "$MODE" in
  deps)
    rm -rf /tmp/src
    mkdir -p /tmp/src
    tar -xf /in/source.tar -C /tmp/src
    cd /tmp/src/remote
    pnpm install --frozen-lockfile
    folders=(node_modules)
    [[ -d web/node_modules ]] && folders+=(web/node_modules)
    tar -czf "/out/$TARGET-remote-deps.tgz" "${folders[@]}"
    echo "remote dependencies of $TARGET ($(uname -m)) -> $TARGET-remote-deps.tgz"
    ;;
  package)
    COMMIT="${3:?commit}"
    if [[ "$(cat /w/.commit 2>/dev/null || true)" != "$COMMIT" ]]; then
      rm -rf /w/vscode /w/.commit
      mkdir -p /w/vscode
      tar -xf /in/source.tar -C /w/vscode
      (cd /w/vscode && ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile)
      echo "$COMMIT" > /w/.commit
    fi
    rm -rf /w/vscode/remote/node_modules /w/vscode/remote/web/node_modules
    tar -xzf "/deps/$TARGET-remote-deps.tgz" -C /w/vscode/remote
    # The source has no .git folder, so the build takes the commit from here
    (cd /w/vscode && BUILD_SOURCEVERSION="$COMMIT" pnpm run gulp "$TARGET-min")
    # The server folder is the tarball's single top level folder (server-setup.sh uses --strip-components 1)
    tar -czf "/out/$TARGET.tar.gz" -C /w "$TARGET"
    rm -rf "/w/$TARGET"
    echo "server $TARGET ($(uname -m)) -> $TARGET.tar.gz"
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    exit 2
    ;;
esac

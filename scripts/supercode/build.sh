#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------
#
# Builds Supercode for macOS (arm64) and the remote server for every supported remote platform.
# The server tarballs are what the Remote SSH extension uploads to remote hosts, so they are
# written to ~/.supercode/server-packages/<commit>/vscode-reh-<target>.tar.gz.
#
# Usage: scripts/supercode/build.sh [--dry-run]
#   --dry-run   print the gulp commands and output paths without running anything
#
# The two Alpine (musl) server targets run in Docker, which must be running.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' | sed '1d'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_ROOT="$(dirname "$ROOT")"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
PACKAGES_DIR="$HOME/.supercode/server-packages/$COMMIT"

APP_TARGET="vscode-darwin-arm64-min"
APP_OUTPUT="$BUILD_ROOT/VSCode-darwin-arm64"
# gulp target (without -min) -> must match the tarball names pickServerPackage() returns
SERVER_TARGETS=(
  "vscode-reh-linux-x64"
  "vscode-reh-linux-arm64"
  "vscode-reh-linux-alpine"
  "vscode-reh-alpine-arm64"
)

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker is not running; it is required for the Alpine server targets." >&2
    exit 1
  fi
fi

cd "$ROOT"
echo "Commit: $COMMIT"
echo "Server packages: $PACKAGES_DIR"
[[ "$DRY_RUN" -eq 1 ]] && echo "(dry run: nothing is executed)"

run mkdir -p "$PACKAGES_DIR"

run pnpm run gulp "$APP_TARGET"
echo "  app -> $APP_OUTPUT/"

for target in "${SERVER_TARGETS[@]}"; do
  run pnpm run gulp "$target-min"
  # The server folder is the tarball's single top level folder (server-setup.sh uses --strip-components 1)
  run tar -czf "$PACKAGES_DIR/$target.tar.gz" -C "$BUILD_ROOT" "$target"
  echo "  server -> $PACKAGES_DIR/$target.tar.gz"
done

echo "Done."

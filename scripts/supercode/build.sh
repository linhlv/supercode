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
#   --dry-run   print the commands and output paths without running anything
#
# The app is built on this Mac. Every server is built in Linux containers (Docker must be
# running) of the target's architecture, so that its native modules (node-pty, @parcel/watcher,
# ...) are Linux binaries of that architecture:
#   1. remote/ is installed in a container of the target's arch and libc: Debian 11 (glibc) for
#      linux-x64/arm64, Alpine (musl) for the alpine targets;
#   2. the gulp task vscode-reh-<target>-min packages the server in a glibc container of the
#      target's arch, with the dependencies of step 1 as remote/node_modules;
#   3. pty.node and watcher.node in the tarball are checked with `file` to be ELF binaries of the
#      target's arch; otherwise the tarball is deleted and the build fails.
# The containers build from `git archive` of the commit, inside their own file system or the
# Docker volumes supercode-reh-builder-amd64/-arm64 (which cache the repository install; remove them
# with `docker volume rm` to reclaim the space). The host's node_modules folders are not touched.
# Uncommitted changes are not part of the servers.

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
WORK_DIR="$ROOT/.build/supercode-reh"
DOCKER_DIR="$ROOT/scripts/supercode/docker"
CONTAINER_SCRIPT="$ROOT/scripts/supercode/reh-container.sh"

NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json")"

APP_TARGET="vscode-darwin-arm64-min"
APP_OUTPUT="$BUILD_ROOT/VSCode-darwin-arm64"
# gulp target (without -min) | docker platform | libc of the dependencies | `file` output of its native modules.
# The targets must match the tarball names pickServerPackage() returns.
SERVER_TARGETS=(
  "vscode-reh-linux-x64|linux/amd64|glibc|ELF 64-bit LSB .*x86-64"
  "vscode-reh-linux-arm64|linux/arm64|glibc|ELF 64-bit LSB .*ARM aarch64"
  "vscode-reh-linux-alpine|linux/amd64|alpine|ELF 64-bit LSB .*x86-64"
  "vscode-reh-alpine-arm64|linux/arm64|alpine|ELF 64-bit LSB .*ARM aarch64"
)
# Native modules every server must contain as Linux binaries of its arch
NATIVE_MODULES=(pty.node watcher.node)

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

# Checksum of the official Node.js build for linux-<arch> (build/checksums/nodejs.txt)
node_sha256() {
  local name="node-v$NODE_VERSION-linux-$1.tar.gz"
  local sum
  sum="$(awk -v name="$name" '$2 == name { print $1 }' "$ROOT/build/checksums/nodejs.txt")"
  if [[ -z "$sum" ]]; then
    echo "Error: no checksum for $name in build/checksums/nodejs.txt." >&2
    exit 1
  fi
  echo "$sum"
}

# Tag of the image of one kind (deps-glibc, deps-alpine, builder) for one docker platform
image_tag() {
  echo "supercode-reh-$1:$NODE_VERSION-${2#linux/}"
}

# Builds (or reuses, from the Docker cache) that image
build_image() {
  local kind="$1" platform="$2"
  local arch="${platform#linux/}"
  local args=(--platform "$platform" -t "$(image_tag "$kind" "$platform")" -f "$DOCKER_DIR/$kind.Dockerfile" --build-arg "NODE_VERSION=$NODE_VERSION" --build-arg "PNPM_VERSION=$PNPM_VERSION")
  if [[ "$kind" == "deps-glibc" ]]; then
    local node_arch="x64" sha
    [[ "$arch" == "arm64" ]] && node_arch="arm64"
    sha="$(node_sha256 "$node_arch")"
    args+=(--build-arg "NODE_ARCH=$node_arch" --build-arg "NODE_SHA256=$sha")
  fi
  run docker build -q "${args[@]}" "$DOCKER_DIR"
}

# Fails, and deletes the tarball, unless every native module in it is a Linux binary matching $2
verify_package() {
  local tarball="$1" pattern="$2"
  echo "+ verify $tarball: ${NATIVE_MODULES[*]} match '$pattern'"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi
  local tmp entries entry info name status=0
  tmp="$(mktemp -d)"
  for name in "${NATIVE_MODULES[@]}"; do
    entries="$(tar -tzf "$tarball" | grep "/$name\$" || true)"
    if [[ -z "$entries" ]]; then
      echo "Error: $tarball contains no $name." >&2
      status=1
      continue
    fi
    # shellcheck disable=SC2086 # one entry per line, entries contain no spaces
    tar -xzf "$tarball" -C "$tmp" $entries
    while IFS= read -r entry; do
      info="$(file -b "$tmp/$entry")"
      if [[ "$info" =~ $pattern ]]; then
        echo "  ok   $entry: $info"
      else
        echo "  FAIL $entry: $info" >&2
        status=1
      fi
    done <<< "$entries"
  done
  rm -rf "$tmp"
  if [[ "$status" -ne 0 ]]; then
    rm -f "$tarball"
    echo "Error: $tarball has native modules that are not Linux binaries of its arch; deleted it." >&2
    exit 1
  fi
}

if [[ "$DRY_RUN" -eq 0 ]]; then
  if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker is not running; it is required to build the Linux servers." >&2
    exit 1
  fi
fi
if [[ -z "$PNPM_VERSION" ]]; then
  echo "Error: package.json does not pin pnpm in its packageManager field." >&2
  exit 1
fi

cd "$ROOT"
echo "Commit: $COMMIT"
echo "Server packages: $PACKAGES_DIR"
[[ "$DRY_RUN" -eq 1 ]] && echo "(dry run: nothing is executed)"

run mkdir -p "$PACKAGES_DIR" "$WORK_DIR"

run pnpm run gulp "$APP_TARGET"
echo "  app -> $APP_OUTPUT/"

echo "+ git archive --format=tar HEAD > $WORK_DIR/source.tar"
if [[ "$DRY_RUN" -eq 0 ]]; then
  git -C "$ROOT" archive --format=tar HEAD > "$WORK_DIR/source.tar"
fi

for entry in "${SERVER_TARGETS[@]}"; do
  IFS='|' read -r target platform libc pattern <<< "$entry"
  arch="${platform#linux/}"

  build_image "deps-$libc" "$platform"
  run docker run --rm --platform "$platform" \
    -v "$WORK_DIR/source.tar:/in/source.tar:ro" \
    -v "$WORK_DIR:/out" \
    -v "$CONTAINER_SCRIPT:/reh-container.sh:ro" \
    "$(image_tag "deps-$libc" "$platform")" bash /reh-container.sh deps "$target"

  build_image builder "$platform"
  run docker run --rm --platform "$platform" \
    -v "supercode-reh-builder-$arch:/w" \
    -v "$WORK_DIR/source.tar:/in/source.tar:ro" \
    -v "$WORK_DIR:/deps:ro" \
    -v "$PACKAGES_DIR:/out" \
    -v "$CONTAINER_SCRIPT:/reh-container.sh:ro" \
    "$(image_tag builder "$platform")" bash /reh-container.sh package "$target" "$COMMIT"

  verify_package "$PACKAGES_DIR/$target.tar.gz" "$pattern"
  run rm -f "$WORK_DIR/$target-remote-deps.tgz"
  echo "  server -> $PACKAGES_DIR/$target.tar.gz"
done

run rm -f "$WORK_DIR/source.tar"
echo "Done."

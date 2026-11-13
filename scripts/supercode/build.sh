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
# Usage: scripts/supercode/build.sh [--dry-run] [--skip-app] [--target <name>]...
#   --dry-run          print the commands and output paths without running anything
#   --skip-app         don't build the macOS app (reuse the one already built)
#   --target <name>    build only this server: linux-x64, linux-arm64, linux-alpine or alpine-arm64;
#                      repeat it for several. Without it, all four are built.
# Example, the linux-x64 server only, reusing the app: scripts/supercode/build.sh --skip-app --target linux-x64
#
# The app is built on this Mac. Every server is built in Linux containers (Docker must be
# running) of the target's architecture, so that its native modules (node-pty, @parcel/watcher,
# ...) are Linux binaries of that architecture:
#   1. remote/ is installed in a container of the target's arch and libc: Debian 11 (glibc) for
#      linux-x64/arm64, Alpine (musl) for the alpine targets;
#   2. the gulp task vscode-reh-<target>-min packages the server in a glibc container of the
#      target's arch, with the dependencies of step 1 as remote/node_modules;
#   3. pty.node and watcher.node in the tarball (and node, for Alpine) are checked with `file` to be
#      ELF binaries of the target's arch, linked against musl for Alpine and not for glibc; otherwise
#      the tarball is deleted and the build fails.
# For Alpine, step 1 also hands over the container's musl node: the gulp task would otherwise take it
# from a `docker run` of the node Alpine image, and the containers have no docker.
# The containers build from `git archive` of the commit, inside their own file system or the
# Docker volumes supercode-reh-builder-amd64/-arm64 (which cache the repository install; remove them
# with `docker volume rm` to reclaim the space). The host's node_modules folders are not touched.
# Uncommitted changes are not part of the servers.

set -euo pipefail

DRY_RUN=0
SKIP_APP=0
SELECTED_TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-app) SKIP_APP=1 ;;
    --target)
      case "${2:-}" in
        linux-x64 | linux-arm64 | linux-alpine | alpine-arm64) SELECTED_TARGETS+=("vscode-reh-$2") ;;
        *)
          echo "Unknown --target '${2:-}': use linux-x64, linux-arm64, linux-alpine or alpine-arm64." >&2
          exit 2
          ;;
      esac
      shift
      ;;
    -h | --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' | sed '1d'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
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

# Fails, and deletes the tarball, unless every native module in it (and, for Alpine, its node) is a
# Linux binary matching $2 for the libc $3: musl for alpine (the node binary's interpreter is
# /lib/ld-musl-*, shared objects need libc.musl-*), glibc otherwise (nothing linked against musl).
verify_package() {
  local tarball="$1" pattern="$2" libc="$3" target="$4"
  local checks=("${NATIVE_MODULES[@]}")
  [[ "$libc" == "alpine" ]] && checks+=(node)
  echo "+ verify $tarball: ${checks[*]} match '$pattern', $libc"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi
  local tmp entries entry info name musl status=0
  tmp="$(mktemp -d)"
  for name in "${checks[@]}"; do
    if [[ "$name" == "node" ]]; then
      entries="$(tar -tzf "$tarball" | grep -x "$target/node" || true)"
    else
      entries="$(tar -tzf "$tarball" | grep "/$name\$" || true)"
    fi
    if [[ -z "$entries" ]]; then
      echo "Error: $tarball contains no $name." >&2
      status=1
      continue
    fi
    # shellcheck disable=SC2086 # one entry per line, entries contain no spaces
    tar -xzf "$tarball" -C "$tmp" $entries
    while IFS= read -r entry; do
      info="$(file -b "$tmp/$entry")"
      musl=0
      if [[ "$info" == *"/lib/ld-musl"* ]] || grep -aq 'libc\.musl-' "$tmp/$entry"; then
        musl=1
      fi
      if [[ ! "$info" =~ $pattern ]]; then
        echo "  FAIL $entry (not $pattern): $info" >&2
        status=1
      elif [[ "$libc" == "alpine" && "$musl" -eq 0 ]]; then
        echo "  FAIL $entry (not linked against musl): $info" >&2
        status=1
      elif [[ "$libc" != "alpine" && "$musl" -eq 1 ]]; then
        echo "  FAIL $entry (linked against musl): $info" >&2
        status=1
      else
        echo "  ok   $entry ($libc): $info"
      fi
    done <<< "$entries"
  done
  rm -rf "$tmp"
  if [[ "$status" -ne 0 ]]; then
    rm -f "$tarball"
    echo "Error: $tarball has binaries that are not Linux $libc binaries of its arch; deleted it." >&2
    exit 1
  fi
}

# Intermediate files (source archive, dependencies, Alpine node) never outlive a run, failed or not
cleanup() {
  if [[ "$DRY_RUN" -eq 0 ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

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
if [[ ${#SELECTED_TARGETS[@]} -gt 0 ]]; then
  echo "Servers: ${SELECTED_TARGETS[*]}"
fi
[[ "$DRY_RUN" -eq 1 ]] && echo "(dry run: nothing is executed)"

run mkdir -p "$PACKAGES_DIR" "$WORK_DIR"

if [[ "$SKIP_APP" -eq 1 ]]; then
  echo "  app: skipped (--skip-app), reusing $APP_OUTPUT/"
else
  run pnpm run gulp "$APP_TARGET"
  echo "  app -> $APP_OUTPUT/"
fi

echo "+ git archive --format=tar HEAD > $WORK_DIR/source.tar"
if [[ "$DRY_RUN" -eq 0 ]]; then
  git -C "$ROOT" archive --format=tar HEAD > "$WORK_DIR/source.tar"
fi

for entry in "${SERVER_TARGETS[@]}"; do
  IFS='|' read -r target platform libc pattern <<< "$entry"
  if [[ ${#SELECTED_TARGETS[@]} -gt 0 && " ${SELECTED_TARGETS[*]} " != *" $target "* ]]; then
    continue
  fi
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

  verify_package "$PACKAGES_DIR/$target.tar.gz" "$pattern" "$libc" "$target"
  run rm -f "$WORK_DIR/$target-remote-deps.tgz" "$WORK_DIR/$target-node" "$WORK_DIR/$target-node.version"
  echo "  server -> $PACKAGES_DIR/$target.tar.gz"
done

run rm -f "$WORK_DIR/source.tar"
echo "Done."

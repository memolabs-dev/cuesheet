#!/usr/bin/env bash
# Install the cuesheet command for the current user.
#
#   scripts/install.sh [--no-build]
#
# Builds dist/, copies it out of the checkout as the runtime, and writes
# bin/cuesheet onto PATH with the runtime and node filled in as absolute paths.
# Each location can be overridden:
#
#   CUESHEET_RUNTIME   ${XDG_DATA_HOME:-$HOME/.local/share}/cuesheet/runtime
#   CUESHEET_BIN_DIR   $HOME/.local/bin
#   CUESHEET_NODE      the node on PATH now (22 or newer)
#   CUESHEET_DIST      the build to install, default dist/ (with --no-build)
#
# The runtime is a copy, not a link into this checkout, so switching branches or
# removing a worktree neither changes nor breaks the installed command. The
# install is not done until the installed command answers --help with a bare
# PATH, which is how Finder, launchd and hooks start it.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install: unknown argument $arg" >&2; exit 2 ;;
  esac
done

RUNTIME="${CUESHEET_RUNTIME:-${XDG_DATA_HOME:-$HOME/.local/share}/cuesheet/runtime}"
BIN_DIR="${CUESHEET_BIN_DIR:-$HOME/.local/bin}"
DIST="${CUESHEET_DIST:-$ROOT/dist}"
NODE="${CUESHEET_NODE:-$(command -v node || true)}"

case "$NODE" in
  /*) ;;
  *) echo "install: node not found as an absolute path; set CUESHEET_NODE" >&2; exit 1 ;;
esac
[ -x "$NODE" ] || { echo "install: $NODE is not executable" >&2; exit 1; }
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "install: $NODE is older than node 22" >&2; exit 1; }
case "$RUNTIME" in
  /*/runtime) ;;
  *) echo "install: CUESHEET_RUNTIME must be an absolute path ending in /runtime: $RUNTIME" >&2; exit 1 ;;
esac

if [ "$BUILD" = 1 ]; then
  bash "$ROOT/scripts/build.sh"
fi
[ -f "$DIST/src/cuesheet.js" ] || { echo "install: $DIST/src/cuesheet.js missing; build first" >&2; exit 1; }

# The runtime is replaced whole: staged beside the old one, then swapped, so a
# failed copy leaves the previous runtime in place.
mkdir -p "$(dirname "$RUNTIME")" "$BIN_DIR"
STAGE="$RUNTIME.new.$$"
OLD="$RUNTIME.old.$$"
rm -rf "$STAGE"
cp -R "$DIST" "$STAGE"
COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git -C "$ROOT" status --porcelain 2>/dev/null || true)"
printf '{"commit":"%s","dirty":%s,"installedAt":"%s"}\n' \
  "$COMMIT" "$([ -n "$DIRTY" ] && echo true || echo false)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$STAGE/INSTALLED.json"
if [ -e "$RUNTIME" ]; then mv "$RUNTIME" "$OLD"; fi
mv "$STAGE" "$RUNTIME"
rm -rf "$OLD"

# The shim, with its two values filled in. Shell-quoted, so no path can break it.
SHIM="$(cat "$ROOT/bin/cuesheet")"
SHIM="${SHIM/INSTALLED_ROOT=\"\"/INSTALLED_ROOT=$(printf '%q' "$RUNTIME")}"
SHIM="${SHIM/INSTALLED_NODE=\"\"/INSTALLED_NODE=$(printf '%q' "$NODE")}"
case "$SHIM" in
  *'INSTALLED_ROOT=""'*|*'INSTALLED_NODE=""'*) echo "install: bin/cuesheet no longer has the values this script fills in" >&2; exit 1 ;;
esac
printf '%s\n' "$SHIM" > "$BIN_DIR/cuesheet.new.$$"
chmod 755 "$BIN_DIR/cuesheet.new.$$"
mv "$BIN_DIR/cuesheet.new.$$" "$BIN_DIR/cuesheet"

if ! env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$BIN_DIR/cuesheet" --help > /dev/null; then
  echo "install: $BIN_DIR/cuesheet --help failed with a bare PATH" >&2
  exit 1
fi

echo "install: runtime $RUNTIME (commit $COMMIT)" >&2
echo "install: command $BIN_DIR/cuesheet, node $NODE" >&2
echo "install: ok, cuesheet --help answers with a bare PATH" >&2

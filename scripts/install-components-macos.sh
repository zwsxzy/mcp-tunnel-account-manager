#!/bin/bash
# Finder launches do not necessarily inherit Homebrew's PATH.
set -u
if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  printf '%s\n' '[失败] 此安装入口只支持 macOS（Apple Silicon / Intel）。' >&2
  exit 1
fi
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)" || exit 1
export PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:/opt/homebrew/bin:/usr/local/bin"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  printf '%s\n' '[失败] 未找到 Node.js >= 22.14.0。请先从 https://nodejs.org/ 安装 Node.js（包含 npm），再重新双击 Install-Components.command。' >&2
  exit 1
fi
exec "$NODE_BIN" "$SCRIPT_DIR/install-components-macos.mjs" "$@"

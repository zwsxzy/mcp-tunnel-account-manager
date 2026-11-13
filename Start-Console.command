#!/bin/bash
# Compatible with the Bash 3.2 shipped by macOS; quoted paths support Finder.
set -u
if [ "$(/usr/bin/uname -s)" != "Darwin" ]; then
  printf '%s\n' '此启动入口用于 macOS。其他平台请使用 npm start。' >&2
  exit 1
fi
PROJECT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)" || exit 1
export PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:/opt/homebrew/bin:/usr/local/bin"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  printf '%s\n' '未找到 Node.js >= 22.14.0。请先从 https://nodejs.org/ 安装，再运行本文件。' >&2
  exit 1
fi
cd "$PROJECT_DIR" || exit 1
export MCP_OPEN_BROWSER=1
printf '%s\n' '正在启动本地控制台。请保持此终端窗口打开；按 Control+C 关闭控制台。'
"$NODE_BIN" "$PROJECT_DIR/scripts/launch-manager.mjs" "$@"
RESULT=$?
if [ "$RESULT" -ne 0 ] && [ -t 0 ] && [ -t 1 ]; then
  printf '\n%s' '启动未完成。请查看上方原因，按回车关闭此窗口…'
  IFS= read -r _ || true
fi
exit "$RESULT"

#!/bin/bash
set -u
PROJECT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)" || exit 1
/bin/bash "$PROJECT_DIR/scripts/install-components-macos.sh" "$@"
RESULT=$?
if [ -t 0 ] && [ -t 1 ] && [ "$#" -eq 0 ]; then
  printf '\n%s' '按回车键关闭此窗口…'
  IFS= read -r _ || true
fi
exit "$RESULT"

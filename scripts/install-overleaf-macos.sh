#!/bin/bash
set -u
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)" || exit 1
exec /bin/bash "$SCRIPT_DIR/install-components-macos.sh" --component overleaf-mcp "$@"

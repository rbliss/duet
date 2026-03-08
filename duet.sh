#!/usr/bin/env bash
# duet - Unified Claude Code + Codex console
# Default: runs built dist/ artifacts. Set DUET_USE_SOURCE=1 for dev (requires tsx).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${DUET_USE_SOURCE:-}" = "1" ]; then
  exec node --import tsx/esm "$DIR/src/cli/duet.ts" "$@"
else
  if [ ! -f "$DIR/dist/cli/duet.js" ]; then
    echo "Error: dist/cli/duet.js not found — run 'npm run build' first." >&2
    echo "       Or set DUET_USE_SOURCE=1 for development mode (requires tsx)." >&2
    exit 1
  fi
  exec node "$DIR/dist/cli/duet.js" "$@"
fi

#!/usr/bin/env bash
# duet - Unified Claude Code + Codex console
# Thin compatibility shim — all logic lives in src/cli/duet.mjs (or dist/)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${DUET_USE_DIST:-}" = "1" ]; then
  exec node "$DIR/dist/cli/duet.mjs" "$@"
else
  exec node "$DIR/src/cli/duet.mjs" "$@"
fi

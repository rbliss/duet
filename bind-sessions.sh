#!/usr/bin/env bash
# bind-sessions.sh - Compatibility shim for the binding reconciler.
# Actual logic lives in src/bindings/reconciler.ts (or dist/).
#
# Expects the same environment variables as before:
#   CLAUDE_SESSION_ID, CLAUDE_PROJECTS, CODEX_SESSIONS,
#   STATE_DIR, WORKDIR, BIND_TIMEOUT (default 240),
#   GLOBAL_CODEX_SESSIONS (default ~/.codex/sessions)
# Optional (resume fast-path):
#   RESUME_CLAUDE_PATH, RESUME_CODEX_PATH, RESUME_CODEX_SESSION_ID
#
# Outputs:
#   $STATE_DIR/bindings.json  - formal binding manifest
#   Exit code 0 always

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${DUET_USE_DIST:-}" = "1" ]; then
  exec node "$DIR/dist/bindings/reconciler.js" "$@"
else
  exec node --import tsx/esm "$DIR/src/bindings/reconciler.ts" "$@"
fi

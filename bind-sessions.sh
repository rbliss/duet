#!/usr/bin/env bash
# bind-sessions.sh - Session binding logic for Duet
#
# Extracted from duet.sh so it can be tested independently.
# Expects these environment variables:
#   CLAUDE_SESSION_ID  - UUID passed to claude --session-id
#   CLAUDE_PROJECTS    - root dir for Claude session files
#   CODEX_SESSIONS     - run-scoped Codex sessions dir (isolated via CODEX_HOME)
#   STATE_DIR          - where to write binding results
#   WORKDIR            - working directory for Codex cwd fallback matching
#   BIND_TIMEOUT       - max poll iterations (default 30 = 15s at 0.5s each)
#
# Codex binding strategy:
#   1. Primary: look in the isolated CODEX_SESSIONS dir (process-level ownership).
#   2. Fallback: if CODEX_HOME isolation produced nothing, scan ~/.codex/sessions/
#      for new files matching WORKDIR via session_meta.cwd (workspace-level ownership).
#   The binding level in the manifest reflects which path was taken.
#
# Outputs:
#   $STATE_DIR/bindings.json  - formal binding manifest for the router
#   Exit code 0 always (partial binding is not an error)

set -e

: "${BIND_TIMEOUT:=30}"

: "${GLOBAL_CODEX_SESSIONS:=$HOME/.codex/sessions}"

# Snapshot global Codex sessions before launch (for fallback cwd matching)
find "$GLOBAL_CODEX_SESSIONS" -name '*.jsonl' -type f 2>/dev/null | sort > "$STATE_DIR/codex-before.list"

# Poll for both session files (check every 0.5s)
CLAUDE_BOUND=false
CODEX_BOUND=false
CLAUDE_SESSION_FILE=""
CODEX_SESSION_FILE=""
CODEX_LEVEL=""

for i in $(seq 1 "$BIND_TIMEOUT"); do
  sleep 0.5
  # Claude: find our UUID file anywhere in the projects tree
  if [ "$CLAUDE_BOUND" = false ]; then
    CLAUDE_SESSION_FILE=$(find "$CLAUDE_PROJECTS" -name "$CLAUDE_SESSION_ID.jsonl" -type f 2>/dev/null | head -1)
    if [ -n "$CLAUDE_SESSION_FILE" ]; then
      CLAUDE_BOUND=true
    fi
  fi
  # Codex primary: find any .jsonl in the isolated sessions dir
  if [ "$CODEX_BOUND" = false ]; then
    CODEX_SESSION_FILE=$(find "$CODEX_SESSIONS" -name '*.jsonl' -type f 2>/dev/null | head -1)
    if [ -n "$CODEX_SESSION_FILE" ]; then
      CODEX_BOUND=true
      CODEX_LEVEL="process"
    fi
  fi
  # Stop polling once both are bound
  if [ "$CLAUDE_BOUND" = true ] && [ "$CODEX_BOUND" = true ]; then
    break
  fi
done

# Codex fallback: if isolation produced nothing, try global sessions with cwd matching
if [ "$CODEX_BOUND" = false ]; then
  find "$GLOBAL_CODEX_SESSIONS" -name '*.jsonl' -type f 2>/dev/null | sort > "$STATE_DIR/codex-after.list"
  for candidate in $(comm -13 "$STATE_DIR/codex-before.list" "$STATE_DIR/codex-after.list"); do
    CANDIDATE_CWD=$(head -1 "$candidate" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('payload',{}).get('cwd',''))" 2>/dev/null)
    if [ "$CANDIDATE_CWD" = "$WORKDIR" ]; then
      CODEX_SESSION_FILE="$candidate"
      CODEX_BOUND=true
      CODEX_LEVEL="workspace"
      break
    fi
  done
fi
rm -f "$STATE_DIR/codex-before.list" "$STATE_DIR/codex-after.list"

# Write formal binding manifest
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

claude_status="unbound"
claude_path=""
claude_level=""
if [ "$CLAUDE_BOUND" = true ]; then
  claude_status="bound"
  claude_path="$CLAUDE_SESSION_FILE"
  claude_level="process"
fi

codex_status="unbound"
codex_path=""
codex_level=""
if [ "$CODEX_BOUND" = true ]; then
  codex_status="bound"
  codex_path="$CODEX_SESSION_FILE"
  codex_level="$CODEX_LEVEL"
fi

python3 -c "
import json, sys
bindings = {
    'claude': {
        'path': sys.argv[1] or None,
        'level': sys.argv[2] or None,
        'status': sys.argv[3],
        'confirmedAt': sys.argv[5] if sys.argv[3] == 'bound' else None,
    },
    'codex': {
        'path': sys.argv[4] or None,
        'level': sys.argv[6] or None,
        'status': sys.argv[7],
        'confirmedAt': sys.argv[5] if sys.argv[7] == 'bound' else None,
    },
}
json.dump(bindings, sys.stdout, indent=2)
" "$claude_path" "$claude_level" "$claude_status" "$codex_path" "$NOW" "$codex_level" "$codex_status" \
  > "$STATE_DIR/bindings.json"

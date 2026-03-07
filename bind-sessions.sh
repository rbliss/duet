#!/usr/bin/env bash
# bind-sessions.sh - Session binding reconciler for Duet
#
# Runs as a background process. Owns the full binding lifecycle:
#   pending → bound    (session file discovered)
#   pending → degraded (deadline expired without discovery)
#
# Extracted from duet.sh so it can be tested independently.
# Expects these environment variables:
#   CLAUDE_SESSION_ID  - UUID passed to claude --session-id
#   CLAUDE_PROJECTS    - root dir for Claude session files
#   CODEX_SESSIONS     - run-scoped Codex sessions dir (isolated via CODEX_HOME)
#   STATE_DIR          - where to write binding results
#   WORKDIR            - working directory for Codex cwd fallback matching
#   BIND_TIMEOUT       - max poll iterations (default 240 = 120s at 0.5s each)
#
# Optional (resume fast-path):
#   RESUME_CLAUDE_PATH - stored Claude session path to verify
#   RESUME_CODEX_PATH  - stored Codex session path to verify
#
# Codex binding strategy:
#   1. Primary: look in the isolated CODEX_SESSIONS dir (process-level ownership).
#   2. Fallback: if CODEX_HOME isolation produced nothing, scan ~/.codex/sessions/
#      for new files matching WORKDIR via session_meta.cwd (workspace-level ownership).
#   The binding level in the manifest reflects which path was taken.
#
# Outputs:
#   $STATE_DIR/bindings.json  - formal binding manifest (updated incrementally)
#   Exit code 0 always (partial binding is not an error)

set -e

: "${BIND_TIMEOUT:=240}"

: "${GLOBAL_CODEX_SESSIONS:=$HOME/.codex/sessions}"

# --- Manifest writer (called multiple times as tools are discovered) ---
claude_status="pending"
claude_path=""
claude_level=""
claude_session_id_val=""
codex_status="pending"
codex_path=""
codex_level=""
codex_session_id_val=""

write_manifest() {
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  python3 -c "
import json, sys
bindings = {
    'claude': {
        'path': sys.argv[1] or None,
        'level': sys.argv[2] or None,
        'status': sys.argv[3],
        'confirmedAt': sys.argv[5] if sys.argv[3] == 'bound' else None,
        'session_id': sys.argv[8] or None,
    },
    'codex': {
        'path': sys.argv[4] or None,
        'level': sys.argv[6] or None,
        'status': sys.argv[7],
        'confirmedAt': sys.argv[5] if sys.argv[7] == 'bound' else None,
        'session_id': sys.argv[9] or None,
    },
}
json.dump(bindings, sys.stdout, indent=2)
" "$claude_path" "$claude_level" "$claude_status" "$codex_path" "$now" "$codex_level" "$codex_status" \
  "$claude_session_id_val" "$codex_session_id_val" \
    > "$STATE_DIR/bindings.json"
}

# Extract Codex session ID from a session file's first line
extract_codex_session_id() {
  head -1 "$1" 2>/dev/null | python3 -c "
import sys,json
try:
    d = json.load(sys.stdin)
    print(d.get('payload',{}).get('id',''))
except:
    print('')
" 2>/dev/null
}

# --- Resume fast-path: verify stored session paths ---
# Only accepts a stored path if:
#   - Claude: filename matches $CLAUDE_SESSION_ID (prevents wrong-transcript binding)
#   - Codex: extracted payload.id matches $RESUME_CODEX_SESSION_ID if set
CLAUDE_BOUND=false
CODEX_BOUND=false

if [ -n "${RESUME_CLAUDE_PATH:-}" ] && [ -f "$RESUME_CLAUDE_PATH" ]; then
  RESUME_CLAUDE_BASENAME=$(basename "$RESUME_CLAUDE_PATH" .jsonl)
  if [ "$RESUME_CLAUDE_BASENAME" = "$CLAUDE_SESSION_ID" ]; then
    CLAUDE_BOUND=true
    claude_status="bound"
    claude_path="$RESUME_CLAUDE_PATH"
    claude_level="process"
    claude_session_id_val="$CLAUDE_SESSION_ID"
  fi
fi

if [ -n "${RESUME_CODEX_PATH:-}" ] && [ -f "$RESUME_CODEX_PATH" ]; then
  _extracted_id=$(extract_codex_session_id "$RESUME_CODEX_PATH")
  if [ -z "${RESUME_CODEX_SESSION_ID:-}" ] || [ "$_extracted_id" = "$RESUME_CODEX_SESSION_ID" ]; then
    CODEX_BOUND=true
    codex_status="bound"
    codex_path="$RESUME_CODEX_PATH"
    codex_level="process"
    codex_session_id_val="$_extracted_id"
  fi
fi

# Write initial manifest (pending or pre-verified bound)
write_manifest

# If both already verified from resume, we're done
if [ "$CLAUDE_BOUND" = true ] && [ "$CODEX_BOUND" = true ]; then
  exit 0
fi

# Snapshot global Codex sessions before launch (for fallback cwd matching)
find "$GLOBAL_CODEX_SESSIONS" -name '*.jsonl' -type f 2>/dev/null | sort > "$STATE_DIR/codex-before.list"

# Poll for both session files (check every 0.5s, up to BIND_TIMEOUT iterations)
for i in $(seq 1 "$BIND_TIMEOUT"); do
  sleep 0.5
  # Claude: find our UUID file anywhere in the projects tree
  if [ "$CLAUDE_BOUND" = false ]; then
    CLAUDE_SESSION_FILE=$(find "$CLAUDE_PROJECTS" -name "$CLAUDE_SESSION_ID.jsonl" -type f 2>/dev/null | head -1)
    if [ -n "$CLAUDE_SESSION_FILE" ]; then
      CLAUDE_BOUND=true
      claude_status="bound"
      claude_path="$CLAUDE_SESSION_FILE"
      claude_level="process"
      claude_session_id_val="$CLAUDE_SESSION_ID"
      write_manifest
    fi
  fi
  # Codex primary: find any .jsonl in the isolated sessions dir
  if [ "$CODEX_BOUND" = false ]; then
    CODEX_SESSION_FILE=$(find "$CODEX_SESSIONS" -name '*.jsonl' -type f 2>/dev/null | head -1)
    if [ -n "$CODEX_SESSION_FILE" ]; then
      CODEX_BOUND=true
      codex_status="bound"
      codex_path="$CODEX_SESSION_FILE"
      codex_level="process"
      codex_session_id_val=$(extract_codex_session_id "$CODEX_SESSION_FILE")
      write_manifest
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
      codex_path="$candidate"
      CODEX_BOUND=true
      codex_status="bound"
      codex_level="workspace"
      codex_session_id_val=$(extract_codex_session_id "$candidate")
      write_manifest
      break
    fi
  done
fi
rm -f "$STATE_DIR/codex-before.list" "$STATE_DIR/codex-after.list"

# Mark remaining unfound tools as "degraded" — binding deadline expired
if [ "$CLAUDE_BOUND" = false ]; then
  claude_status="degraded"
fi
if [ "$CODEX_BOUND" = false ]; then
  codex_status="degraded"
fi
write_manifest

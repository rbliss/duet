#!/usr/bin/env bash
# duet - Unified Claude Code + Codex console
#
# Usage:
#   duet [workdir]              New run (or attach if active run exists)
#   duet resume [run-id|last]   Resume a stopped run
#   duet fork [run-id|last]     Fork from an existing run
#   duet list                   List all runs
#   duet destroy <run-id>       Permanently remove a run
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUET_BASE="${DUET_BASE:-$HOME/.local/state/duet}"
RUNS_DIR="$DUET_BASE/runs"
WORKSPACES_DIR="$DUET_BASE/workspaces"

# Preflight checks
for cmd in tmux claude codex node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is not installed or not in PATH"
    exit 1
  fi
done

# ─── Utility functions ──────────────────────────────────────────────────────

cwd_hash() {
  echo -n "$1" | md5sum | cut -d' ' -f1
}

# Shell-quote a path for interpolation into tmux send-keys strings
quote_path() {
  printf '%q' "$1"
}

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Read a field from run.json (supports dotted keys like claude.session_id)
run_field() {
  local run_json="$1" key="$2"
  python3 -c "
import json, sys, functools
d = json.load(open(sys.argv[1]))
val = functools.reduce(lambda o, k: o.get(k, {}) if isinstance(o, dict) else {}, sys.argv[2].split('.'), d)
print(val if isinstance(val, str) else '' if val is None else '' if isinstance(val, dict) else str(val))
" "$run_json" "$key" 2>/dev/null
}

# Find the active run for a workspace (returns run_id or empty)
find_active_run() {
  local cwd="$1"
  local hash idx run_id run_json status
  hash=$(cwd_hash "$cwd")
  idx="$WORKSPACES_DIR/${hash}.json"
  [ -f "$idx" ] || return 1
  run_id=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('active',''))" "$idx" 2>/dev/null)
  [ -z "$run_id" ] && return 1
  run_json="$RUNS_DIR/$run_id/run.json"
  [ -f "$run_json" ] || return 1
  status=$(run_field "$run_json" status)
  [ "$status" = "active" ] || return 1
  echo "$run_id"
}

# Update workspace index (set or clear the active run)
update_workspace_index() {
  local cwd="$1" run_id="$2" active="$3"
  local hash idx
  hash=$(cwd_hash "$cwd")
  mkdir -p "$WORKSPACES_DIR"
  idx="$WORKSPACES_DIR/${hash}.json"
  python3 -c "
import json, sys, os
cwd, run_id, active, path = sys.argv[1:5]
data = {'cwd': cwd, 'runs': [], 'active': None}
if os.path.exists(path):
    try: data = json.load(open(path))
    except: pass
if run_id not in data.get('runs', []):
    data.setdefault('runs', []).append(run_id)
if active == 'true':
    data['active'] = run_id
elif active == 'clear' and data.get('active') == run_id:
    data['active'] = None
json.dump(data, open(path, 'w'), indent=2)
" "$cwd" "$run_id" "$active" "$idx"
}

# Merge key-value pairs into run.json (supports dotted keys)
write_run_json() {
  local path="$1"; shift
  python3 -c "
import json, sys, os
path = sys.argv[1]
data = {}
if os.path.exists(path):
    try: data = json.load(open(path))
    except: pass
i = 2
while i < len(sys.argv):
    key, val = sys.argv[i], sys.argv[i+1]
    if val == '': val = None
    if '.' in key:
        parent, child = key.split('.', 1)
        if parent not in data or not isinstance(data[parent], dict):
            data[parent] = {}
        data[parent][child] = val
    else:
        data[key] = val
    i += 2
json.dump(data, open(path, 'w'), indent=2)
" "$path" "$@"
}

# Set up a CODEX_HOME overlay with read-only config symlinks
setup_codex_home() {
  local codex_home="$1"
  mkdir -p "$codex_home/sessions"
  # Only share read-only config files — never mutable state stores
  for f in auth.json config.toml version.json; do
    [ -f "$HOME/.codex/$f" ] && ln -sf "$HOME/.codex/$f" "$codex_home/$f"
  done
  for d in rules skills; do
    [ -d "$HOME/.codex/$d" ] && ln -sf "$HOME/.codex/$d" "$codex_home/$d"
  done
}

# Build a composed prompt file for a tool.
# Starts from DUET.md, appends <workdir>/CLAUDE_ROLE.md or CODEX_ROLE.md if present.
# Usage: build_tool_prompt <tool> <workdir> <output_path>
build_tool_prompt() {
  local tool="$1" workdir="$2" output="$3"
  cp "$DIR/DUET.md" "$output"
  local role_file
  if [ "$tool" = "claude" ]; then
    role_file="$workdir/CLAUDE_ROLE.md"
  else
    role_file="$workdir/CODEX_ROLE.md"
  fi
  if [ -f "$role_file" ]; then
    local display_name
    if [ "$tool" = "claude" ]; then display_name="Claude"; else display_name="Codex"; fi
    printf '\n\n## Project-specific %s role\n\nThe following instructions come from `%s` in the project root.\n\n' \
      "$display_name" "$(basename "$role_file")" >> "$output"
    cat "$role_file" >> "$output"
  fi
}

# Create the 3-pane tmux layout (sets CLAUDE_PANE, CODEX_PANE, ROUTER_PANE)
create_tmux_layout() {
  local session="$1"
  local cols lines router_height codex_width

  tmux kill-session -t "$session" 2>/dev/null || true

  cols="$(tput cols)"
  lines="$(tput lines)"
  router_height=$(( lines * 30 / 100 ))
  codex_width=$(( (cols - 1) / 2 ))

  CLAUDE_PANE=$(tmux new-session -d -s "$session" \
    -x "$cols" -y "$lines" \
    -P -F '#{pane_id}')
  ROUTER_PANE=$(tmux split-window -v -t "$CLAUDE_PANE" -l "$router_height" \
    -P -F '#{pane_id}')
  CODEX_PANE=$(tmux split-window -h -t "$CLAUDE_PANE" -l "$codex_width" \
    -P -F '#{pane_id}')

  # Styling
  tmux set -t "$session" mouse on
  tmux set -t "$session" status on
  tmux set -t "$session" status-style "bg=#1a1a2e,fg=#cccccc"
  tmux set -t "$session" status-left " #[fg=#00d4ff,bold]DUET#[default] | "
  tmux set -t "$session" status-right \
    " #[fg=#ff79c6]Claude#[default] + #[fg=#50fa7b]Codex#[default] "
  tmux set -t "$session" status-left-length 20
  tmux set -t "$session" status-right-length 40
  tmux set -t "$session" pane-border-style "fg=#444444"
  tmux set -t "$session" pane-active-border-style "fg=#00bfff,bold"

  tmux select-pane -t "$CLAUDE_PANE" -T "Claude Code"
  tmux select-pane -t "$CODEX_PANE" -T "Codex"
  tmux select-pane -t "$ROUTER_PANE" -T "Duet Router"
  tmux set -t "$session" pane-border-format " #{pane_title} "
  tmux set -t "$session" pane-border-status top
}

# Launch the router process in the bottom pane
launch_router() {
  local session="$1" run_dir="$2" mode="$3"
  local q_run_dir q_dir
  q_run_dir=$(quote_path "$run_dir")
  q_dir=$(quote_path "$DIR")
  tmux send-keys -t "$ROUTER_PANE" \
    "DUET_SESSION=$session CLAUDE_PANE=$CLAUDE_PANE CODEX_PANE=$CODEX_PANE DUET_STATE_DIR=$q_run_dir DUET_MODE=$mode DUET_RUN_DIR=$q_run_dir node $q_dir/router.mjs" \
    Enter
  tmux select-pane -t "$ROUTER_PANE"
}

# Resolve run-id from reference (exact, prefix, or "last")
# Errors on ambiguous prefix match to prevent wrong-run operations.
resolve_run_id() {
  local ref="$1"
  if [ "$ref" = "last" ] || [ -z "$ref" ]; then
    # Find most recently updated run
    local latest="" latest_time=""
    for d in "$RUNS_DIR"/*/run.json; do
      [ -f "$d" ] || continue
      local t
      t=$(run_field "$d" updated_at)
      if [ -z "$latest_time" ] || [[ "$t" > "$latest_time" ]]; then
        latest_time="$t"
        latest=$(run_field "$d" run_id)
      fi
    done
    echo "$latest"
  elif [ -d "$RUNS_DIR/$ref" ]; then
    echo "$ref"
  else
    # Prefix match — require exactly one result
    local matches=()
    for d in "$RUNS_DIR/$ref"*/; do
      [ -d "$d" ] || continue
      matches+=("$(basename "$d")")
    done
    if [ ${#matches[@]} -eq 1 ]; then
      echo "${matches[0]}"
    elif [ ${#matches[@]} -gt 1 ]; then
      echo "Error: ambiguous prefix '$ref' matches ${#matches[@]} runs:" >&2
      for m in "${matches[@]}"; do echo "  ${m:0:8}" >&2; done
      return 1
    fi
  fi
}

# ─── Subcommand: new (or attach) ────────────────────────────────────────────

cmd_new() {
  local workdir
  workdir="$(cd "${1:-$(pwd)}" && pwd -P)"

  # Check for existing active run for this workspace
  local active_run
  active_run=$(find_active_run "$workdir" 2>/dev/null || true)
  if [ -n "$active_run" ]; then
    local tmux_session
    tmux_session=$(run_field "$RUNS_DIR/$active_run/run.json" tmux_session)
    if [ -n "$tmux_session" ] && tmux has-session -t "$tmux_session" 2>/dev/null; then
      echo "Active run exists for this workspace — attaching."
      echo "  run: ${active_run:0:8}"
      echo "  tmux: $tmux_session"
      echo "Stop it first with /quit, or use 'duet destroy ${active_run:0:8}' to remove."
      tmux attach -t "$tmux_session"
      return
    fi
    # tmux session gone — mark old run as stopped
    write_run_json "$RUNS_DIR/$active_run/run.json" status stopped updated_at "$(now_iso)"
    update_workspace_index "$workdir" "$active_run" clear
  fi

  # Create new run
  local run_id tmux_session run_dir codex_home claude_session_id
  run_id=$(uuidgen)
  tmux_session="duet-${run_id:0:8}"
  run_dir="$RUNS_DIR/$run_id"
  mkdir -p "$run_dir/runtime"

  # Durable CODEX_HOME
  codex_home="$run_dir/codex-home"
  setup_codex_home "$codex_home"

  claude_session_id=$(uuidgen)

  # Write run manifest
  write_run_json "$run_dir/run.json" \
    run_id "$run_id" \
    cwd "$workdir" \
    created_at "$(now_iso)" \
    updated_at "$(now_iso)" \
    status active \
    tmux_session "$tmux_session" \
    mode new \
    claude.session_id "$claude_session_id" \
    codex.session_id "" \
    claude.binding_path "" \
    codex.binding_path "" \
    codex_home "$codex_home"

  update_workspace_index "$workdir" "$run_id" true

  # Set binding env vars
  export CLAUDE_SESSION_ID="$claude_session_id"
  export CLAUDE_PROJECTS="$HOME/.claude/projects"
  export STATE_DIR="$run_dir"
  export WORKDIR="$workdir"
  export CODEX_HOME="$codex_home"
  export CODEX_SESSIONS="$codex_home/sessions"

  # Create tmux layout
  create_tmux_layout "$tmux_session"

  # Build composed prompt files
  local claude_prompt_file="$run_dir/runtime/claude-system-prompt.md"
  local codex_prompt_file="$run_dir/runtime/codex-model-instructions.md"
  build_tool_prompt claude "$workdir" "$claude_prompt_file"
  build_tool_prompt codex "$workdir" "$codex_prompt_file"

  # Launch tools
  local claude_prompt q_workdir q_codex_home q_codex_prompt
  claude_prompt=$(cat "$claude_prompt_file")
  q_workdir=$(quote_path "$workdir")
  q_codex_home=$(quote_path "$codex_home")
  q_codex_prompt=$(quote_path "$codex_prompt_file")
  tmux send-keys -t "$CLAUDE_PANE" \
    "cd $q_workdir && claude --dangerously-skip-permissions --session-id $claude_session_id --append-system-prompt '$(echo "$claude_prompt" | sed "s/'/'\\\\''/g")'" Enter
  tmux send-keys -t "$CODEX_PANE" \
    "cd $q_workdir && CODEX_HOME=$q_codex_home codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=$q_codex_prompt" Enter

  # Binding reconciler
  bash "$DIR/bind-sessions.sh" &

  # Router
  launch_router "$tmux_session" "$run_dir" "new"

  tmux attach -t "$tmux_session"
}

# ─── Subcommand: resume ──────────────────────────────────────────────────────

cmd_resume() {
  local run_id
  run_id=$(resolve_run_id "$1")
  if [ -z "$run_id" ]; then
    echo "Error: no run found to resume"
    exit 1
  fi

  local run_dir="$RUNS_DIR/$run_id"
  local run_json="$run_dir/run.json"
  [ -f "$run_json" ] || { echo "Error: run manifest not found: $run_json"; exit 1; }

  # Extract stored metadata
  local cwd claude_sid codex_sid codex_home old_tmux status
  local claude_binding codex_binding
  cwd=$(run_field "$run_json" cwd)
  claude_sid=$(run_field "$run_json" claude.session_id)
  codex_sid=$(run_field "$run_json" codex.session_id)
  codex_home=$(run_field "$run_json" codex_home)
  old_tmux=$(run_field "$run_json" tmux_session)
  status=$(run_field "$run_json" status)
  claude_binding=$(run_field "$run_json" claude.binding_path)
  codex_binding=$(run_field "$run_json" codex.binding_path)

  # If tmux session still alive, just attach
  if [ -n "$old_tmux" ] && tmux has-session -t "$old_tmux" 2>/dev/null; then
    echo "tmux session still alive — attaching."
    tmux attach -t "$old_tmux"
    return
  fi

  if [ "$status" != "stopped" ] && [ "$status" != "detached" ]; then
    echo "Warning: run status is '$status' (expected 'stopped' or 'detached')"
  fi

  echo "Resuming run ${run_id:0:8}..."
  echo "  cwd: $cwd"
  [ -n "$claude_sid" ] && echo "  claude: $claude_sid" || echo "  claude: (fresh)"
  [ -n "$codex_sid" ] && echo "  codex: $codex_sid" || echo "  codex: (fresh)"

  local tmux_session="${old_tmux:-duet-${run_id:0:8}}"

  # Ensure codex-home is intact
  [ -n "$codex_home" ] || codex_home="$run_dir/codex-home"
  setup_codex_home "$codex_home"

  # Build composed prompt files
  mkdir -p "$run_dir/runtime"
  local claude_prompt_file="$run_dir/runtime/claude-system-prompt.md"
  local codex_prompt_file="$run_dir/runtime/codex-model-instructions.md"
  build_tool_prompt claude "$cwd" "$claude_prompt_file"
  build_tool_prompt codex "$cwd" "$codex_prompt_file"

  # Build Claude command
  local claude_cmd q_codex_home q_cwd q_codex_prompt
  q_codex_home=$(quote_path "$codex_home")
  q_cwd=$(quote_path "$cwd")
  q_codex_prompt=$(quote_path "$codex_prompt_file")
  if [ -n "$claude_sid" ]; then
    local claude_prompt
    claude_prompt=$(cat "$claude_prompt_file")
    claude_cmd="claude --dangerously-skip-permissions --resume $claude_sid --append-system-prompt '$(echo "$claude_prompt" | sed "s/'/'\\\\''/g")'"
  else
    claude_sid=$(uuidgen)
    local claude_prompt
    claude_prompt=$(cat "$claude_prompt_file")
    claude_cmd="claude --dangerously-skip-permissions --session-id $claude_sid --append-system-prompt '$(echo "$claude_prompt" | sed "s/'/'\\\\''/g")'"
  fi

  # Build Codex command
  local codex_cmd
  if [ -n "$codex_sid" ]; then
    codex_cmd="CODEX_HOME=$q_codex_home codex resume $codex_sid --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=$q_codex_prompt"
  else
    codex_cmd="CODEX_HOME=$q_codex_home codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=$q_codex_prompt"
  fi

  # Update run manifest
  write_run_json "$run_json" \
    status active \
    updated_at "$(now_iso)" \
    tmux_session "$tmux_session" \
    mode resumed \
    claude.session_id "$claude_sid"

  update_workspace_index "$cwd" "$run_id" true

  # Set binding env vars
  export CLAUDE_SESSION_ID="$claude_sid"
  export CLAUDE_PROJECTS="$HOME/.claude/projects"
  export STATE_DIR="$run_dir"
  export WORKDIR="$cwd"
  export CODEX_HOME="$codex_home"
  export CODEX_SESSIONS="$codex_home/sessions"
  # Fast-path: only export resume paths when we have both path AND session ID
  # (prevents binding to stale log when session ID is missing)
  [ -n "$claude_binding" ] && export RESUME_CLAUDE_PATH="$claude_binding"
  if [ -n "$codex_binding" ] && [ -n "$codex_sid" ]; then
    export RESUME_CODEX_PATH="$codex_binding"
    export RESUME_CODEX_SESSION_ID="$codex_sid"
  fi

  # Create tmux layout and launch
  create_tmux_layout "$tmux_session"

  tmux send-keys -t "$CLAUDE_PANE" "cd $q_cwd && $claude_cmd" Enter
  tmux send-keys -t "$CODEX_PANE" "cd $q_cwd && $codex_cmd" Enter

  # Binding reconciler
  bash "$DIR/bind-sessions.sh" &

  # Router (mode=resumed triggers EOF-seek)
  launch_router "$tmux_session" "$run_dir" "resumed"

  tmux attach -t "$tmux_session"
}

# ─── Subcommand: fork ────────────────────────────────────────────────────────

cmd_fork() {
  local run_id
  run_id=$(resolve_run_id "$1")
  if [ -z "$run_id" ]; then
    echo "Error: no run found to fork"
    exit 1
  fi

  local source_dir="$RUNS_DIR/$run_id"
  local source_json="$source_dir/run.json"
  [ -f "$source_json" ] || { echo "Error: source run manifest not found"; exit 1; }

  local cwd claude_sid codex_sid
  cwd=$(run_field "$source_json" cwd)
  claude_sid=$(run_field "$source_json" claude.session_id)
  codex_sid=$(run_field "$source_json" codex.session_id)

  echo "Forking run ${run_id:0:8}..."

  # Create new run
  local new_run_id new_run_dir tmux_session codex_home new_claude_sid
  new_run_id=$(uuidgen)
  new_run_dir="$RUNS_DIR/$new_run_id"
  tmux_session="duet-${new_run_id:0:8}"
  mkdir -p "$new_run_dir/runtime"

  codex_home="$new_run_dir/codex-home"
  setup_codex_home "$codex_home"
  new_claude_sid=$(uuidgen)

  # Build composed prompt files
  local claude_prompt_file="$new_run_dir/runtime/claude-system-prompt.md"
  local codex_prompt_file="$new_run_dir/runtime/codex-model-instructions.md"
  build_tool_prompt claude "$cwd" "$claude_prompt_file"
  build_tool_prompt codex "$cwd" "$codex_prompt_file"

  # Build fork commands
  local claude_cmd codex_cmd claude_prompt q_codex_home q_cwd q_codex_prompt
  claude_prompt=$(cat "$claude_prompt_file")
  q_codex_home=$(quote_path "$codex_home")
  q_cwd=$(quote_path "$cwd")
  q_codex_prompt=$(quote_path "$codex_prompt_file")

  if [ -n "$claude_sid" ]; then
    claude_cmd="claude --dangerously-skip-permissions --resume $claude_sid --fork-session --session-id $new_claude_sid --append-system-prompt '$(echo "$claude_prompt" | sed "s/'/'\\\\''/g")'"
  else
    claude_cmd="claude --dangerously-skip-permissions --session-id $new_claude_sid --append-system-prompt '$(echo "$claude_prompt" | sed "s/'/'\\\\''/g")'"
  fi

  if [ -n "$codex_sid" ]; then
    codex_cmd="CODEX_HOME=$q_codex_home codex fork $codex_sid --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=$q_codex_prompt"
  else
    codex_cmd="CODEX_HOME=$q_codex_home codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=$q_codex_prompt"
  fi

  # Write run manifest
  write_run_json "$new_run_dir/run.json" \
    run_id "$new_run_id" \
    cwd "$cwd" \
    created_at "$(now_iso)" \
    updated_at "$(now_iso)" \
    status active \
    tmux_session "$tmux_session" \
    mode forked \
    claude.session_id "$new_claude_sid" \
    codex.session_id "" \
    claude.binding_path "" \
    codex.binding_path "" \
    codex_home "$codex_home" \
    forked_from "$run_id"

  update_workspace_index "$cwd" "$new_run_id" true

  # Set binding env vars
  export CLAUDE_SESSION_ID="$new_claude_sid"
  export CLAUDE_PROJECTS="$HOME/.claude/projects"
  export STATE_DIR="$new_run_dir"
  export WORKDIR="$cwd"
  export CODEX_HOME="$codex_home"
  export CODEX_SESSIONS="$codex_home/sessions"

  # Create tmux layout and launch
  create_tmux_layout "$tmux_session"

  tmux send-keys -t "$CLAUDE_PANE" "cd $q_cwd && $claude_cmd" Enter
  tmux send-keys -t "$CODEX_PANE" "cd $q_cwd && $codex_cmd" Enter

  bash "$DIR/bind-sessions.sh" &
  launch_router "$tmux_session" "$new_run_dir" "forked"

  tmux attach -t "$tmux_session"
}

# ─── Subcommand: list ─────────────────────────────────────────────────────────

cmd_list() {
  python3 - "$RUNS_DIR" "${0##*/}" <<'PYLIST'
import json, sys, os, pathlib

runs_dir = pathlib.Path(sys.argv[1])
prog = sys.argv[2]
MAX_TITLE = 72

def get_codex_title(codex_home, codex_sid):
    """Extract conversation title from Codex SQLite, with fallbacks."""
    if not codex_home or not codex_sid:
        return None
    db_path = os.path.join(codex_home, 'state_5.sqlite')
    if not os.path.isfile(db_path):
        return None
    try:
        import sqlite3
        db = sqlite3.connect(db_path)
        cur = db.cursor()
        cur.execute('SELECT title, first_user_message FROM threads WHERE id = ?', (codex_sid,))
        row = cur.fetchone()
        db.close()
        if row:
            title = row[0] or row[1] or None
            if title and len(title) > MAX_TITLE:
                title = title[:MAX_TITLE - 1] + '\u2026'
            return title
    except Exception:
        pass
    return None

runs = []
for rj in runs_dir.glob('*/run.json'):
    try:
        data = json.load(open(rj))
    except Exception:
        continue
    rid = data.get('run_id') or rj.parent.name
    claude = data.get('claude') or {}
    codex = data.get('codex') or {}
    c_sid = claude.get('session_id', '')
    x_sid = codex.get('session_id', '')
    status = data.get('status', '?')
    title = get_codex_title(data.get('codex_home'), x_sid)
    runs.append({
        'rid': rid,
        'short': rid[:8],
        'status': status,
        'mode': data.get('mode', '?'),
        'cwd': data.get('cwd', '?'),
        'updated': data.get('updated_at', '?'),
        'claude': c_sid[:8] + '\u2026' if c_sid else 'missing',
        'codex': x_sid[:8] + '\u2026' if x_sid else 'missing',
        'tmux': data.get('tmux_session', ''),
        'title': title,
        'resumable': status in ('stopped', 'detached'),
    })

# Active runs first, then most-recently-updated first within each group
active = sorted([r for r in runs if r['status'] == 'active'], key=lambda r: r['updated'], reverse=True)
rest = sorted([r for r in runs if r['status'] != 'active'], key=lambda r: r['updated'], reverse=True)
runs = active + rest

print('DUET RUNS')
print('=========')

if not runs:
    print('  (no runs found)')
    raise SystemExit(0)

for run in runs:
    print(f"\n{run['short']}  {run['status']}  {run['mode']}")
    if run['title']:
        print(f"  title:   {run['title']}")
    print(f"  cwd:     {run['cwd']}")
    print(f"  updated: {run['updated']}")
    print(f"  claude:  {run['claude']}   codex: {run['codex']}")
    if run['tmux']:
        print(f"  tmux:    {run['tmux']}")
    if run['resumable']:
        print(f"  resume:  {prog} resume {run['short']}")

print()
PYLIST
}

# ─── Subcommand: destroy ──────────────────────────────────────────────────────

cmd_destroy() {
  local run_id
  run_id=$(resolve_run_id "$1")
  if [ -z "$run_id" ]; then
    echo "Error: no run found to destroy"
    exit 1
  fi

  local run_dir="$RUNS_DIR/$run_id"
  local run_json="$run_dir/run.json"

  if [ -f "$run_json" ]; then
    local tmux_session cwd
    tmux_session=$(run_field "$run_json" tmux_session)
    cwd=$(run_field "$run_json" cwd)

    # Kill tmux session if alive
    if [ -n "$tmux_session" ]; then
      tmux kill-session -t "$tmux_session" 2>/dev/null || true
    fi

    # Clear workspace index
    if [ -n "$cwd" ]; then
      update_workspace_index "$cwd" "$run_id" clear
    fi
  fi

  rm -rf "$run_dir"
  echo "Destroyed run ${run_id:0:8}"
}

# ─── Main dispatch ────────────────────────────────────────────────────────────

mkdir -p "$RUNS_DIR" "$WORKSPACES_DIR"

case "${1:-}" in
  resume)
    cmd_resume "${2:-last}"
    ;;
  fork)
    cmd_fork "${2:-last}"
    ;;
  list)
    cmd_list
    ;;
  destroy)
    [ -z "${2:-}" ] && { echo "Usage: duet destroy <run-id>"; exit 1; }
    cmd_destroy "$2"
    ;;
  *)
    cmd_new "${1:-$(pwd)}"
    ;;
esac

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
run_ops() { node "$DIR/src/cli/run-ops.mjs" "$@"; }

# Preflight checks
for cmd in tmux claude codex node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is not installed or not in PATH"
    exit 1
  fi
done

# tmux socket isolation — when DUET_TMUX_SOCKET is set, all tmux commands
# use a dedicated socket (-S) instead of the default server
if [ -n "${DUET_TMUX_SOCKET:-}" ]; then
  tmux() { command tmux -S "$DUET_TMUX_SOCKET" "$@"; }
fi

# ─── Utility functions ──────────────────────────────────────────────────────

# Shell-quote a path for interpolation into tmux send-keys strings
quote_path() {
  printf '%q' "$1"
}

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Read fields from run.json via JS helper (outputs JSON object).
# Usage: result=$(read_fields <path> <key1> [<key2> ...])
# Parse with: val=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$key',''))")
# Or use run_field for single fields.
run_field() {
  local run_json="$1" key="$2"
  run_ops read-fields "$run_json" "$key" | python3 -c "import json,sys; print(json.load(sys.stdin).get(sys.argv[1],''))" "$key" 2>/dev/null
}

# Read multiple fields at once (avoids repeated Node spawns).
# Sets variables named by the keys. Usage:
#   read_run_fields <path> cwd status claude.session_id
#   # now $cwd, $status, $claude_session_id are set
read_run_fields() {
  local run_json="$1"; shift
  local fields=("$@")
  local json
  json=$(run_ops read-fields "$run_json" "${fields[@]}")
  for key in "${fields[@]}"; do
    local varname="${key//./_}"
    local val
    val=$(echo "$json" | python3 -c "import json,sys; print(json.load(sys.stdin).get(sys.argv[1],''))" "$key" 2>/dev/null)
    eval "$varname=\"\$val\""
  done
}

write_run_json() {
  local path="$1"; shift
  run_ops write-run-json "$path" "$@"
}

find_active_run() {
  local cwd="$1"
  local result
  result=$(run_ops find-active "$cwd")
  local run_id
  run_id=$(echo "$result" | python3 -c "import json,sys; r=json.load(sys.stdin).get('runId',''); print(r)" 2>/dev/null)
  [ -n "$run_id" ] && echo "$run_id" || return 1
}

update_workspace_index() {
  local cwd="$1" run_id="$2" active="$3"
  run_ops update-workspace "$cwd" "$run_id" "$active"
}

resolve_run_id() {
  local ref="$1"
  local result
  result=$(run_ops resolve-run "$ref")
  local run_id error
  run_id=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('runId',''))" 2>/dev/null)
  error=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error','') or '')" 2>/dev/null)
  if [ -n "$error" ]; then
    echo "Error: $error" >&2
    return 1
  fi
  echo "$run_id"
}

# Set up a CODEX_HOME overlay with read-only config symlinks
source "$DIR/lib/codex-home.sh"

# Build a composed prompt file for a tool
build_tool_prompt() {
  local tool="$1" workdir="$2" output="$3"
  run_ops build-prompt "$tool" "$workdir" "$output" "$DIR/DUET.md"
}

# Create the 3-pane tmux layout (sets CLAUDE_PANE, CODEX_PANE, ROUTER_PANE)
create_tmux_layout() {
  local session="$1"
  local cols lines router_height codex_width

  tmux kill-session -t "$session" 2>/dev/null || true

  cols="${COLUMNS:-$(tput cols 2>/dev/null || echo 120)}"
  lines="${LINES:-$(tput lines 2>/dev/null || echo 40)}"
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
      [ "${DUET_NO_ATTACH:-}" = "1" ] || tmux attach -t "$tmux_session"
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

  [ "${DUET_NO_ATTACH:-}" = "1" ] || tmux attach -t "$tmux_session"
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

  # Read all needed fields in one Node call
  local cwd claude_session_id codex_session_id codex_home tmux_session status claude_binding_path codex_binding_path
  read_run_fields "$run_json" cwd claude.session_id codex.session_id codex_home tmux_session status claude.binding_path codex.binding_path

  # If tmux session still alive, just attach
  if [ -n "$tmux_session" ] && tmux has-session -t "$tmux_session" 2>/dev/null; then
    echo "tmux session still alive — attaching."
    [ "${DUET_NO_ATTACH:-}" = "1" ] || tmux attach -t "$tmux_session"
    return
  fi

  if [ "$status" != "stopped" ] && [ "$status" != "detached" ]; then
    echo "Warning: run status is '$status' (expected 'stopped' or 'detached')"
  fi

  echo "Resuming run ${run_id:0:8}..."
  echo "  cwd: $cwd"
  [ -n "$claude_session_id" ] && echo "  claude: $claude_session_id" || echo "  claude: (fresh)"
  [ -n "$codex_session_id" ] && echo "  codex: $codex_session_id" || echo "  codex: (fresh)"

  tmux_session="${tmux_session:-duet-${run_id:0:8}}"

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
  local claude_cmd q_codex_home q_cwd q_codex_prompt claude_sid
  claude_sid="$claude_session_id"
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
  local codex_cmd codex_sid
  codex_sid="$codex_session_id"
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
  [ -n "$claude_binding_path" ] && export RESUME_CLAUDE_PATH="$claude_binding_path"
  if [ -n "$codex_binding_path" ] && [ -n "$codex_sid" ]; then
    export RESUME_CODEX_PATH="$codex_binding_path"
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

  [ "${DUET_NO_ATTACH:-}" = "1" ] || tmux attach -t "$tmux_session"
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

  local cwd claude_session_id codex_session_id
  read_run_fields "$source_json" cwd claude.session_id codex.session_id

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

  if [ -n "$claude_session_id" ]; then
    claude_cmd="claude --dangerously-skip-permissions --resume $claude_session_id --fork-session --session-id $new_claude_sid --append-system-prompt '$(echo "$claude_prompt" | sed "s/'/'\\\\''/g")'"
  else
    claude_cmd="claude --dangerously-skip-permissions --session-id $new_claude_sid --append-system-prompt '$(echo "$claude_prompt" | sed "s/'/'\\\\''/g")'"
  fi

  if [ -n "$codex_session_id" ]; then
    codex_cmd="CODEX_HOME=$q_codex_home codex fork $codex_session_id --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=$q_codex_prompt"
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

  [ "${DUET_NO_ATTACH:-}" = "1" ] || tmux attach -t "$tmux_session"
}

# ─── Subcommand: list ─────────────────────────────────────────────────────────

cmd_list() {
  run_ops list-runs "${0##*/}"
}

# ─── Subcommand: destroy ──────────────────────────────────────────────────────

cmd_destroy() {
  local run_id
  run_id=$(resolve_run_id "$1")
  if [ -z "$run_id" ]; then
    echo "Error: no run found to destroy"
    exit 1
  fi
  run_ops destroy-run "$run_id"
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

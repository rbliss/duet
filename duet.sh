#!/usr/bin/env bash
# duet - Unified Claude Code + Codex console
set -e

SESSION="duet"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Preflight checks
for cmd in tmux claude codex node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is not installed or not in PATH"
    exit 1
  fi
done

# Kill existing session if any
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Compute layout sizes (use -l lines/cols to avoid tmux 3.4 detach bug with -p)
COLS="$(tput cols)"
LINES="$(tput lines)"
ROUTER_HEIGHT=$(( LINES * 30 / 100 ))
CODEX_WIDTH=$(( (COLS - 1) / 2 ))  # -1 for border

# Create session - first pane becomes claude
CLAUDE_PANE=$(tmux new-session -d -s "$SESSION" \
  -x "$COLS" -y "$LINES" \
  -P -F '#{pane_id}')

# Split bottom for router (30% height)
ROUTER_PANE=$(tmux split-window -v -t "$CLAUDE_PANE" -l "$ROUTER_HEIGHT" \
  -P -F '#{pane_id}')

# Split top pane horizontally for codex (50% width)
CODEX_PANE=$(tmux split-window -h -t "$CLAUDE_PANE" -l "$CODEX_WIDTH" \
  -P -F '#{pane_id}')

# --- Styling ---
tmux set -t "$SESSION" mouse on
tmux set -t "$SESSION" status on
tmux set -t "$SESSION" status-style "bg=#1a1a2e,fg=#cccccc"
tmux set -t "$SESSION" status-left " #[fg=#00d4ff,bold]DUET#[default] | "
tmux set -t "$SESSION" status-right \
  " #[fg=#ff79c6]Claude#[default] + #[fg=#50fa7b]Codex#[default] "
tmux set -t "$SESSION" status-left-length 20
tmux set -t "$SESSION" status-right-length 40
tmux set -t "$SESSION" pane-border-style "fg=#444444"
tmux set -t "$SESSION" pane-active-border-style "fg=#00bfff,bold"

# Pane titles
tmux select-pane -t "$CLAUDE_PANE" -T "Claude Code"
tmux select-pane -t "$CODEX_PANE" -T "Codex"
tmux select-pane -t "$ROUTER_PANE" -T "Duet Router"
tmux set -t "$SESSION" pane-border-format " #{pane_title} "
tmux set -t "$SESSION" pane-border-status top

# --- Duet awareness instructions ---
DUET_INSTRUCTIONS="$DIR/DUET.md"
WORKDIR="${1:-$(pwd)}"

# --- Per-run state directory for session binding ---
STATE_DIR="/tmp/duet-state-$$"
mkdir -p "$STATE_DIR"
cleanup_state() { rm -rf "$STATE_DIR"; }
trap cleanup_state EXIT

# Snapshot session dirs before launching tools
CLAUDE_PROJECTS="$HOME/.claude/projects"
CODEX_SESSIONS="$HOME/.codex/sessions"
find "$CLAUDE_PROJECTS" -name '*.jsonl' -type f 2>/dev/null | sort > "$STATE_DIR/claude-before.list"
find "$CODEX_SESSIONS" -name '*.jsonl' -type f 2>/dev/null | sort > "$STATE_DIR/codex-before.list"

# --- Launch tools ---
DUET_PROMPT=$(cat "$DUET_INSTRUCTIONS")
tmux send-keys -t "$CLAUDE_PANE" "cd $WORKDIR && claude --dangerously-skip-permissions --append-system-prompt '$(echo "$DUET_PROMPT" | sed "s/'/'\\\\''/g")'" Enter
tmux send-keys -t "$CODEX_PANE" "cd $WORKDIR && codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file='$DUET_INSTRUCTIONS'" Enter

# Wait for CLIs to create their session files
sleep 3

# Diff to find new session files created by this launch
find "$CLAUDE_PROJECTS" -name '*.jsonl' -type f 2>/dev/null | sort > "$STATE_DIR/claude-after.list"
find "$CODEX_SESSIONS" -name '*.jsonl' -type f 2>/dev/null | sort > "$STATE_DIR/codex-after.list"

CLAUDE_SESSION_FILE=$(comm -13 "$STATE_DIR/claude-before.list" "$STATE_DIR/claude-after.list" | tail -1)
CODEX_SESSION_FILE=$(comm -13 "$STATE_DIR/codex-before.list" "$STATE_DIR/codex-after.list" | tail -1)

[ -n "$CLAUDE_SESSION_FILE" ] && echo "$CLAUDE_SESSION_FILE" > "$STATE_DIR/claude-session.path"
[ -n "$CODEX_SESSION_FILE" ] && echo "$CODEX_SESSION_FILE" > "$STATE_DIR/codex-session.path"

# Launch router
tmux send-keys -t "$ROUTER_PANE" \
  "DUET_SESSION=$SESSION CLAUDE_PANE=$CLAUDE_PANE CODEX_PANE=$CODEX_PANE DUET_STATE_DIR=$STATE_DIR node $DIR/router.mjs" \
  Enter

# Focus the router pane
tmux select-pane -t "$ROUTER_PANE"

# Attach
tmux attach -t "$SESSION"

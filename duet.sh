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

# Kill existing session and clean up its state
tmux kill-session -t "$SESSION" 2>/dev/null || true
rm -rf "/tmp/duet-state-$SESSION"

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
# Keyed by session name (not PID) so it outlives the bootstrap shell.
# Cleaned up when a new duet session starts or when /quit runs.
STATE_DIR="/tmp/duet-state-$SESSION"
mkdir -p "$STATE_DIR"

# --- Session binding ---
# Claude: --session-id gives us a known UUID; we find the file by name after launch.
#   Guarantee: process-level (UUID is unique to this exact launch).
# Codex: two-tier binding strategy:
#   1. Primary: CODEX_HOME overlay isolates session storage (process-level ownership).
#   2. Fallback: if overlay produces no session files (CODEX_HOME ignored/broken),
#      bind-sessions.sh falls back to scanning ~/.codex/sessions/ with cwd matching
#      (workspace-level ownership). The binding level in the manifest reflects which
#      path was actually taken.
#   Only read-only config/auth are shared; mutable state stores are NOT symlinked.
#   Note: CODEX_HOME is recognized by Codex but may not be officially supported.
CLAUDE_SESSION_ID=$(uuidgen)
export CLAUDE_SESSION_ID
export CLAUDE_PROJECTS="$HOME/.claude/projects"
export STATE_DIR
export WORKDIR

# --- Codex session-store isolation ---
# Create a run-scoped CODEX_HOME that reuses the logged-in account (auth.json, config.toml)
# but isolates mutable session storage. We do NOT symlink mutable SQLite state stores
# (state_5.sqlite etc.) — that would blur isolation and risk locking/corruption.
CODEX_OVERLAY="$STATE_DIR/codex-home"
mkdir -p "$CODEX_OVERLAY/sessions"
# Only share read-only config files — never mutable state stores
for f in auth.json config.toml version.json; do
  [ -f "$HOME/.codex/$f" ] && ln -sf "$HOME/.codex/$f" "$CODEX_OVERLAY/$f"
done
# Symlink read-only dirs that Codex may need
for d in rules skills; do
  [ -d "$HOME/.codex/$d" ] && ln -sf "$HOME/.codex/$d" "$CODEX_OVERLAY/$d"
done
export CODEX_HOME="$CODEX_OVERLAY"
export CODEX_SESSIONS="$CODEX_OVERLAY/sessions"

# --- Launch tools ---
DUET_PROMPT=$(cat "$DUET_INSTRUCTIONS")
tmux send-keys -t "$CLAUDE_PANE" "cd $WORKDIR && claude --dangerously-skip-permissions --session-id $CLAUDE_SESSION_ID --append-system-prompt '$(echo "$DUET_PROMPT" | sed "s/'/'\\\\''/g")'" Enter
tmux send-keys -t "$CODEX_PANE" "cd $WORKDIR && CODEX_HOME=$CODEX_OVERLAY codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file='$DUET_INSTRUCTIONS'" Enter

# Run extracted binding logic (polls for session files, writes bindings.json)
source "$DIR/bind-sessions.sh"

# Launch router
tmux send-keys -t "$ROUTER_PANE" \
  "DUET_SESSION=$SESSION CLAUDE_PANE=$CLAUDE_PANE CODEX_PANE=$CODEX_PANE DUET_STATE_DIR=$STATE_DIR node $DIR/router.mjs" \
  Enter

# Focus the router pane
tmux select-pane -t "$ROUTER_PANE"

# Attach
tmux attach -t "$SESSION"

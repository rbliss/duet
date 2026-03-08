#!/usr/bin/env bash
# Sourceable helper: CODEX_HOME overlay setup
# Used by duet.sh and tested directly by integration tests.

# Set up a CODEX_HOME overlay with read-only config symlinks
setup_codex_home() {
  local codex_home="$1"
  mkdir -p "$codex_home/sessions"
  # Only share read-only config files — never mutable state stores
  for f in auth.json config.toml version.json; do
    [ -f "$HOME/.codex/$f" ] && ln -sf "$HOME/.codex/$f" "$codex_home/$f" || true
  done
  for d in rules skills; do
    [ -d "$HOME/.codex/$d" ] && ln -sf "$HOME/.codex/$d" "$codex_home/$d" || true
  done
}

#!/usr/bin/env bash
# duet - Unified Claude Code + Codex console
# Thin compatibility shim — all logic lives in src/cli/duet.mjs
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/src/cli/duet.mjs" "$@"

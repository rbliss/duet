# Duet

Duet is a tmux-based console that runs Claude Code and Codex side by side, with a router process that enables cross-agent communication via @mentions, manual relays, and autonomous multi-round conversations.

## Project structure

```
duet.sh             Launcher — tmux session, pane layout, tool launches, binding setup
router.mjs          Router — command parsing, relay dispatch, watch/converse modes, session reading
bind-sessions.sh    Background binding reconciler — discovers session files, writes manifest
test.mjs            Test suite (135 tests, 20 suites) — run with: node --test test.mjs
DUET.md             System prompt injected into both tools at launch
README.md           User-facing documentation
docs/
  FINDINGS.md                   Architectural findings from code review (5 items, 2 resolved)
  LIVE_BINDING_DEGRADATION.md   Post-mortem on binding timing issue (resolved)
  RESUME_PLAN.md                Design doc for durable run state and session resume (not yet implemented)
  1_*.md                        Iterative review/feedback passes from development
```

## Architecture

### Launcher (duet.sh)

Creates a tmux session with three panes: Claude Code (top-left), Codex (top-right), router (bottom). Key responsibilities:

- Generates a UUID for Claude's `--session-id`
- Creates a run-scoped `CODEX_HOME` overlay that isolates mutable session state while sharing read-only auth/config via symlinks
- Launches `bind-sessions.sh` as a background process
- Passes `DUET_STATE_DIR`, pane IDs, and session name to the router

### Binding reconciler (bind-sessions.sh)

Runs as a background process after launch. Sole authority for session discovery — the router never probes for files directly.

- Writes an initial `bindings.json` manifest with both tools as `pending`
- Polls for up to 120 seconds (240 iterations at 0.5s) looking for session files
- Claude binding: finds `$CLAUDE_SESSION_ID.jsonl` under `~/.claude/projects/`
- Codex binding (primary): finds any `.jsonl` in the isolated `$CODEX_SESSIONS` dir
- Codex binding (fallback): if isolation produces nothing, scans `~/.codex/sessions/` for new files matching `$WORKDIR` via `session_meta.cwd`
- Updates the manifest incrementally as each tool binds
- Marks unfound tools as `degraded` when the deadline expires

Lifecycle states: `pending` → `bound` | `degraded`

### Router (router.mjs)

Node.js process providing the interactive command interface. Pure manifest consumer for binding state.

**Key subsystems:**

- **Command parsing** (`parseInput`): handles `@claude`, `@codex`, `@both`, `@relay`, `/converse`, `/watch`, `/stop`, `/status`, `/focus`, `/snap`, `/clear`, `/help`, `/quit`
- **Relay transport**: two paths depending on binding:
  - Session-bound: `fs.watch()` on JSONL log files, debounced (200ms with completion signal, 800ms without)
  - Pane-only: `capture-pane` polling every 1s, 2 unchanged ticks for stability
- **Binding resolution** (`resolveSessionPath`): reads `bindings.json`, caches when all tools are final, re-reads while any tool is `pending`
- **Dynamic upgrade**: tools starting as `pending` are polled via pane, then auto-upgraded to file watching when the manifest transitions to `bound`
- **Content extraction** (`readIncremental`): incremental JSONL reader tracking byte offset per tool
- **Completion detection** (`isResponseComplete`): recognizes Claude's `stop_reason: 'end_turn'` / `type: 'result'` and Codex's `payload.type: 'task_complete'`
- **Content diffing** (`getNewContent`): prefix/suffix structural matching for pane output, handles TUI chrome (content inserted above preserved footer)
- **Mention detection** (`detectMentions`): finds `@claude` / `@codex` in tool output for watch mode
- **Converse mode**: multi-round turn-based relay with configurable round count, no cooldown needed (turn tracking prevents loops)
- **Watch mode**: monitors for @mentions with 8s cooldown between auto-relays

**Exported functions** (used by tests): `shellEscape`, `parseInput`, `sendKeys`, `capturePane`, `pasteToPane`, `focusPane`, `getNewContent`, `detectMentions`, `resolveSessionPath`, `resetSessionState`, `setStateDir`, `readIncremental`, `isResponseComplete`

## Key design decisions

1. **Single binding authority**: `bind-sessions.sh` owns all session discovery. The router only consumes the manifest. This avoids split-authority bugs where two components race to find session files.

2. **Event-driven relay for bound tools**: `fs.watch()` on session logs gives sub-second relay latency vs the ~6s that polling required. Pane polling is the fallback, not the default.

3. **Prefix/suffix diffing**: Claude Code's TUI inserts new content above a preserved footer. Simple tail-matching misses this. The `getNewContent` algorithm matches common prefix and suffix lines, extracting the inserted middle.

4. **CODEX_HOME isolation**: Each run gets its own Codex home directory with only read-only config symlinked from `~/.codex/`. Mutable state (sessions, SQLite DBs) is never shared. This gives process-level binding certainty.

5. **Graceful degradation**: If session binding fails, the router falls back to pane capture. The system always works — binding just determines relay quality (authoritative JSONL vs screen scraping).

## Testing

```bash
node --test test.mjs
```

Tests use Node's built-in test runner. Integration tests create real tmux sessions. The binding contract tests run `bind-sessions.sh` with `BIND_TIMEOUT=2` (1 second) to test the full lifecycle quickly.

Key test patterns:
- `resetSessionState()` clears router state between tests
- `setStateDir(dir)` points binding resolution at a temp directory
- Binding tests create mock session files and manifests in temp dirs
- tmux tests use a dedicated `duet-test` session that's cleaned up in `after()`

## Open work

### Unresolved findings (from docs/FINDINGS.md)

3. **Codex launch-time instructions are thin** — DUET.md is a flat prompt, not structured skills. Could be modeled as a Codex profile + skill bundle.
4. **Router blocks on sync tmux calls** — `execSync` for send-keys/capture-pane freezes the event loop. Should be async with delivery queues.
5. **Launch command construction is brittle** — shell string building for complex launch commands. Should separate policy from shell mechanics.

### Resume (from docs/RESUME_PLAN.md)

Full design exists for durable run state, `duet resume`, `duet fork`, and `duet list`. Key changes needed:
- Move state from `/tmp` to `~/.local/state/duet/`
- Persist run manifests with exact session IDs
- Make `CODEX_HOME` durable across restarts
- Add `/detach` vs `/quit` vs `/destroy` semantics
- Initialize incremental reader at EOF on resume (not byte 0)

### Uncommitted changes

Three findings were implemented but not yet committed:
1. Event-driven relay (`fs.watch` on session logs)
2. `getNewContent` prefix/suffix fix for TUI footer pattern
3. Live binding degradation fix (background reconciler with 120s deadline)

## Common workflows

**Run tests**: `node --test test.mjs`

**Launch duet**: `~/duet/duet.sh [workdir]`

**Debug binding**: Check `/tmp/duet-state-duet/bindings.json` for current binding state

**Debug relay**: The router logs transport mode per tool at startup and on dynamic upgrades. Look for lines like `claude: session relay via /path/to/file.jsonl` or `codex: binding timed out — using pane relay`

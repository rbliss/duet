# Duet

Duet is a tmux-based console that runs Claude Code and Codex side by side, with a router process that enables cross-agent communication via @mentions, manual relays, and autonomous multi-round conversations.

## Project structure

```
duet.sh             Launcher — subcommand dispatch, run registry, tmux layout, tool launches
router.mjs          Router — command parsing, relay dispatch, watch/converse modes
bind-sessions.sh    Background binding reconciler — discovers session files, writes manifest
src/
  transport/tmux-client.mjs     Async tmux transport with per-pane write queues
  relay/session-reader.mjs      Incremental JSONL session reader, response extraction
  runtime/bindings-store.mjs    Binding manifest loader (STATE_DIR, loadBindings)
  runtime/run-store.mjs         Run manifest updates (updateRunJson, setRunDir)
test.mjs            Test suite (213 tests, 43 suites) — run with: node --test test.mjs
DUET.md             System prompt injected into both tools at launch
README.md           User-facing documentation
docs/
  FINDINGS.md                   Architectural findings from code review (5 items, 2 resolved)
  LIVE_BINDING_DEGRADATION.md   Post-mortem on binding timing issue (resolved)
  RESUME_PLAN.md                Design doc for durable run state and session resume (completed)
  SHORT_TERM_TRANSPORT_PLAN.md  Transport reliability plan (Phases 1-5 completed)
  1_*.md                        Iterative review/feedback passes from development
```

## Architecture

### Launcher (duet.sh)

Entry point with subcommand dispatch. Creates a tmux session with three panes: Claude Code (top-left), Codex (top-right), router (bottom).

**Subcommands:**
- `duet [workdir]` — attach to active run for workspace, or create new
- `duet resume [run-id|last]` — resume a stopped run with native CLI resume
- `duet fork [run-id|last]` — fork from an existing run
- `duet list` — show all runs with status
- `duet destroy <run-id>` — permanently remove a run and its state

**Key responsibilities:**
- Manages persistent run registry under `~/.local/state/duet/`
- Generates UUIDs for Claude sessions, discovers Codex session IDs via binding
- Creates durable per-run `CODEX_HOME` (not under `/tmp`)
- Maintains workspace index for attach-vs-new logic
- Writes `run.json` manifest with session IDs, binding paths, status
- Passes `DUET_MODE` (new/resumed/forked) and `DUET_RUN_DIR` to the router

**State layout:**
```
~/.local/state/duet/
  runs/<run-id>/
    run.json          Run manifest (IDs, status, paths, metadata)
    bindings.json     Session binding manifest
    codex-home/       Durable CODEX_HOME overlay
    runtime/          Temporary runtime files
  workspaces/
    <cwd-hash>.json   Workspace index (active run, run history)
```

### Binding reconciler (bind-sessions.sh)

Runs as a background process after launch. Sole authority for session discovery — the router never probes for files directly.

- Writes an initial `bindings.json` manifest with both tools as `pending`
- **Resume fast-path**: if `RESUME_CLAUDE_PATH` / `RESUME_CODEX_PATH` env vars point to existing files, immediately marks them as `bound` (skips polling)
- Polls for up to 120 seconds (240 iterations at 0.5s) looking for session files
- Claude binding: finds `$CLAUDE_SESSION_ID.jsonl` under `~/.claude/projects/`
- Codex binding (primary): finds any `.jsonl` in the isolated `$CODEX_SESSIONS` dir
- Codex binding (fallback): if isolation produces nothing, scans `~/.codex/sessions/` for new files matching `$WORKDIR` via `session_meta.cwd`
- Extracts Codex session ID from `payload.id` in session metadata
- Updates the manifest incrementally as each tool binds
- Marks unfound tools as `degraded` when the deadline expires

Lifecycle states: `pending` → `bound` | `degraded`

### Router (router.mjs)

Node.js process providing the interactive command interface. Pure manifest consumer for binding state.

**Key subsystems:**

- **Command parsing** (`parseInput`): handles `@claude`, `@codex`, `@both`, `@relay`, `/converse`, `/watch`, `/stop`, `/status`, `/focus`, `/snap`, `/clear`, `/help`, `/quit`, `/detach`, `/destroy`
- **Relay transport** (session-only): `fs.watch()` on JSONL log files, debounced (200ms with completion signal, 800ms without). No pane-scraping fallback for automation.
- **Binding resolution** (`resolveSessionPath` in `src/relay/session-reader.mjs`): reads `bindings.json`, caches when all tools are final, re-reads while any tool is `pending`. On resume mode, seeks reader offset to EOF to skip history.
- **Run manifest management** (`updateRunJson` in `src/runtime/run-store.mjs`): updates `run.json` with binding paths, session IDs, and status changes
- **Binding-refresh polling**: for tools with `pending` bindings, polls `resolveSessionPath()` periodically and starts file watching when the binding resolves. No pane polling.
- **Content extraction** (`readIncremental` in `src/relay/session-reader.mjs`): incremental JSONL reader tracking byte offset per tool
- **Completion detection** (`isResponseComplete`): recognizes Claude's `stop_reason: 'end_turn'` / `type: 'result'` and Codex's `payload.type: 'task_complete'`
- **Content diffing** (`getNewContent`): prefix/suffix structural matching — retained for backward compatibility but not used in automation paths
- **Mention detection** (`detectMentions`): finds `@claude` / `@codex` in tool output for watch mode
- **Converse mode**: multi-round turn-based relay with configurable round count, requires both tools bound, no cooldown needed (turn tracking prevents loops)
- **Watch mode**: monitors session logs for @mentions with 8s per-direction cooldown between auto-relays (claude→codex and codex→claude tracked independently). Reports per-tool state (active/waiting/unavailable)
- **Explicit binding enforcement**: `/converse` requires both tools bound; `@relay` requires source tool bound with a session response available; `/watch` reports unavailable tools

**Binding repair:**
- No automatic downgrade from session to pane relay — stale bindings are not auto-detected
- `/rebind claude|codex` re-discovers the active session file by scanning for the newest .jsonl
- `/rebind` is the manual repair path when a tool's session binding becomes stale (e.g., after in-tool `/resume`)

**Lifecycle commands:**
- `/quit` — stop tools, preserve run state for resume, mark as `stopped`
- `/detach` — detach tmux client, tools keep running
- `/destroy` — stop tools, remove all persistent state

**Exported functions** (used by tests):
- From `router.mjs` (re-exports + router-specific): `shellEscape`, `parseInput`, `sendKeys`, `capturePane`, `pasteToPane`, `focusPane`, `getNewContent`, `detectMentions`, `resolveSessionPath`, `setStateDir`, `setDuetMode`, `setRunDir`, `readIncremental`, `isResponseComplete`, `updateRunJson`, `handleNewOutput`, `lastAutoRelayTime`, `downgradeToPane` (no-op), `findRebindCandidate`, `rebindTool`, `stopFileWatchers`
- From `src/transport/tmux-client.mjs`: `shellEscape`, `sendKeys`, `capturePane`, `pasteToPane`, `focusPane`, `killSession`, `detachClient`, `displayMessage`
- From `src/relay/session-reader.mjs`: `sessionState`, `resolveSessionPath`, `readIncremental`, `extractClaudeResponse`, `extractCodexResponse`, `isResponseComplete`, `getLastResponse`, `setDuetMode`
- From `src/runtime/bindings-store.mjs`: `STATE_DIR`, `setStateDir`, `loadBindings`
- From `src/runtime/run-store.mjs`: `updateRunJson`, `setRunDir`

## Key design decisions

1. **Single binding authority**: `bind-sessions.sh` owns all session discovery. The router only consumes the manifest. This avoids split-authority bugs where two components race to find session files.

2. **Session-only automation**: `fs.watch()` on session logs gives sub-second relay latency with authoritative, structured output. Automation paths (`/converse`, `/watch`, `@relay`) require session bindings — there is no pane-scraping fallback. `capture-pane` is used only for diagnostics (`/snap`).

3. **Prefix/suffix diffing**: The `getNewContent` algorithm matches common prefix and suffix lines, extracting inserted content. Retained for backward compatibility but not used in automation paths.

4. **CODEX_HOME isolation**: Each run gets its own Codex home directory with only read-only config symlinked from `~/.codex/`. Mutable state (sessions, SQLite DBs) is never shared. This gives process-level binding certainty.

5. **Explicit binding enforcement**: If session binding fails (tool marked `degraded`), automation commands report the tool as unavailable rather than silently falling back to pane scraping. `/rebind` is the manual repair path.

6. **Durable run state**: Run metadata lives under `~/.local/state/duet/`, not `/tmp`. Each run persists exact session IDs, binding paths, and a durable `CODEX_HOME`. This enables true resume where both Claude and Codex continue their prior conversations.

7. **EOF-seek on resume**: When the router starts in `resumed` mode, it initializes session readers at the current end of file. This prevents replaying historical messages as new output.

8. **Non-destructive quit**: `/quit` stops tools and preserves state for `duet resume`. `/detach` leaves everything running. `/destroy` is the only destructive operation. This separation makes resume predictable.

## Testing

```bash
node --test test.mjs
```

Tests use Node's built-in test runner. Integration tests create real tmux sessions. The binding contract tests run `bind-sessions.sh` with `BIND_TIMEOUT=2` (1 second) to test the full lifecycle quickly.

Key test patterns:
- `resetSessionState()` clears router state between tests
- `setStateDir(dir)` points binding resolution at a temp directory
- `setDuetMode(mode)` sets the resume mode for EOF-seek testing
- `setRunDir(dir)` points run manifest updates at a temp directory
- Binding tests create mock session files and manifests in temp dirs
- tmux tests use a dedicated `duet-test` session that's cleaned up in `after()`

## Open work

### Unresolved findings (from docs/FINDINGS.md)

3. **Codex launch-time instructions are thin** — DUET.md is a flat prompt, not structured skills. Could be modeled as a Codex profile + skill bundle.
5. **Launch command construction is brittle** — shell string building for complex launch commands. Should separate policy from shell mechanics.

### Resolved findings

4. **Router blocks on sync tmux calls** — resolved: `src/transport/tmux-client.mjs` provides async transport with per-pane write queues.

## Common workflows

**Run tests**: `node --test test.mjs`

**Launch duet**: `~/duet/duet.sh [workdir]`

**Resume**: `~/duet/duet.sh resume [run-id|last]`

**Fork**: `~/duet/duet.sh fork [run-id|last]`

**List runs**: `~/duet/duet.sh list`

**Destroy run**: `~/duet/duet.sh destroy <run-id>`

**Debug binding**: Check `~/.local/state/duet/runs/<run-id>/bindings.json` for current binding state

**Debug relay**: The router logs binding state per tool at startup and on transitions. Look for lines like `claude: binding pending — automation will start when bound` or `codex: binding degraded — automation unavailable`. Use `/status` to see current binding and automation state for each tool.

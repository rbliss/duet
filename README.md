# Duet

Run Claude Code and Codex side by side in a single unified console. Direct messages to either tool with `@mentions`, relay output between them, and let them talk to each other autonomously.

```
 _______________________ _______________________
| Claude Code           | Codex                 |
|                       |                       |
|  I think @codex       |  Good point @claude,  |
|  should review the    |  I agree but we also  |
|  error handling...    |  need to consider...  |
|_______________________|_______________________|
| Duet Router                                   |
| [converse] round 2/10: claude -> codex        |
| duet>                                         |
|_______________________________________________|
```

## Requirements

- [tmux](https://github.com/tmux/tmux) 3.4+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)
- [Codex](https://github.com/openai/codex) (`codex` CLI)
- Node.js 18+

## Quick start

```bash
~/duet/duet.sh
```

This opens a tmux session with three panes: Claude Code (top-left), Codex (top-right), and the Duet router (bottom). Both CLIs launch automatically.

## Commands

### Sending messages

| Command | Description |
|---|---|
| `@claude <msg>` | Send a message to Claude Code |
| `@codex <msg>` | Send a message to Codex |
| `@both <msg>` | Send the same message to both |

### Manual relay

| Command | Description |
|---|---|
| `@relay claude>codex` | Send Claude's last response to Codex |
| `@relay codex>claude` | Send Codex's last response to Claude |
| `@relay claude>codex <prompt>` | Same, but prepend a custom prompt |

Relay reads the source tool's structured session log (JSONL) to extract the last response. The source tool must have an active session binding.

```
duet> @claude analyze the error handling in src/auth.ts
duet> @relay claude>codex do you agree with this analysis?
duet> @relay codex>claude implement the fixes codex suggested
```

### Autonomous conversation

The tools can talk to each other. There are two modes:

**Converse mode** starts a multi-round discussion on a topic. Claude goes first, its response is automatically relayed to Codex, Codex's response goes back to Claude, and so on.

| Command | Description |
|---|---|
| `/converse <topic>` | Start a 10-round discussion |
| `/converse <n> <topic>` | Start an n-round discussion |
| `/stop` | Stop the conversation early |
| `/status` | Show current converse/watch state |

```
duet> /converse How should we refactor the auth module?
duet> /converse 5 Review the test coverage and suggest improvements
duet> /status
duet> /stop
```

**Watch mode** monitors session logs for `@mentions`. When Claude includes `@codex` in its output, the router automatically relays it -- and vice versa. This lets them organically pull each other into the conversation. Watch mode requires session bindings; tools with pending bindings are reported as waiting (and auto-activate when bound), while degraded tools are reported as unavailable.

| Command | Description |
|---|---|
| `/watch` | Start monitoring for @mentions |
| `/stop` | Stop monitoring |

```
duet> /watch
duet> @claude analyze src/auth.ts — mention @codex if you want a second opinion
[auto] claude mentioned @codex — relaying
[auto] codex mentioned @claude — relaying
duet> /stop
```

Both tools are told they can `@mention` the other. An 8-second per-direction cooldown between auto-relays prevents runaway loops while allowing natural back-and-forth replies (claude→codex and codex→claude are tracked independently).

### Navigation

| Command | Description |
|---|---|
| `/focus claude` | Switch keyboard focus to the Claude pane |
| `/focus codex` | Switch keyboard focus to the Codex pane |
| `/snap claude [n]` | Print the last *n* lines from Claude's pane (default 40) |
| `/snap codex [n]` | Print the last *n* lines from Codex's pane (default 40) |
| `/rebind claude\|codex` | Re-discover session file after manual `/resume` |
| `/clear` | Clear the router screen |
| `/help` | Show command reference |
| `/quit` | Kill the session and exit |

Mouse mode is enabled -- click any pane to focus it directly, then click the router pane to return.

You can also use standard tmux navigation: `Ctrl-B` then arrow keys to move between panes, or `Ctrl-B ;` to jump back to the last pane.

### Native interaction

When you need to use a tool's native commands (like Claude's `/compact` or Codex's built-in shortcuts), either:

1. Click the tool's pane directly with the mouse
2. Use `/focus claude` or `/focus codex` from the router
3. Use `Ctrl-B` + arrow keys

Everything you type goes directly to that tool until you switch back to the router pane.

## Role prompts

You can give each tool a project-specific role by placing markdown files in your workspace root:

```
CLAUDE_ROLE.md   — appended to Claude Code's system prompt
CODEX_ROLE.md    — appended to Codex's model instructions
```

Both files are optional. When present, the contents are appended to the base `DUET.md` prompt under a labeled section. Role prompts are applied on fresh launch, resume, and fork. Attaching to an already-running tmux session does not reapply them.

If you edit a role file, the changes take effect the next time the run is launched or resumed.

## How it works

```
duet.sh          Launcher — sets up tmux session, pane layout, styling
router.mjs       Router — parses commands, dispatches via tmux, watches for @mentions
```

The router communicates with tool panes through tmux primitives:

- **send-keys** sends typed text to a pane (as if you typed it)
- **capture-pane** reads visible text from a pane (used by `/snap` only — diagnostic, not automation)
- **paste-buffer** pastes multiline text into a pane (used for relay delivery)

Automation (watch, converse, `@relay`) uses **session-only relay**: `fs.watch()` on the JSONL session log file. New content triggers a relay after a short debounce (200ms with a completion signal, 800ms otherwise). This gives sub-second latency with authoritative, structured output.

Tools with pending bindings are polled at the binding level (not pane level) — the router periodically checks whether `bindings.json` has transitioned from `pending` to `bound`, then starts file watching. The 8-second cooldown is per-direction, so a claude→codex relay does not block an immediate codex→claude reply. In converse mode, the cooldown is bypassed entirely since turn tracking already prevents loops.

Both CLIs run as full interactive processes in their own pseudo-terminals. Duet does not use the APIs -- it wraps the actual CLI tools, preserving all native features.

## Tests

```bash
cd ~/duet && node --test test.mjs
```

213 tests across 43 suites: shell escaping, input parsing (including converse/watch/stop), content diffing (`getNewContent`), @mention detection (`detectMentions`), tmux integration (sendKeys, capturePane, pasteToPane, focusPane, cross-pane relay), launcher layout, response extraction (Claude and Codex formats), completion detection (`isResponseComplete`), incremental session reader, end-to-end session binding (bindings.json manifest), binding lifecycle (manifest caching and re-reads), launcher binding contract (bind-sessions.sh with fallback coverage), session-only automation enforcement, explicit binding enforcement, watch/status messaging, and edge cases. Integration tests run against real tmux sessions.

## Known limitations

- **Session binding required for automation**: `/converse`, `/watch`, and `@relay` require active session bindings. If binding fails (tool marked as `degraded`), these commands report the tool as unavailable. Use `/status` to check binding state.
- **Single-line input**: `@claude` and `@codex` send a single line. For multi-line prompts, use `/focus` to interact natively.
- **In-tool `/resume`**: Using Claude's built-in `/resume` command inside a live Duet session invalidates the router's session binding. Use `/rebind claude` to re-discover the new session file, or prefer `duet.sh resume` / `duet.sh fork` instead.
- **tmux 3.4**: The `split-window -p` (percentage) flag fails on detached sessions. Duet uses `-l` (absolute lines/columns) as a workaround.

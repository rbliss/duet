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
| `@relay claude>codex` | Capture Claude's screen output and send it to Codex |
| `@relay codex>claude` | Capture Codex's screen output and send it to Claude |
| `@relay claude>codex <prompt>` | Same, but prepend a custom prompt |

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

**Watch mode** monitors both panes for `@mentions`. When Claude includes `@codex` in its output, the router automatically captures and relays it -- and vice versa. This lets them organically pull each other into the conversation.

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

Both tools are told they can `@mention` the other. An 8-second cooldown between auto-relays prevents runaway loops.

### Navigation

| Command | Description |
|---|---|
| `/focus claude` | Switch keyboard focus to the Claude pane |
| `/focus codex` | Switch keyboard focus to the Codex pane |
| `/snap claude [n]` | Print the last *n* lines from Claude's pane (default 40) |
| `/snap codex [n]` | Print the last *n* lines from Codex's pane (default 40) |
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

## How it works

```
duet.sh          Launcher — sets up tmux session, pane layout, styling
router.mjs       Router — parses commands, dispatches via tmux, polls for @mentions
```

The router communicates with tool panes through tmux primitives:

- **send-keys** sends typed text to a pane (as if you typed it)
- **capture-pane** reads visible text from a pane (used by `/snap`, `@relay`, watch, converse)
- **paste-buffer** pastes multiline text into a pane (used by `@relay` and auto-relay)

For watch and converse modes, the router polls each pane every 2 seconds. When a pane's output stops changing for 3 consecutive polls (~6 seconds), it's considered stable and the new output is checked for `@mentions` or relayed to the other tool.

Both CLIs run as full interactive processes in their own pseudo-terminals. Duet does not use the APIs -- it wraps the actual CLI tools, preserving all native features.

## Tests

```bash
cd ~/duet && node --test test.mjs
```

105 tests across 11 suites: shell escaping, input parsing (including converse/watch/stop), content diffing (`getNewContent`), @mention detection (`detectMentions`), tmux integration (sendKeys, capturePane, pasteToPane, focusPane, cross-pane relay), launcher layout, response extraction (Claude and Codex formats), incremental session reader, and edge cases. Integration tests run against real tmux sessions.

## Known limitations

- **Relay fidelity**: `@relay` and auto-relay capture the rendered terminal output, which includes prompts, borders, and TUI chrome. The receiving tool sees this as-is -- readable but not pristine.
- **Single-line input**: `@claude` and `@codex` send a single line. For multi-line prompts, use `/focus` to interact natively.
- **Stability detection**: The router waits ~6 seconds of unchanged output to consider a response "done." Fast follow-up outputs within that window are batched; very long pauses mid-response may trigger a premature relay.
- **tmux 3.4**: The `split-window -p` (percentage) flag fails on detached sessions. Duet uses `-l` (absolute lines/columns) as a workaround.

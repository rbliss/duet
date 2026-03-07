# Live Binding Degradation

## Finding

New `duet` runs can still degrade into pane-only relay even when the current code is launched fresh and the native session artifacts eventually exist.

In the live session reviewed here, the router reported both tools as pane fallback:

- `claude: pane-capture relay (binding failed)`
- `codex: pane-capture relay (binding failed)`

The binding manifest confirmed that Duet had finalized the run as fully unbound:

```json
{
  "claude": { "path": null, "level": null, "status": "unbound", "confirmedAt": null },
  "codex":  { "path": null, "level": null, "status": "unbound", "confirmedAt": null }
}
```

But the actual session artifacts for this same run did exist after startup:

- Codex overlay session file existed under `/tmp/duet-state-duet/codex-home/sessions/...jsonl`
- Claude session file existed under `~/.claude/projects/-home-claude-bar-browser/...jsonl`

The important timing detail is that both files appeared **after** `bindings.json` was finalized:

- `bindings.json` write time: `2026-03-07 02:02:46 UTC`
- Claude session file birth time: `2026-03-07 02:02:58 UTC`
- Codex session file birth time: `2026-03-07 02:03:04 UTC`

So this was not a stale old run. It was a fresh run that degraded because the launch-time binding window closed before either tool had materialized its authoritative session file.

## Why it matters

This is a structural problem in the current launch model, not just a cosmetic status bug.

`bind-sessions.sh` performs a one-shot polling pass at startup and writes a final manifest in [bind-sessions.sh](/home/claude/duet/bind-sessions.sh#L39) through [bind-sessions.sh](/home/claude/duet/bind-sessions.sh#L116). If a tool creates its real session artifact after that window, Duet never upgrades the run to session-bound mode.

That matters because the degraded pane path is materially weaker than the intended session path:

- it relays from visible pane content instead of authoritative session logs
- long messages can be truncated to the visible screen window
- multiline prompts can land in the other tool as partial or malformed drafts

That is exactly what happened in the live run: the router logged `claude mentioned @codex — relaying`, but Codex only received the tail end of Claude's long summary and did not start processing it as a clean new task.

## Suggested remedy

The binding system should stop treating startup binding as a one-shot decision.

Instead, make binding a long-lived reconciliation process with explicit state transitions:

- `pending`: tool launched, authoritative artifact not yet observed
- `bound`: authoritative artifact confirmed
- `degraded`: binding horizon expired or binding failed definitively

Architecturally, that means:

- write an initial manifest immediately when the run starts
- keep a binder process or reconciliation loop alive after launch
- continue probing for authoritative session artifacts while a tool is still `pending`
- let the router auto-upgrade from pane relay to session relay when the manifest changes to `bound`
- only mark a tool `degraded` when there is strong evidence that authoritative binding is unavailable, not merely because a short startup window elapsed

The key change is from:

- "try to bind during launch"

to:

- "treat binding as an eventually consistent runtime property of the run"

That matches what the live evidence shows: Claude and Codex can legitimately create their authoritative session files after the initial launch window.

## Recommended coverage

Add a launcher-contract test for delayed session-file creation:

- start with no Claude/Codex session files present
- create the session files after the initial bind window would previously have expired
- verify the manifest begins as `pending`
- verify it later transitions to `bound`
- verify the router upgrades from pane transport to session transport without restarting the run

Also add an end-to-end test for the operational consequence:

- start a run in pending mode
- deliver a long Claude message containing `@codex`
- allow session binding to appear after startup
- verify later relays use the authoritative session path instead of visible pane truncation

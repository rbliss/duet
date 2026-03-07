# Sixth Pass Review: Suggestion 1

This document covers a sixth-pass review of the implementation intended to address the original first finding: session binding and relay correctness.

## 1. Codex Binding Is Still Workspace-Scoped, Not Process-Scoped

**Severity:** Medium  
**References:** [duet.sh](/home/claude/duet/duet.sh#L68), [duet.sh](/home/claude/duet/duet.sh#L71), [duet.sh](/home/claude/duet/duet.sh#L72), [duet.sh](/home/claude/duet/duet.sh#L98), [duet.sh](/home/claude/duet/duet.sh#L101), [duet.sh](/home/claude/duet/duet.sh#L103)

The Claude side of suggestion 1 now looks structurally sound. Codex is the remaining ownership gap.

The current launcher no longer accepts any arbitrary new Codex session file. It now narrows candidates to new files whose first `session_meta` record reports a `payload.cwd` matching the Duet working directory. That is a real improvement and it closes the earlier class of false matches from unrelated Codex sessions in other directories.

But it is still not an exact ownership guarantee. The binding now proves that the discovered log belongs to a Codex session launched in the same workspace. It does not prove that the log belongs to the exact Codex process Duet launched in its pane. If two Codex sessions start in the same working directory during the same launch window, they both satisfy the current predicate. At that point selection still depends on discovery order rather than on a unique startup identity shared between the launched process and the relay layer.

So the design has improved from broad timing inference to constrained timing inference, but it has not fully reached process-level ownership on the Codex side.

### Suggested remedy

If suggestion 1 is meant to guarantee exact session ownership for both tools, Codex needs the same architectural standard Claude now has: a startup contract that identifies the exact launched instance, not just the workspace it belongs to.

If Codex cannot expose that directly, the system should make the guarantee boundary explicit in its design and documentation. In that case Duet should treat Codex binding as a weaker mode with a clearly named ownership level, rather than presenting both tools as equally authoritative.

The important design principle is to distinguish:

- exact process-owned relay
- workspace-owned relay

Right now Claude is close to the first category, while Codex is still in the second.

## 2. Relay Mode Reporting Can Get Stuck In `pane` Even After Session-Bound Relay Recovers

**Severity:** Medium  
**References:** [router.mjs](/home/claude/duet/router.mjs#L108), [router.mjs](/home/claude/duet/router.mjs#L110), [router.mjs](/home/claude/duet/router.mjs#L122), [router.mjs](/home/claude/duet/router.mjs#L326), [router.mjs](/home/claude/duet/router.mjs#L332), [router.mjs](/home/claude/duet/router.mjs#L350), [router.mjs](/home/claude/duet/router.mjs#L501)

The router now exposes relay mode, which is a clear improvement over the earlier silent fallback behavior. But the current state model still has a consistency problem.

When a tool is bound through a session path, its relay mode is set to `session`. If `getCleanResponse()` later fails to obtain a structured log response for one relay attempt, the router downgrades the mode to `pane` and falls back to capture-based relay. That part is reasonable. The issue is that the state never moves back to `session` after structured reads start working again. `resolveSessionPath()` returns early once the session is marked resolved, so it does not restore the mode. As a result, the router can continue reading authoritative session logs while still reporting `pane` in `/status`, manual relay output, and auto-relay logs.

I verified that behavior locally: once the mode is forced to `pane`, later successful structured reads do not restore it. That means the router is now surfacing relay mode, but not always surfacing it accurately.

This matters because the recent design work was specifically about making authoritative relay visible and distinguishable from fallback relay. A sticky downgrade undermines that goal. It can make the user believe session-bound relay is unavailable even when the structured path is functioning again.

### Suggested remedy

The relay-state model should describe current operating mode, not historical worst-case mode.

Architecturally, authoritative session binding and fallback transport should be represented as separate dimensions:

- whether a valid session binding exists
- whether the current relay used structured logs or pane capture

That keeps a transient fallback from permanently overwriting the session-bound state. The UI can then report both the durable binding quality and the per-relay source actually used. This would preserve the visibility goal from the fifth pass without making the status model misleading.

## 3. The New “End-To-End Session Binding” Tests Still Stop At State Files, Not Launcher Discovery

**Severity:** Medium  
**References:** [test.mjs](/home/claude/duet/test.mjs#L490), [test.mjs](/home/claude/duet/test.mjs#L507), [test.mjs](/home/claude/duet/test.mjs#L752), [test.mjs](/home/claude/duet/test.mjs#L795), [test.mjs](/home/claude/duet/test.mjs#L813), [duet.sh](/home/claude/duet/duet.sh#L85), [duet.sh](/home/claude/duet/duet.sh#L92), [duet.sh](/home/claude/duet/duet.sh#L100)

The test suite is stronger than it was a few passes ago. The router’s state-file resolution and the incremental reader are both covered more directly now, and that meaningfully improves confidence in the consumer side of the design.

But the most failure-prone part of suggestion 1 is still the launcher’s discovery and confirmation logic, and that path is not being exercised by the new tests. The `duet.sh launcher` suite still checks tmux layout and session options. The later `end-to-end session binding` suite does not actually drive `duet.sh` through its binding logic; it writes `claude-session.path` and `codex-session.path` into a temp state directory by hand, then verifies that `router.mjs` can consume them.

That means the current test coverage still skips the logic that has changed most over the review cycle:

- Claude discovery via confirmed UUID-named log lookup
- Codex discovery via new-file detection plus `session_meta.cwd` filtering
- the launcher’s polling window and state-file publication behavior

Those are the parts most likely to regress in future changes, and they are still mainly protected by manual review rather than automated coverage.

### Suggested remedy

Keep the current router-level tests, but add a launcher-contract test layer that treats `duet.sh` session binding as the unit under test.

Architecturally, that test layer should verify:

- that launcher startup publishes binding metadata only after confirmation
- that the published metadata corresponds to the actual discovered session artifacts
- that delayed or missing bindings produce the expected router state
- that Codex binding behavior is validated under realistic candidate-selection scenarios

The goal is not more parser coverage. It is confidence that the real startup contract behind suggestion 1 behaves correctly under the conditions where earlier regressions occurred.

## Verification

The local test suite passed during review:

```bash
node --test test.mjs
```

Claude binding and fallback visibility are both materially better than in earlier passes. The remaining implementation gap is Codex ownership precision, and the remaining confidence gap is that launcher-side binding discovery still is not under automated end-to-end coverage.

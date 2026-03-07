# Seventh Pass Review: Suggestion 1

This document covers a seventh-pass review of the implementation intended to address the original first finding: session binding and relay correctness.

The relevant paths reviewed in this pass are materially unchanged in the areas called out by the sixth-pass review. The same three issues remain present in the current implementation.

## 1. Codex Binding Is Still Workspace-Scoped Rather Than Process-Scoped

**Severity:** Medium  
**References:** [duet.sh](/home/claude/duet/duet.sh#L68), [duet.sh](/home/claude/duet/duet.sh#L71), [duet.sh](/home/claude/duet/duet.sh#L72), [duet.sh](/home/claude/duet/duet.sh#L98), [duet.sh](/home/claude/duet/duet.sh#L101), [duet.sh](/home/claude/duet/duet.sh#L103)

The remaining ownership gap for suggestion 1 is still on the Codex side.

The launcher continues to bind Codex by looking for newly created session files and then filtering them by `session_meta.cwd == WORKDIR`. That confirms that the chosen log belongs to a Codex session launched in the same working directory, which is better than the earlier global-history and broad timing heuristics. But it still does not identify the exact Codex process Duet launched.

That distinction matters because suggestion 1 has consistently been about authoritative session ownership. The current Codex binding logic proves workspace membership, not process identity. If two Codex sessions are launched in the same directory during the polling window, both satisfy the current predicate. The selected file is then determined by discovery order rather than by a unique handshake between the launched process and the Duet router.

The current comments in [duet.sh](/home/claude/duet/duet.sh#L71) through [duet.sh](/home/claude/duet/duet.sh#L74) explicitly describe the guarantee as workspace-level rather than process-level, which matches the actual behavior. So this is not a subtle edge case hidden behind the implementation; it remains an acknowledged gap in the design.

### Suggested remedy

If suggestion 1 is meant to be fully closed, Codex needs a true process-scoped startup identity, not just a workspace-scoped filter.

Architecturally, Duet should only treat Codex relay as fully authoritative when the launched Codex instance can be tied to a unique identity that survives into the session artifact the router consumes. If that is not possible with the current Codex CLI surface, the design should represent Codex binding as a weaker ownership tier and keep that distinction visible in the system’s guarantees, diagnostics, and documentation.

The key design principle is to avoid presenting “same workspace” and “same launched process” as equivalent levels of certainty, because they are not.

## 2. Relay Mode Reporting Still Becomes Stale After A Transient Fallback

**Severity:** Medium  
**References:** [router.mjs](/home/claude/duet/router.mjs#L108), [router.mjs](/home/claude/duet/router.mjs#L110), [router.mjs](/home/claude/duet/router.mjs#L122), [router.mjs](/home/claude/duet/router.mjs#L326), [router.mjs](/home/claude/duet/router.mjs#L332), [router.mjs](/home/claude/duet/router.mjs#L350), [router.mjs](/home/claude/duet/router.mjs#L501)

The router still exposes relay mode, but the reported state can remain wrong after a temporary fallback.

The problem is the same one identified in the sixth pass: once `getCleanResponse()` falls back from a session-log read to pane capture, it permanently flips `relayMode` from `session` to `pane`. Because `resolveSessionPath()` returns early after a session is marked resolved, later successful structured reads do not restore the mode. That leaves the router in a state where it can be reading authoritative session logs again while still reporting `pane` in `/status` output and relay logs.

I revalidated that behavior directly in this pass. With a valid session binding already in place, forcing `relayMode` to `pane` and then appending a new structured Claude response still yields a successful structured read while the mode remains `pane`. In other words, the status signal is not reflecting the current relay path; it is reflecting the fact that a fallback happened at some point in the past.

This undermines the main purpose of the relay-mode reporting work. The user can now see a relay state, but that state is not guaranteed to describe current reality. That makes it harder to reason about whether suggestion 1 is actually operating in authoritative mode at a given moment.

### Suggested remedy

The relay-state model should separate durable binding state from per-relay transport choice.

Architecturally, the router should track at least two distinct concepts:

- whether a valid authoritative session binding exists
- what source was actually used for the most recent relay

That prevents a transient fallback from permanently overwriting the fact that the tool still has a live session binding. With that separation, the UI can report both the stable binding quality and the most recent relay source without conflating them into one sticky mode flag.

## 3. Launcher-Side Binding Discovery Still Is Not Covered End To End

**Severity:** Medium  
**References:** [test.mjs](/home/claude/duet/test.mjs#L490), [test.mjs](/home/claude/duet/test.mjs#L507), [test.mjs](/home/claude/duet/test.mjs#L752), [test.mjs](/home/claude/duet/test.mjs#L795), [test.mjs](/home/claude/duet/test.mjs#L813), [duet.sh](/home/claude/duet/duet.sh#L85), [duet.sh](/home/claude/duet/duet.sh#L92), [duet.sh](/home/claude/duet/duet.sh#L100)

The current tests still do not exercise the launcher contract that now carries most of the correctness burden for suggestion 1.

The `duet.sh launcher` suite continues to validate tmux layout and session options only. The `end-to-end session binding` suite does not run the actual launcher discovery path; instead, it writes `claude-session.path` and `codex-session.path` into a temporary state directory by hand and then verifies that the router can consume those files. That is useful coverage for the router’s state-file handling, but it does not test the launcher logic that is supposed to discover and publish those bindings in the first place.

So the highest-risk binding behavior remains outside automated coverage:

- Claude confirmation by locating the UUID-named log after launch
- Codex candidate selection using new-file discovery plus `session_meta.cwd`
- publication timing of the state files used by the router

Those are exactly the parts that have shifted across the recent review passes. Since they are still not exercised end to end, regressions in suggestion 1 remain more likely to be caught manually than by the test suite.

### Suggested remedy

The existing router-level tests are useful and should stay. What is still missing is a launcher-contract test layer.

Architecturally, that layer should validate the behavior of the launcher-to-router handoff itself:

- the launcher publishes binding metadata only after confirmation
- the published metadata corresponds to the actual session artifacts discovered at startup
- late or missing bindings produce the intended router-visible state
- Codex candidate selection behaves correctly in realistic multi-candidate scenarios

The goal is not broader unit coverage. It is direct coverage of the real startup contract that suggestion 1 depends on.

## Verification

The local test suite passed during review:

```bash
node --test test.mjs
```

I also revalidated the relay-mode issue directly with a small local reproduction. With an existing session binding in place, a later successful structured read still leaves `relayMode` at `pane`, confirming that the stale-state issue remains present in the current implementation.

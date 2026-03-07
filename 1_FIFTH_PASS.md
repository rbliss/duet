# Fifth Pass Review: Suggestion 1

This document covers a fifth-pass review of the implementation intended to address the original first finding: session binding and relay correctness.

## 1. Claude Binding Is Now Correctly Confirmed At Launch

**Severity:** Closed  
**References:** [duet.sh](/home/claude/duet/duet.sh#L68), [duet.sh](/home/claude/duet/duet.sh#L71), [duet.sh](/home/claude/duet/duet.sh#L86), [duet.sh](/home/claude/duet/duet.sh#L90)

The prior Claude-specific issue appears resolved.

Earlier versions tried to predict Claude's session log path by reconstructing Claude's internal project-directory naming convention from the working directory. That proved brittle and was wrong on this machine. The current implementation no longer relies on that prediction. Instead, the launcher generates a unique session id, starts Claude with that id, and then polls the Claude session tree until the exact `UUID.jsonl` file actually appears on disk. Only after the file is confirmed does Duet write the authoritative binding into the session state directory.

This is the right shape architecturally. The session path is no longer assumed from a naming transformation; it is confirmed from the artifact Claude actually created. That removes the previous path-mismatch failure mode and makes Claude binding much more robust to implementation details inside Claude's own project storage layout.

### Suggested remedy

No further architectural change is needed for the Claude side of suggestion 1 unless a future regression appears. The current approach follows the right principle: bind to a confirmed artifact rather than a predicted location.

## 2. Codex Binding Is Substantially Better, But Still Not A Unique Process-Level Ownership Guarantee

**Severity:** Medium  
**References:** [duet.sh](/home/claude/duet/duet.sh#L69), [duet.sh](/home/claude/duet/duet.sh#L70), [duet.sh](/home/claude/duet/duet.sh#L94), [duet.sh](/home/claude/duet/duet.sh#L97), [duet.sh](/home/claude/duet/duet.sh#L98), [duet.sh](/home/claude/duet/duet.sh#L99)

The Codex side is now materially stronger than before.

Earlier versions accepted any newly appearing Codex session file within the launch window. That could bind Duet to the wrong Codex session if another Codex instance started at the same time. The current implementation narrows the candidate set by reading the first `session_meta` record from each new file and confirming that `payload.cwd` matches the working directory Duet launched with. I verified that current Codex session logs on this box do include `payload.cwd`, so this filter is grounded in the actual data format.

That closes the earlier "wrong directory" class of false match. But it is still not a unique process-level ownership guarantee. If two Codex sessions are launched against the same working directory during the same polling window, both candidates satisfy the current predicate. In that case the binding is still selected by discovery order rather than by a unique startup identity shared between the launched process and the relay layer.

So the architecture has improved from broad timing inference to constrained timing inference. That is real progress, but it does not fully reach the standard of explicit process-scoped ownership that suggestion 1 was aiming toward.

### Suggested remedy

If Duet needs the strongest possible ownership guarantee for Codex, the design should move from "confirm same workspace" to "confirm this exact launched instance."

Architecturally, that means introducing a Codex-specific startup identity or handshake that can be propagated into the session artifact and then verified by Duet. If Codex does not expose such a mechanism directly, the fallback design should explicitly document that Codex binding is authoritative only up to workspace-level uniqueness, not process-level uniqueness.

The key point is to be precise about the guarantee the system is actually making. Right now it can reasonably claim "same working directory" ownership, but not "same exact process" ownership.

## 3. The Router Still Does Not Surface Whether Relay Is Authoritative Or Fallback

**Severity:** Medium  
**References:** [router.mjs](/home/claude/duet/router.mjs#L102), [router.mjs](/home/claude/duet/router.mjs#L121), [router.mjs](/home/claude/duet/router.mjs#L315), [router.mjs](/home/claude/duet/router.mjs#L318)

The current router design still silently degrades from structured session-log relay to pane-scrape relay when authoritative session data is unavailable.

Functionally, this keeps Duet usable, which is a good property. But it means the user cannot tell whether suggestion 1 is actively in effect for a given tool. If a binding never resolves, if the state file is missing, or if the log file never becomes readable, the system simply returns no structured response and falls back to pane capture. The session remains usable, but the user loses visibility into which quality tier of relay they are getting.

This matters because the recent design work has been specifically about distinguishing authoritative, session-bound relay from best-effort terminal capture. If the UI does not expose that distinction, then a partial failure in the binding system is hard to detect and hard to reason about. The architecture has improved, but the operational model remains opaque.

### Suggested remedy

The router should model relay source quality explicitly.

Architecturally, each tool should have a visible relay state such as:

- authoritative session-bound relay active
- session binding pending
- fallback pane relay active
- binding failed

That state should be surfaced in the router UI and usable for diagnostics. The important design principle is that authoritative and fallback relay are different operating modes, and the system should treat them as such rather than silently collapsing them into one user experience.

## 4. The Most Important New Binding Behavior Still Lacks End-To-End Launcher Coverage

**Severity:** Medium  
**References:** [test.mjs](/home/claude/duet/test.mjs#L490), [test.mjs](/home/claude/duet/test.mjs#L633), [test.mjs](/home/claude/duet/test.mjs#L660), [test.mjs](/home/claude/duet/test.mjs#L700)

The incremental session reader is now better covered than before, which is useful. The tests validate offset handling, partial-line handling, and response extraction for both Claude and Codex. That meaningfully improves confidence in the structured-reader layer.

But the launcher-level binding path still carries the bulk of the correctness burden, and that path remains untested end to end. The current tests bind the reader by directly mutating `sessionState`, which explicitly bypasses the session-path resolution flow from the launcher and the state directory. The existing launcher tests still focus on tmux layout and basic session setup rather than real session binding confirmation.

This means the most critical behavior introduced by the recent passes is still not exercised under realistic startup conditions:

- Claude binding via confirmed UUID-named log discovery
- Codex binding via candidate detection and `session_meta.cwd` verification
- state-dir handoff from launcher to router
- authoritative binding persistence across normal session startup

Without that coverage, regressions in suggestion 1 are still likely to be caught manually rather than automatically.

### Suggested remedy

Add an end-to-end binding test layer that treats the launcher-to-router handoff as the unit under test.

Architecturally, that test layer should validate:

- that a launched session produces binding metadata for both tools
- that the router can resolve and use those bindings without direct test-side mutation
- that binding metadata reflects the actual launched session artifacts
- that fallback mode is entered explicitly when authoritative binding does not materialize

The design goal is not more low-level parser tests. It is confidence that the real startup contract behind suggestion 1 works as intended.

## Verification

The local test suite passed during review:

```bash
node --test test.mjs
```

Claude binding now appears correctly fixed. Codex binding is substantially improved but still not uniquely process-bound, and Duet still does not expose when it has fallen back from authoritative relay to pane capture.

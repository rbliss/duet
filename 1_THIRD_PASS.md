# Third Pass Review: Suggestion 1

This document covers a third-pass review of the implementation intended to address the original first finding: session binding and relay correctness.

## 1. Session Ownership Is Still Inferred By A One-Shot Filesystem Window, Not Established By A Real Launch Handshake

**Severity:** High  
**References:** [duet.sh](/home/claude/duet/duet.sh#L67), [duet.sh](/home/claude/duet/duet.sh#L79), [duet.sh](/home/claude/duet/duet.sh#L85), [duet.sh](/home/claude/duet/duet.sh#L86)

The implementation is materially better than the previous version. The router no longer scans global history trying to guess which Claude or Codex session belongs to the current Duet run. Instead, the launcher snapshots the known session directories before startup, waits for the tools to initialize, diffs the directory contents, and writes the discovered session paths into run-local metadata for the router to consume.

That is progress, but it is still not exact session ownership. The binding is still inferred from a timed filesystem window rather than established by a real launch-time handshake. There are two important consequences.

First, the binding depends on a fixed startup delay. If a tool creates its session file later than the current wait window, no binding is recorded. The system may still appear to work because pane capture remains available, but the authoritative relay source is silently missing.

Second, the discovery process still assumes that any newly created session file in that window belongs to the specific pane Duet launched. That can be wrong if another Claude or Codex instance starts during the same interval, or if the user already has concurrent activity that touches those session trees in overlapping ways. The use of `tail -1` as the selector means multiple candidates are collapsed by list order rather than by process identity or an explicit session contract.

Architecturally, this means Duet has moved from "guess the newest session later" to "guess the new session earlier." That improves behavior, but it still does not fully close the original correctness problem.

### Suggested remedy

The design should move from timed discovery to explicit ownership. Session binding should be part of startup, not a side effect inferred from filesystem diffs.

The right architecture is:

- a launch phase that treats session identity as required startup metadata
- a handshake or confirmation step that binds each pane to a concrete session artifact before normal routing begins
- per-run metadata that records those exact bindings in a stable, structured form
- a router that refuses to treat global discovery as authoritative once the run has started

The important design principle is that Duet should know which session it owns because it established that fact directly, not because it inferred it from what appeared on disk during a fixed time window.

## 2. The Authoritative Binding Metadata Is Tied To The Wrapper Shell Lifetime, Not The Duet Session Lifetime

**Severity:** Medium  
**References:** [duet.sh](/home/claude/duet/duet.sh#L62), [duet.sh](/home/claude/duet/duet.sh#L64), [duet.sh](/home/claude/duet/duet.sh#L65), [duet.sh](/home/claude/duet/duet.sh#L93), [router.mjs](/home/claude/duet/router.mjs#L96)

The new design introduces a per-run state directory and passes it to the router through `DUET_STATE_DIR`. That is the right general direction. But the lifecycle of that directory is currently tied to the bootstrap shell, not to the Duet session as a whole.

The launcher creates the state directory under `/tmp` and removes it on shell exit through a trap. The router then resolves session paths lazily from files inside that directory. This creates a lifecycle mismatch: the metadata Duet depends on may disappear even though the tmux session and the tool panes are still alive.

That matters in a few cases:

- if the wrapper shell exits while the tmux session remains active
- if the router is restarted after startup and needs to re-resolve bindings
- if the initial resolution did not happen before the state directory was cleaned up

In those cases the session metadata stops being durable, and Duet can lose the authoritative binding information that the new architecture was meant to create. Once that happens, the system is pushed back toward fallback behavior and weaker relay guarantees.

This is not just an implementation detail. It reflects a deeper ownership question: what object owns the state? Right now the answer is "the shell script process." But the real long-lived object is the Duet session itself.

### Suggested remedy

The session metadata store should be owned by the Duet session lifecycle, not by the bootstrap shell lifecycle.

The design should provide:

- a run-local state location with a lifetime that matches the tmux session
- metadata that remains available for router restarts, delayed resolution, and diagnostics
- explicit cleanup only when the Duet session is intentionally shut down
- a clear distinction between ephemeral bootstrap artifacts and durable session metadata

The key principle is that authoritative relay state should persist for as long as the collaborative session exists. If the session is still alive, the metadata that defines its ownership should still exist too.

## Verification

The local test suite passed during review:

```bash
node --test test.mjs
```

The incremental reader itself appears substantially improved and now has better test coverage. The main remaining gap for suggestion 1 is session ownership and state durability across the full Duet session lifecycle.

# Fourth Pass Review: Suggestion 1

This document covers a fourth-pass review of the implementation intended to address the original first finding: session binding and relay correctness.

## 1. Claude's "Explicit Ownership" Binding Currently Resolves To The Wrong Log Path On This Machine

**Severity:** High  
**References:** [duet.sh](/home/claude/duet/duet.sh#L72), [duet.sh](/home/claude/duet/duet.sh#L73), [duet.sh](/home/claude/duet/duet.sh#L74), [router.mjs](/home/claude/duet/router.mjs#L101)

The architecture has improved significantly. Claude is no longer supposed to be discovered by a best-effort filesystem scan. Instead, the launcher generates a Claude session id up front, predicts the deterministic log path, and records that path into Duet's session metadata before launch.

That is the right direction in principle, but on this machine the predicted path does not match where Claude actually writes the session log.

The launcher currently derives the Claude project directory by transforming the working directory path and stripping the leading dash. For `/home/claude/duet`, that produces `home-claude-duet`. But a direct verification run showed that Claude actually writes to a project directory named `-home-claude-duet`, with the leading dash preserved.

That means the launcher is recording a path that does not exist, and the router binds to that non-existent path as though it were authoritative. Since the file never appears, the incremental reader never sees Claude's structured session output. In practice, Duet falls back to pane capture for Claude despite appearing to have an explicit ownership model.

This is an important distinction: the architecture is closer to correct, but the concrete implementation breaks the ownership guarantee at the final step. The result is a silent failure mode where the system believes it has exact Claude ownership when it does not.

### Suggested remedy

The launcher should not attempt to reverse-engineer Claude's internal project-directory naming rules.

Architecturally, Duet should treat "predicted location" and "confirmed location" as separate states. A valid session binding should only become authoritative once the exact Claude session artifact has been confirmed. That confirmation step should be part of the startup contract and should update the persistent session metadata with the real resolved path.

The key design principle is that explicit ownership should come from confirmation, not from a guessed naming convention that happens to work most of the time.

## 2. Codex Ownership Is Still Inferred From Filesystem Timing Rather Than Established Explicitly

**Severity:** High  
**References:** [duet.sh](/home/claude/duet/duet.sh#L76), [duet.sh](/home/claude/duet/duet.sh#L79), [duet.sh](/home/claude/duet/duet.sh#L86), [duet.sh](/home/claude/duet/duet.sh#L90), [duet.sh](/home/claude/duet/duet.sh#L92)

The state-lifetime part of the third-pass recommendation is substantially improved. Duet now stores session metadata in a session-scoped directory that outlives the bootstrap shell, which is the correct ownership model for the metadata itself.

But Codex session binding is still not explicit ownership. The launcher snapshots the Codex sessions directory before startup, polls for up to 15 seconds, diffs the directory contents, and records the last newly appearing file. That is still a heuristic based on filesystem timing.

This means Codex remains vulnerable to the same class of ambiguity the earlier reviews called out, even if the timing window is narrower and the metadata persistence is stronger:

- another Codex session can create a new file during the same detection window
- Codex may update an existing session instead of creating a brand new one
- the relevant file may appear later than the current polling window
- multiple candidates may be collapsed by list order rather than by true session identity

So while Claude was moved toward explicit ownership in design, Codex still operates under a discovery model. Suggestion 1 is therefore only partially resolved: the architecture is asymmetric. One tool is aiming for explicit identity, while the other is still inferred by side effects.

### Suggested remedy

Codex should be brought to the same ownership standard as Claude's intended design.

Architecturally, the launch sequence should not mark Codex's session source as authoritative until Duet has explicit, session-scoped confirmation of which artifact belongs to the Codex instance it launched. If that cannot be obtained directly, the system should model Codex as being in a known fallback state rather than treating a timed filesystem guess as authoritative ownership.

The key principle is consistency: either both tools have explicit startup ownership, or the system should clearly distinguish authoritative bindings from provisional ones. Mixed semantics make the relay layer harder to reason about and harder to trust.

## Verification

The local test suite passed during review:

```bash
node --test test.mjs
```

The session-state lifetime work and incremental reader remain improved. The main remaining issues for suggestion 1 are still exact ownership and correctness of the binding handshake.

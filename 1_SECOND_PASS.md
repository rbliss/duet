# Second Pass Review: Suggestion 1

This document covers a second-pass review of the implementation intended to address the original first finding: session binding and relay correctness.

## 1. Heuristic Session Binding Is Still Not Real Session Ownership

**Severity:** High  
**References:** [router.mjs](/home/claude/duet/router.mjs#L85), [router.mjs](/home/claude/duet/router.mjs#L118), [router.mjs](/home/claude/duet/router.mjs#L140), [duet.sh](/home/claude/duet/duet.sh#L63), [duet.sh](/home/claude/duet/duet.sh#L64)

The new design improves efficiency by resolving one Claude log path and one Codex log path once, then reusing them. That is better than rescanning global history on every relay. But it still does not bind Duet to the actual sessions it launched. The router is still inferring ownership from filesystem timing: it scans all global session logs, filters to files newer than `LAUNCH_TIME`, and picks the newest one. That is still a guess.

The problem is that "newest file after startup" is not the same thing as "the session in this tmux pane." If the user has another Claude or Codex instance running elsewhere on the machine, or starts one shortly after Duet launches, that unrelated session can still become the selected binding. The 5-second pre-launch buffer widens the eligible set further, so even a session that was already active just before Duet started can be considered a candidate. Because the binding is cached lazily and then reused permanently, the first bad selection can poison the rest of the run.

Architecturally, this means the patch reduces repeated work but does not solve the correctness boundary. Duet still has no authoritative notion of session identity. It is faster at guessing, but it is still guessing.

### Suggested remedy

The design should move from time-based discovery to explicit ownership. Duet should establish a concrete session identity for each pane at launch time and persist that identity in run-local state. The router should then consume only those exact session sources for relay and transcript decisions.

A good architecture here is:

- a per-run state directory owned by the Duet session
- launch metadata for each tool, including stable session identifiers and resolved log or event sources
- a startup handshake phase where the launcher waits until each tool's session source is known, then passes that information to the router
- a router that treats those sources as fixed inputs, not something to rediscover from global history

That design removes race conditions with unrelated sessions, makes relays deterministic, and gives later features a stable foundation. It also makes testing much more meaningful, because the system can be validated against exact session ownership rather than timing heuristics.

## 2. Fixed Tail Reading Can Return Stale Content Instead Of The Current Reply

**Severity:** Medium  
**References:** [router.mjs](/home/claude/duet/router.mjs#L86), [router.mjs](/home/claude/duet/router.mjs#L93), [router.mjs](/home/claude/duet/router.mjs#L104), [router.mjs](/home/claude/duet/router.mjs#L176), [router.mjs](/home/claude/duet/router.mjs#L199)

The new log reader now reads only the last 32 KB of the selected session file and then parses backward through the last few JSONL lines. That is a sensible optimization in principle, but the current design assumes the latest relevant message fits fully inside that tail window. If it does not, the reader can cut into the middle of the newest JSONL record.

The implementation explicitly drops the first line when the tail starts mid-file, which is the right thing to do for malformed partial input. But that creates a subtle failure mode: if the newest assistant message or task-complete event begins before the 32 KB cutoff, the parser loses that entry entirely. When that happens, the reverse scan can fall back to an older complete message that is still visible in the tail. The relay path then returns stale content while believing it found the latest response.

That is a worse failure mode than returning nothing. A miss would at least force fallback behavior and be obvious during debugging. A stale-but-valid older message can be relayed confidently, which makes the system look correct while passing the wrong context to the other agent. The longer and richer the model outputs become, the more likely this becomes.

### Suggested remedy

The log reader should be designed around message boundaries, not fixed byte windows. The architecture should guarantee that the router can reconstruct the newest complete logical event even when the file grows large or a single response is long.

There are several solid design directions:

- maintain an incremental cursor per session and process appended log entries as a stream
- store parsed event offsets in per-run state so the router advances through the file rather than re-sampling its tail
- treat "latest complete assistant event" as a tracked artifact, updated continuously as the source grows
- fall back to pane capture only when the authoritative session source cannot produce a complete current event

The key design principle is that relay should operate on complete structured events from a tracked session source, not on opportunistic snapshots of the file tail. That removes the stale-response risk and makes relay correctness independent of output size.

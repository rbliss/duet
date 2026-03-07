# Findings

## 1. Relay extraction is not bound to the Duet-launched sessions, and it gets slower as history grows

**Severity:** High  
**References:** [router.mjs](/home/claude/duet/router.mjs#L82), [router.mjs](/home/claude/duet/router.mjs#L120), [router.mjs](/home/claude/duet/router.mjs#L296)

The router currently discovers the "latest" Claude and Codex response by scanning each tool's global session directories under the user's home directory, selecting the newest JSONL file, and then reading back through recent lines. That has two structural problems.

First, correctness: Duet is assuming the newest session on disk belongs to the pane it launched. That assumption fails as soon as the user has another Claude or Codex session open elsewhere. At that point Duet can relay output from the wrong conversation. This is not a rare edge case; it is the natural state on a machine where both tools are already in active use.

Second, performance: every relay decision re-traverses directories and re-reads session files whose size only grows over time. That means the cost of a handoff increases with accumulated account history rather than with the amount of new output produced in the current run. As the history trees under `~/.claude` and `~/.codex` grow, relay work becomes more expensive and less predictable.

This combination is especially problematic because it couples correctness and latency. The same global-history scan that makes handoff slower also makes it easier to pick the wrong session. The result is a system that can feel sluggish and occasionally misroute content for reasons that are hard for the user to diagnose from the UI.

### Suggested remedy

Treat session identity as a first-class runtime object. At launch, Duet should establish and persist a concrete binding for each pane to a specific Claude session and a specific Codex session, then consume only those streams for relay decisions.

Architecturally, that means introducing a per-run state directory with stable metadata, plus an incremental reader that tails known sources instead of rescanning global history. The important design shift is from "find the newest thing on disk" to "follow the exact session this pane owns." Once that boundary exists, relay becomes deterministic, fast, and isolated from unrelated tool usage on the same machine.

## 2. The watch/converse relay path has an intentional multi-second delay, and that is the main communication bottleneck

**Severity:** High  
**References:** [router.mjs](/home/claude/duet/router.mjs#L241), [router.mjs](/home/claude/duet/router.mjs#L265), [router.mjs](/home/claude/duet/router.mjs#L282)

The current design polls each pane every 2 seconds and waits for 3 unchanged polls before treating output as "stable." In practice that means Duet often waits around 6 seconds after an agent has finished speaking before it forwards anything. That is a large delay for a system whose core value proposition is rapid back-and-forth collaboration.

This affects both perceived responsiveness and actual throughput. In watch mode, mentions do not trigger a handoff until the stability window expires. In converse mode, every round pays the full debounce cost, so a multi-round exchange becomes dominated by idle waiting rather than useful work. The end result is that the system feels like a batch relay tool instead of a live collaborative console.

The deeper problem is that the design is based on screen sampling rather than event observation. Duet is trying to infer "done speaking" by periodically checking whether the rendered terminal content changed. That is inherently coarse and introduces avoidable latency. It also makes the timing behavior fragile: short pauses can trigger premature stabilization, and longer rendering churn can delay relay even after the meaningful answer is already visible.

### Suggested remedy

Move the communication path from state polling to event-driven observation. The design goal should be "react to newly emitted content," not "sample the screen until it stops changing."

There are several acceptable architectures for this: pane output streaming, session log tailing, or a transport abstraction that emits message chunks and completion signals. Even if some debounce remains, it should be tied to actual new bytes or lines arriving, not coarse periodic snapshots. That change will reduce latency more than any other single improvement and make the tool feel conversational rather than delayed.

## 3. Codex launch-time instruction injection is too thin for "Duet skills," and the current launch mode also hurts transcript fidelity

**Severity:** Medium  
**References:** [duet.sh](/home/claude/duet/duet.sh#L64), [DUET.md](/home/claude/duet/DUET.md#L1)

Right now Codex is given a single Duet instruction file at startup. That is useful for role framing, but it is not the same thing as giving Codex real Duet-specific capabilities. Instructions are a flat prompt layer; skills are a reusable capability layer with naming, discoverability, and clearer reuse boundaries.

If the goal is "Codex should have Duet behaviors when launched," then this should be modeled as a profile plus skill bundle, not just a blob of startup text. A single prompt can explain the existence of the other agent and the mention protocol, but it does not create a structured vocabulary of Duet-specific operations or workflows that Codex can reliably reuse across sessions.

There is also a transcript-quality issue. The router depends heavily on terminal capture and scrollback, but Codex is not currently launched in the mode best suited for preserving visible output in a tmux environment. If the transport architecture still relies on pane capture for part of the workflow, the Codex pane should be configured for maximum observable continuity rather than a rendering mode that hides useful context from the router.

### Suggested remedy

Separate the concerns into three layers.

First, keep a small always-on Duet identity prompt that explains the shared environment and mention protocol. Second, define Duet-specific skills for recurring behaviors such as cross-agent review, relay etiquette, and concise handoff formatting. Third, package those under a dedicated Codex profile so Duet can launch Codex in a known configuration.

If portability matters and you do not want Duet mutating the user's general Codex home, create a session-scoped Codex environment that overlays Duet's profile and skills onto the existing authenticated account state. That gives Duet-specific behavior without entangling it with the user's broader Codex setup.

## 4. The router blocks itself while sending messages, which limits throughput and makes the UI feel sluggish

**Severity:** Medium  
**References:** [router.mjs](/home/claude/duet/router.mjs#L26), [router.mjs](/home/claude/duet/router.mjs#L39)

The transport layer uses synchronous shell execution and fixed sleeps for sends and pastes. That means every dispatch freezes the router event loop for the duration of the tmux call plus the artificial wait. During those windows, the router cannot process new user input, cannot watch panes efficiently, and cannot pipeline follow-up relays.

This matters because the router is doing several jobs at once: interactive command parsing, watch-mode polling, converse-mode state management, and relay dispatch. A blocking transport means all of those responsibilities contend for the same thread of control. Even when each individual delay is small, the accumulated effect is noticeable because the tool's entire UI and automation logic pause on every handoff.

The fixed sleeps also encode timing assumptions about the receiving TUIs. Those assumptions may hold on one machine and fail on another, or work for one release of a CLI and degrade on the next. This makes the transport behavior harder to reason about and harder to tune systematically.

### Suggested remedy

Model transport as an asynchronous subsystem with explicit delivery queues per pane. The router should enqueue intent immediately, let a transport worker perform the tmux interaction, and receive completion or failure events back.

That architecture gives you backpressure, better observability, and cleaner composition with watch and converse mode. It also lets you replace fixed sleeps with readiness heuristics based on observed output or pane state, which improves both speed and reliability.

## 5. Launch command construction is brittle and couples transport logic too tightly to shell quoting concerns

**Severity:** Low  
**References:** [duet.sh](/home/claude/duet/duet.sh#L63), [duet.sh](/home/claude/duet/duet.sh#L64)

The launcher builds long shell command strings that include directory changes, flags, and embedded prompt text. That works in the happy path, but it is fragile around unusual paths, quoting edge cases, and future expansion.

This is less about immediate security concerns in this particular setup and more about maintainability. Once launch configuration becomes more complex, string-built shell commands become the place where small environment issues turn into opaque startup failures. Paths containing spaces, additional startup metadata, richer profile selection, or environment overlays all increase the likelihood that launch semantics become difficult to reason about.

It also mixes responsibilities. Right now the same layer is deciding policy, building commands, and handling shell-escaping details. That makes it harder to evolve the launcher toward richer per-tool configuration without turning it into a progressively more delicate shell-assembly mechanism.

### Suggested remedy

Introduce a clearer launch boundary. Conceptually, Duet should build structured launch specifications for Claude and Codex, including working directory, environment, profile, and startup instructions, and then have a transport layer responsible for realizing those specs in tmux.

That keeps quoting and process startup mechanics separate from Duet policy. It also makes it much easier to add things like session metadata, per-run temporary homes, tool-specific profiles, and debug logging without turning the launcher into a shell-escaping exercise.

## Verification

The local test suite passed during review:

```bash
node --test test.mjs
```

That means these are architectural improvement findings rather than current test failures.

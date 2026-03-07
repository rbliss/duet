# Suggestion 1 Redesign

This document writes up option 2 from the review discussion: redesign suggestion 1 properly instead of continuing the current patch-and-review loop.

The goal is to make session binding and relay correctness exact by construction, especially on the Codex side where the current design has plateaued at workspace-level ownership.

## Problem Statement

The current implementation has improved substantially, but it is still limited by the way it discovers Codex sessions:

- Claude can be tied to an exact launch through a unique session id.
- Codex is still discovered by observing filesystem side effects and filtering by working directory.
- Relay state mixes durable binding quality with transient fallback behavior.
- Tests validate the router’s consumption of binding files, but not the launcher contract that creates those files.

Those are not all “bugs” in the current code. They are signs that the current architecture is asking heuristic discovery to do a job that should be handled by explicit ownership boundaries.

## Redesign Goal

Suggestion 1 should be reframed around one principle:

**Each Duet run should own the session artifacts it relays from, and that ownership should be explicit, durable, and testable.**

If that is the standard, then the launcher, router, and tests all need to be built around session ownership as a first-class concept rather than around discovery from global state.

## Proposed Architecture

## 1. Per-Run Runtime State

Each Duet run should create a dedicated runtime directory for everything that belongs to that run.

That directory should contain:

- run metadata
- tool binding metadata
- session source information
- relay state
- diagnostics

This becomes the single source of truth for the router. The router should no longer infer ownership from global history once the run has started.

The important design shift is that Duet stops being “a shell script that launches tools and then hopes to rediscover them later” and becomes “a session manager with a durable runtime state model.”

## 2. Exact Claude Ownership

Claude already has the right primitive for exact ownership: a launch-time session id.

The redesign should keep the current Claude direction:

- launcher creates a unique Claude session id
- Claude is launched with that id
- binding is not considered active until the exact session artifact exists
- the confirmed artifact is recorded in run-local state

Claude is already close to the target design. The redesign mainly needs to preserve that behavior and make it part of a consistent launcher contract.

## 3. Exact Codex Ownership Through Session-Store Separation

This is the main architectural change.

The cleanest way to get exact Codex ownership is to stop discovering Codex sessions inside the user’s shared global session store. Instead, Duet should launch Codex with a run-scoped session store that belongs only to that Duet run, while leaving account ownership and authentication on the normal supported path.

That means:

- Codex should keep using the user’s existing logged-in account
- mutable session artifacts should be isolated per Duet run
- the router should read only from that isolated store

This gives Duet exact Codex ownership by construction. If only one Duet-launched Codex instance can write to that run-scoped session area, there is no need to infer ownership from timing windows or workspace matching.

### Practical design

The safe model is to separate account reuse from session ownership:

- reuse the existing logged-in Codex account through normal supported configuration
- isolate only run-local mutable data such as session logs, history, and other relay inputs
- avoid sharing or symlinking mutable state stores between the user’s normal Codex runtime and the Duet runtime

Conceptually, this is not “a second account.” It is “the same account with a separate session store.”

The important safety constraint is that Duet should not depend on symlinking or otherwise sharing a live mutable SQLite-backed state store into a fake runtime home. That would blur isolation exactly where the design is trying to create it and would introduce unnecessary locking, upgrade, and corruption risks.

If Codex exposes supported path controls for session/history storage, Duet should use those directly. If it does not, then exact Codex ownership may require upstream support from Codex rather than more wrapper-side heuristics.

## 4. Explicit Launcher Contract

The launcher should become the component that establishes ownership and publishes it to the router as a formal contract.

That contract should include:

- tool identity
- ownership level
- confirmed session artifact location
- binding status
- time of confirmation

The router should consume this contract, not rediscover it.

This is an important separation of concerns:

- launcher: establishes and confirms ownership
- router: consumes confirmed ownership and performs relay

Right now those concerns are blurred because the launcher and router both participate in “figuring out what session this probably is.” The redesign should eliminate that ambiguity.

## 5. Split Binding State From Relay State

The current relay-mode issue exists because one flag is trying to describe too many things.

The redesign should separate:

- binding state: whether authoritative session ownership exists
- relay source state: what source was used for the most recent relay

Those are different questions.

A tool can still have:

- a valid authoritative binding
- a temporary fallback relay on one turn

without ceasing to be session-bound overall.

This distinction should appear both in the runtime model and in the UI. Users should be able to see:

- whether the tool is authoritatively bound
- whether the latest relay used structured logs or pane capture

That keeps diagnostics truthful without letting transient fallback permanently degrade the reported session state.

## 6. Authoritative Relay Sources

The router should prefer structured session artifacts as the canonical relay input whenever authoritative binding exists.

Pane capture should become an explicitly lower-trust fallback path rather than a silent substitute.

That implies three design rules:

- structured relay is the default for bound sessions
- fallback relay is visible when it happens
- fallback does not erase the fact that a binding still exists

This makes relay quality observable and gives the system a clear model for degraded operation.

## 7. Launcher-Contract Tests

The current tests mostly validate the consumer side of the design. The redesign needs tests for the producer side as well.

The most important new test layer should target the launcher-to-router contract.

That layer should validate:

- a run publishes tool bindings only after confirmation
- published bindings point to the actual session artifacts created for that run
- Codex session ownership is exact under the separated-session-store model
- missing or delayed bindings produce the expected router-visible state
- temporary relay fallback does not corrupt durable binding state

The key change is the unit of testing. Instead of treating path files as the start of the system, tests should treat launcher-confirmed ownership as the start of the system.

## Migration Plan

This redesign is easiest to land as a bounded replacement for suggestion 1 rather than as another incremental tweak.

Recommended sequence:

1. Introduce a run-local runtime directory and formal binding metadata.
2. Move Codex to a run-scoped session store while continuing to use the user’s normal logged-in account through supported configuration.
3. Update the router to consume only launcher-published bindings.
4. Split binding state from per-relay source state.
5. Add launcher-contract tests before expanding behavior further.

That sequencing limits churn and gives each phase a clear success condition.

## Tradeoffs

This redesign is heavier than the current patch cycle, but it is heavier in the right place.

What it costs:

- more launcher/runtime complexity
- explicit runtime-state management
- a new testing layer

What it buys:

- exact ownership for Codex instead of workspace-level heuristics, if Codex exposes the required storage boundaries
- a truthful relay-state model
- tests that exercise the actual source of correctness
- an architecture that is easier to extend later

If exact session ownership matters, this is the cleaner path.

## Success Criteria

Suggestion 1 should be considered fully closed only when all of these are true:

- Claude binding is exact and confirmed.
- Codex binding is exact and run-scoped, not inferred from shared global state.
- The router distinguishes durable binding from per-relay fallback.
- The launcher-to-router ownership contract is under automated test.

Until then, the system may be usable, but suggestion 1 is only partially complete.

## Recommendation

If exact Codex ownership matters, stop iterating on the current heuristic design and replace it with a run-scoped ownership model that does not share mutable runtime state.

If exact Codex ownership does not matter, then document the current guarantee honestly and treat suggestion 1 as intentionally limited rather than unfinished.

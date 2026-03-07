# COMPLETED — Resume Plan

## Goal

Implement true Duet-level resume so that both Claude and Codex can be restarted by the wrapper and continue the same prior conversations, instead of relying on tmux reattach or ad hoc manual resume inside a pane.

The current asymmetry is:

- Claude can appear resumable because it uses its normal global session store and supports exact resume by session ID.
- Codex looks fresh because Duet launches it in a run-scoped `CODEX_HOME` and currently recreates that state on each new launch.

The design below fixes that by making Duet own durable run state for both tools.

## Core principles

- Resume must be based on exact stored session identifiers, not "most recent" heuristics.
- Duet must persist its own run metadata outside `/tmp`.
- `CODEX_HOME` must be durable and reused on resume.
- Session discovery and binding should have a single authority.
- Transcript visibility is not the same thing as resumability.

## What "resume" should mean

There are three distinct operations:

### Attach

If the tmux session is still alive, simply reattach to it.

- no relaunch
- no new session IDs
- no rebinding

### Resume

If the tmux session is gone, create a fresh tmux layout and reopen the same Claude and Codex conversations natively.

- Claude resumes the exact stored session
- Codex resumes the exact stored session
- Duet restores routing and transcript plumbing around them

### Fork

Create a new Duet run by branching from a prior run.

- Claude uses native fork semantics
- Codex uses native fork semantics
- the new run gets its own state directory and transcript

## Native CLI surfaces available on this machine

The design should use the exact native resume/fork surfaces already supported locally:

- Claude:
  - resume: `claude --resume <session-id>`
  - fork: `claude --resume <session-id> --fork-session`
- Codex:
  - resume: `codex resume <session-id>`
  - fork: `codex fork <session-id>`

Duet should not use Claude `--continue` or Codex `--last` as its core resume mechanism. Those are convenience shortcuts, not authoritative run identity.

## Durable state layout

Move run state out of `/tmp` and into a persistent per-user directory, for example:

```text
~/.local/state/duet/
  runs/
    <run-id>/
      run.json
      bindings.json
      transcript.log
      codex-home/
      runtime/
  workspaces/
    <cwd-hash>.json
```

### `run.json`

Each run should persist:

- `run_id`
- `cwd`
- `created_at`
- `updated_at`
- `status`: `active`, `detached`, `stopped`, `broken`, `archived`
- `tmux_session`
- `mode`: `new`, `resumed`, `forked`
- `claude.session_id`
- `codex.session_id`
- `claude.binding_path`
- `codex.binding_path`
- `codex_home`
- launch options used for the run

### Workspace index

Maintain a small workspace index keyed by working directory hash so Duet can answer:

- is there an active run for this workspace?
- what is the most recent resumable run for this workspace?

## `CODEX_HOME` corrections

This is the critical change needed to make Codex resume correctly.

### Current problem

Today Duet creates a run-local `CODEX_HOME` but stores it under `/tmp` and deletes state on new launch. That makes Codex effectively start fresh from the wrapper's point of view.

### Correct behavior

For each Duet run:

- create a persistent `codex-home/` inside the durable run directory
- reuse that exact same path on resume
- never place resumable `CODEX_HOME` under `/tmp`
- never delete it on ordinary startup

### Ownership model inside `CODEX_HOME`

Run-local `CODEX_HOME` should own all mutable Codex runtime state:

- `sessions/`
- `history.jsonl`
- `log/`
- `shell_snapshots/`
- `state_*.sqlite`

Only share read-only user assets from the main Codex home:

- `auth.json`
- `config.toml`
- `version.json`
- `rules/`
- `skills/`

Do not symlink mutable SQLite-backed state from the user’s global Codex home. The run-local `CODEX_HOME` should be fully writable and self-contained apart from read-only auth/config assets.

### Why this matters

This fixes:

- Codex appearing "new" on every Duet restart
- inability to resume exact Codex sessions through the wrapper
- temporary-directory warnings and brittle runtime behavior

## Launcher behavior

### `duet`

Default entry behavior should be:

- if an active tmux-backed run exists for this workspace, attach
- otherwise create a new run

### `duet resume [run-id|last]`

- load the stored run manifest
- recreate tmux panes
- relaunch Claude against the stored Claude session
- relaunch Codex against the stored Codex session and stored `CODEX_HOME`
- relaunch the router using the stored run metadata

### `duet fork [run-id|last]`

- create a new run directory
- fork Claude from the source run's Claude session
- fork Codex from the source run's Codex session
- create a new persistent `CODEX_HOME` for the forked run

### `duet list`

Show resumable runs with:

- run id
- cwd
- age / updated time
- status
- whether Claude and Codex are both resumable

### `duet destroy [run-id]`

Permanently remove:

- run metadata
- transcript
- router/runtime files
- run-local `CODEX_HOME`

## Binding model during fresh runs and resumed runs

Keep a single binding authority:

- `bind-sessions.sh` owns discovery and binding lifecycle
- `router.mjs` only consumes `bindings.json`

### Binder lifecycle

The binder should:

- write an initial manifest immediately with `pending` state
- continue reconciling while any tool is unresolved
- transition each tool to `bound` when its authoritative artifact is confirmed
- transition to `degraded` only after timeout or clear failure

### Router behavior

The router should:

- re-read `bindings.json` while any tool is still `pending`
- upgrade transport from pane to session when a tool becomes `bound`
- never perform independent session discovery

## Resume-specific reader behavior

This is important and easy to miss.

When Duet resumes a run and binds to already-existing session logs:

- initialize the incremental reader offset at the current end of the session file
- do not start reading from byte zero

Otherwise, the router will replay historical messages from the old conversation as if they were newly emitted output in the resumed run.

That rule applies to both Claude and Codex session readers.

## Router lifecycle semantics

Add explicit separation between detaching, quitting, and destroying:

### `/detach`

- detach the tmux client
- leave tools running
- leave run status as `active` or `detached`

### `/quit`

- stop the tools and tmux session
- preserve run metadata for later resume
- mark run as `stopped`

### `/destroy`

- stop the tools
- kill tmux
- remove persistent run state
- mark the run as deleted/archived

Current behavior should not be reused here, because destructive shutdown prevents resume by design.

## Failure handling

Resume should be per-tool, not all-or-nothing.

Examples:

- Claude resumes, Codex fails: Duet should still launch and clearly report that Claude resumed while Codex did not.
- Codex resumes, Claude fails: same idea.

The wrapper should expose this state explicitly in the router and in `duet list`, rather than silently substituting a fresh session.

## Minimum implementation milestone

Claude should implement the first version in this order:

1. Persistent run registry under `~/.local/state/duet`
2. Persistent per-run `CODEX_HOME`
3. Run manifest with exact Claude and Codex session IDs
4. Attach-vs-new logic in `duet.sh`
5. `duet resume` and `duet fork`
6. Non-destructive `/quit` and `/detach`
7. EOF-based reader initialization for resumed session logs

## Explicit anti-goals

Do not implement resume by:

- replaying transcript text into a fresh tool session
- using "latest file on disk" discovery
- relying on Codex `--last` or Claude `--continue` as the wrapper’s source of truth
- storing resumable runtime state under `/tmp`
- sharing mutable SQLite-backed Codex state with the global user home

## Result

With this design:

- Claude and Codex resume symmetrically
- Codex no longer appears fresh after Duet restart
- the wrapper, not the human, owns conversation continuity
- attach, resume, and fork become distinct and predictable operations

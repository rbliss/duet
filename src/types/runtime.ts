/**
 * Shared type definitions for launcher, router, and runtime modules.
 * These types match current reality — not an idealized future API.
 */

// ─── Tool names ──────────────────────────────────────────────────────────────

export type ToolName = 'claude' | 'codex';

// ─── Tmux ────────────────────────────────────────────────────────────────────

/** Synchronous tmux runner returned by createTmuxRunner. */
export type TmuxRunner = (...args: string[]) => string;

/** Terminal dimensions. */
export interface TermSize {
  cols: number;
  lines: number;
}

/** Pane IDs from createTmuxLayout. */
export interface TmuxLayout {
  claudePane: string;
  codexPane: string;
  routerPane: string;
}

/** Pane map keyed by tool name. */
export type PaneMap = Record<ToolName, string | undefined>;

// ─── Launcher ────────────────────────────────────────────────────────────────

/** Launcher configuration from getConfig(). */
export interface LauncherConfig {
  duetBase: string;
  runsDir: string;
  workspacesDir: string;
  duetDir: string;
  socket: string | undefined;
  noAttach: boolean;
}

/** Options for launchRouter. */
export interface LaunchRouterOptions {
  session: string;
  runDir: string;
  mode: string;
  claudePane: string;
  codexPane: string;
}

// ─── Router: parsed input ────────────────────────────────────────────────────

export type ParsedInput =
  | { type: 'empty' }
  | { type: 'help' }
  | { type: 'quit' }
  | { type: 'detach' }
  | { type: 'destroy' }
  | { type: 'clear' }
  | { type: 'watch' }
  | { type: 'stop' }
  | { type: 'status' }
  | { type: 'debug'; full: boolean }
  | { type: 'send-debug'; target: string; note: string | null }
  | { type: 'send-debug-error' }
  | { type: 'rebind'; target: string }
  | { type: 'focus'; target: string }
  | { type: 'snap'; target: string; lines: number }
  | { type: 'converse'; maxRounds: number; topic: string }
  | { type: 'relay'; from: string; to: string; prompt: string | null }
  | { type: 'relay_error' }
  | { type: 'both'; msg: string }
  | { type: 'claude'; msg: string }
  | { type: 'codex'; msg: string }
  | { type: 'unknown_command' }
  | { type: 'no_target' };

// ─── Router: state ───────────────────────────────────────────────────────────

/** Converse mode state. */
export interface ConverseState {
  turn: ToolName;
  rounds: number;
  maxRounds: number;
  topic: string;
}

/** Snapshot of router internal state (returned by getRouterState). */
export interface RouterStateSnapshot {
  watching: boolean;
  converseState: ConverseState | null;
  pendingTools: string[];
  watcherFailed: string[];
  fileWatcherActive: Record<ToolName, boolean>;
}

/** Callback for session relay events. */
export type NewOutputHandler = (tool: ToolName, content: string) => Promise<void>;

// ─── Session state ──────────────────────────────────────────────────────────

/** Per-tool session state tracked by session-reader. */
export interface SessionToolState {
  path: string | null;
  resolved: boolean;
  offset: number;
  lastResponse: string | null;
  relayMode: string;
  bindingLevel: string | null;
  lastSessionActivityAt: number;
}

/** Session state map keyed by tool name. */
export type SessionStateMap = Record<ToolName, SessionToolState>;

// ─── Bindings ───────────────────────────────────────────────────────────────

/** Single tool entry in bindings.json. */
export interface BindingEntry {
  path: string | null;
  level: string | null;
  status: string;
  confirmedAt: string | null;
  session_id: string | null;
}

/** Full bindings.json manifest. */
export interface BindingsManifest {
  claude: BindingEntry;
  codex: BindingEntry;
}

// ─── Session reader ─────────────────────────────────────────────────────────

/** Result of readIncremental. */
export interface IncrementalReadResult {
  hasNew: boolean;
  complete: boolean;
}

// ─── Reconciler ─────────────────────────────────────────────────────────────

/** Parsed environment for the binding reconciler. */
export interface ReconcilerEnv {
  claudeSessionId: string;
  claudeProjects: string;
  codexSessions: string;
  stateDir: string;
  workdir: string;
  bindTimeout: number;
  globalCodexSessions: string;
  resumeClaudePath: string | null;
  resumeCodexPath: string | null;
  resumeCodexSessionId: string | null;
}

/** Internal per-tool state during reconciliation. */
export interface ReconcilerToolState {
  status: string;
  path: string;
  level: string;
  sessionId: string;
}

// ─── Debug ──────────────────────────────────────────────────────────────────

/** Input parameters for collectDebugSnapshot. */
export interface DebugSnapshotInput {
  sessionState: Record<string, unknown>;
  routerState: RouterStateSnapshot;
  bindings: BindingsManifest | null;
  runJson: Record<string, unknown> | null;
  paneCaptures: Record<string, string | null> | null;
  full: boolean;
}

// ─── Workspace ───────────────────────────────────────────────────────────────

/** Result of resolveRunId. */
export interface ResolveRunResult {
  runId: string;
  error: string | null;
}

/** Workspace index stored in <cwd-hash>.json. */
export interface WorkspaceIndex {
  cwd: string;
  runs: string[];
  active: string | null;
}

/** Run entry in listRuns output. */
export interface RunListEntry {
  rid: string;
  short: string;
  status: string;
  mode: string;
  cwd: string;
  updated: string;
  claude: string;
  codex: string;
  tmux: string;
  title: string | null;
  resumable: boolean;
}

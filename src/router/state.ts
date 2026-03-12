/**
 * Router runtime state: mutable state containers, file watchers,
 * binding polling, and rebind logic.
 */

import { readFileSync, statSync, readdirSync, watch, existsSync } from 'fs';
import type { FSWatcher } from 'fs';
import { join } from 'path';
import type { Interface as ReadlineInterface } from 'readline';

import type {
  ToolName, ConverseState, RouterStateSnapshot,
  NewOutputHandler, SessionStateMap,
} from '../types/runtime.js';

import {
  sessionState as _sessionState, resolveSessionPath, readIncremental,
  isResponseComplete, getLastResponse, extractCodexSessionId,
} from '../relay/session-reader.js';

const sessionState = _sessionState as SessionStateMap;
import { updateRunJson } from '../runtime/run-store.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export const SESSION = process.env.DUET_SESSION || 'duet';
export const CLAUDE_PANE = process.env.CLAUDE_PANE;
export const CODEX_PANE = process.env.CODEX_PANE;

export const PANES: Record<string, string | undefined> = { claude: CLAUDE_PANE, codex: CODEX_PANE };

export const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m',
  bg: '\x1b[48;5;236m',
};

// ─── Timing constants ────────────────────────────────────────────────────────

const BINDING_POLL_MS = 1000;
const SESSION_DEBOUNCE_MS = 800;
const SESSION_COMPLETE_MS = 200;
export const RELAY_COOLDOWN_MS = 8000;

// ─── Mutable state ──────────────────────────────────────────────────────────

let rl: ReadlineInterface | null = null;
let watchInterval: true | null = null;
export const lastAutoRelayTime: Record<string, number> = {};
let converseState: ConverseState | null = null;

const fileWatchers: Record<string, FSWatcher> = {};
const fileDebounceTimers: Record<string, NodeJS.Timeout> = {};

let bindingPollTimer: NodeJS.Timeout | null = null;
let pendingTools = new Set<string>();

// Track tools whose watcher failed after binding — bound but not watching
export const watcherFailed = new Set<string>();

// Callback for session relay — set by controller to avoid circular deps
let newOutputHandler: NewOutputHandler | null = null;

// ─── Accessors ───────────────────────────────────────────────────────────────

export function setRl(readline: ReadlineInterface): void { rl = readline; }
export function isWatching(): boolean { return watchInterval !== null; }
export function prompt(): void { if (rl) rl.prompt(); }

export function getConverseState(): ConverseState | null { return converseState; }
export function setConverseState(state: ConverseState | null): void { converseState = state; }

export function setNewOutputHandler(handler: NewOutputHandler): void { newOutputHandler = handler; }

/**
 * Return binding state summary for user-facing messages.
 */
export function bindingStatus(tool: ToolName): string {
  const st = sessionState[tool];
  if (st.relayMode === 'session') return 'bound';
  if (st.relayMode === 'pending') return 'pending';
  return 'degraded';
}

/**
 * Get the latest structured session response for a tool, or null if unavailable.
 */
export function getSessionResponse(tool: ToolName): string | null {
  const logResponse = getLastResponse(tool) as string | null;
  return (logResponse && logResponse.length > 0) ? logResponse : null;
}

/**
 * Read current run.json for debug snapshots.
 */
export function readRunJson(): Record<string, unknown> | null {
  const runDir = process.env.DUET_RUN_DIR;
  if (!runDir) return null;
  const path = join(runDir, 'run.json');
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  return null;
}

/**
 * Assemble router-internal state for the debug snapshot.
 */
export function getRouterState(): RouterStateSnapshot {
  return {
    watching: isWatching(),
    converseState: converseState ? { ...converseState } : null,
    pendingTools: [...pendingTools],
    watcherFailed: [...watcherFailed],
    fileWatcherActive: {
      claude: !!fileWatchers.claude,
      codex: !!fileWatchers.codex,
    },
  };
}

// ─── File watcher functions (session-bound event-driven relay) ───────────────

export function startFileWatcher(tool: string): boolean {
  const filePath = sessionState[tool as ToolName].path;
  if (!filePath || fileWatchers[tool]) return false;
  try {
    try {
      const { mtimeMs } = statSync(filePath);
      sessionState[tool as ToolName].lastSessionActivityAt = Math.max(mtimeMs, Date.now());
    } catch {
      sessionState[tool as ToolName].lastSessionActivityAt = Date.now();
    }
    fileWatchers[tool] = watch(filePath, (eventType) => {
      if (eventType === 'change') onFileChange(tool);
    });
    fileWatchers[tool].on('error', () => {
      stopFileWatcher(tool);
      watcherFailed.add(tool);
      console.log(`\n${C.red}${tool}: session watcher failed — automation inactive. Use /rebind ${tool} to repair.${C.reset}`);
      prompt();
    });
    return true;
  } catch {
    return false;
  }
}

function stopFileWatcher(tool: string): void {
  if (fileWatchers[tool]) {
    fileWatchers[tool].close();
    delete fileWatchers[tool];
  }
  if (fileDebounceTimers[tool]) {
    clearTimeout(fileDebounceTimers[tool]);
    delete fileDebounceTimers[tool];
  }
}

export function stopFileWatchers(): void {
  for (const tool of Object.keys(fileWatchers)) stopFileWatcher(tool);
}

function onFileChange(tool: string): void {
  if (!watchInterval) return;
  const { hasNew, complete } = readIncremental(tool as ToolName);
  if (!hasNew) return;
  sessionState[tool as ToolName].lastSessionActivityAt = Date.now();
  if (fileDebounceTimers[tool]) clearTimeout(fileDebounceTimers[tool]);
  const delay = complete ? SESSION_COMPLETE_MS : SESSION_DEBOUNCE_MS;
  fileDebounceTimers[tool] = setTimeout(() => triggerSessionRelay(tool), delay);
}

async function triggerSessionRelay(tool: string): Promise<void> {
  const st = sessionState[tool as ToolName];
  if (!st.lastResponse) return;
  if (newOutputHandler) await newOutputHandler(tool as ToolName, st.lastResponse);
}

// ─── Polling start / stop ────────────────────────────────────────────────────

function scheduleBindingPoll(): void {
  if (!watchInterval || pendingTools.size === 0) return;
  bindingPollTimer = setTimeout(() => {
    pollBindings();
    scheduleBindingPoll();
  }, BINDING_POLL_MS);
}

function pollBindings(): void {
  for (const name of [...pendingTools]) {
    resolveSessionPath(name as ToolName);
    const st = sessionState[name as ToolName];
    if (st.relayMode === 'session' && st.path) {
      pendingTools.delete(name);
      if (startFileWatcher(name)) {
        console.log(`\n${C.green}${name}: binding resolved — session log watcher active${C.reset}`);
      } else {
        watcherFailed.add(name);
        console.log(`\n${C.red}${name}: binding resolved but watcher failed — automation inactive${C.reset}`);
      }
      prompt();
    } else if (st.relayMode !== 'pending') {
      // Degraded — binder gave up
      pendingTools.delete(name);
      console.log(`\n${C.yellow}${name}: binding degraded — automation unavailable${C.reset}`);
      prompt();
    }
  }
}

export function startPolling(): void {
  if (watchInterval) return;
  pendingTools = new Set();
  watcherFailed.clear();
  for (const name of (['claude', 'codex'] as ToolName[])) {
    resolveSessionPath(name);
    const st = sessionState[name];
    if (st.relayMode === 'session' && st.path) {
      if (startFileWatcher(name)) {
        // event-driven relay via session log
      } else {
        // Bound but watcher failed to start
        watcherFailed.add(name);
      }
    } else if (st.relayMode === 'pending') {
      pendingTools.add(name);
    }
    // degraded tools are not added — automation is unavailable for them
  }
  watchInterval = true; // flag: watching is active
  scheduleBindingPoll();
}

export function stopPolling(): void {
  watchInterval = null;
  if (bindingPollTimer) { clearTimeout(bindingPollTimer); bindingPollTimer = null; }
  converseState = null;
  stopFileWatchers();
  pendingTools = new Set();
  watcherFailed.clear();
}

// ─── Rebind ──────────────────────────────────────────────────────────────────

/**
 * Find the best rebind candidate by scanning for recent .jsonl files.
 */
export function findRebindCandidate(tool: ToolName): string | null {
  const st = sessionState[tool];
  if (!st.path) return null;
  const dir = st.path.replace(/\/[^/]+$/, '');
  try {
    const entries = readdirSync(dir);
    let best: string | null = null;
    let bestMtime = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const full = join(dir, entry);
      if (full === st.path) continue;
      try {
        const { mtimeMs } = statSync(full);
        if (mtimeMs > bestMtime) {
          bestMtime = mtimeMs;
          best = full;
        }
      } catch {}
    }
    return best;
  } catch {}
  return null;
}

/**
 * Rebind a tool to a new session file.
 */
export async function rebindTool(tool: ToolName, newPath: string): Promise<{ oldPath: string | null; newPath: string; newSid: string | null }> {
  const st = sessionState[tool];
  const oldPath = st.path;
  stopFileWatcher(tool);

  st.path = newPath;
  st.resolved = true;
  st.relayMode = 'session';
  st.lastResponse = null;

  try {
    const { size } = statSync(newPath);
    st.offset = size;
  } catch {}
  st.lastSessionActivityAt = Date.now();

  // Claude: session ID is the filename UUID. Codex: extract payload.id from first JSONL line.
  let newSid: string | null;
  if (tool === 'codex') {
    newSid = extractCodexSessionId(newPath);
  } else {
    const match = newPath.match(/([0-9a-f-]{36})\.jsonl$/i);
    newSid = match ? match[1] : null;
  }

  if (startFileWatcher(tool)) {
    pendingTools.delete(tool);
    watcherFailed.delete(tool);
  }

  const updates: Record<string, string> = { [`${tool}.binding_path`]: newPath, updated_at: new Date().toISOString() };
  if (newSid) updates[`${tool}.session_id`] = newSid;
  updateRunJson(updates);

  return { oldPath, newPath, newSid };
}

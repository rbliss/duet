import { createInterface } from 'readline';
import { rmSync, readFileSync, statSync, readdirSync, watch, existsSync } from 'fs';
import { join } from 'path';

// ─── Module imports ──────────────────────────────────────────────────────────

import { setRunDir, updateRunJson } from './src/runtime/run-store.mjs';
import { STATE_DIR, setStateDir, loadBindings } from './src/runtime/bindings-store.mjs';
import { collectDebugSnapshot, renderDebugReport } from './src/debug/debug-report.mjs';
import {
  sessionState, resolveSessionPath, readIncremental,
  extractClaudeResponse, extractCodexResponse, isResponseComplete,
  getClaudeLastResponse, getCodexLastResponse, getLastResponse,
  setDuetMode, extractCodexSessionId,
} from './src/relay/session-reader.mjs';
import {
  shellEscape, sendKeys, pasteToPane, capturePane, focusPane,
  killSession, detachClient,
} from './src/transport/tmux-client.mjs';

// ─── Re-exports for test backward compatibility ──────────────────────────────

export { shellEscape, sendKeys, pasteToPane, capturePane, focusPane } from './src/transport/tmux-client.mjs';
export { setRunDir, updateRunJson } from './src/runtime/run-store.mjs';
export { STATE_DIR, setStateDir } from './src/runtime/bindings-store.mjs';
export { collectDebugSnapshot, renderDebugReport } from './src/debug/debug-report.mjs';
export {
  sessionState, resolveSessionPath, readIncremental,
  extractClaudeResponse, extractCodexResponse, isResponseComplete,
  getClaudeLastResponse, getCodexLastResponse, getLastResponse,
  setDuetMode, extractCodexSessionId,
} from './src/relay/session-reader.mjs';

// ─── Configuration ───────────────────────────────────────────────────────────

const SESSION = process.env.DUET_SESSION || 'duet';
const CLAUDE_PANE = process.env.CLAUDE_PANE;
const CODEX_PANE = process.env.CODEX_PANE;

const PANES = { claude: CLAUDE_PANE, codex: CODEX_PANE };

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m',
  bg: '\x1b[48;5;236m',
};

// ─── Watch & converse helpers ────────────────────────────────────────────────

export function getNewContent(baseline, current) {
  if (!baseline) return current;
  if (baseline === current) return '';

  const baseLines = baseline.split('\n');
  const currLines = current.split('\n');

  let prefixLen = 0;
  const maxPrefix = Math.min(baseLines.length, currLines.length);
  while (prefixLen < maxPrefix && baseLines[prefixLen] === currLines[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const maxSuffix = Math.min(baseLines.length - prefixLen, currLines.length - prefixLen);
  while (suffixLen < maxSuffix &&
         baseLines[baseLines.length - 1 - suffixLen] === currLines[currLines.length - 1 - suffixLen]) {
    suffixLen++;
  }

  if (prefixLen > 0 || suffixLen > 0) {
    const inserted = currLines.slice(prefixLen, currLines.length - suffixLen);
    const result = inserted.filter(l => l.trim()).join('\n').trim();
    if (result) return result;
  }

  const baseSet = new Set(baseLines.map(l => l.trim()).filter(Boolean));
  const newLines = currLines.filter(l => l.trim() && !baseSet.has(l.trim()));
  return newLines.join('\n');
}

export function detectMentions(text) {
  const mentions = [];
  if (/@claude\b/i.test(text)) mentions.push('claude');
  if (/@codex\b/i.test(text)) mentions.push('codex');
  return mentions;
}

const BOX_CHARS = /[─│╭╮╰╯┌┐└┘├┤┬┴┼╔╗╚╝║═▔▁█▓▒░]/g;
const SPINNER = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]\s*/;

export function cleanCapture(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const withoutBox = trimmed.replace(BOX_CHARS, '').trim();
      if (withoutBox.length < 3) return false;
      if (SPINNER.test(trimmed)) return false;
      if (/^[⏎↩]?\s*(to send|to interrupt|\/help|\/compact|ESC to|Ctrl[+-])/i.test(trimmed)) return false;
      if (/^(Claude Code|Codex)\s*(v[\d.]|$)/i.test(trimmed)) return false;
      if (/^[$>]\s*$/.test(trimmed)) return false;
      return true;
    })
    .map(line => line.replace(/^[\s│║▏]+/, '').replace(/[\s│║▕]+$/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// ─── Watch / converse state ──────────────────────────────────────────────────

const BINDING_POLL_MS = 1000;    // poll interval for pending binding resolution
const SESSION_DEBOUNCE_MS = 800;
const SESSION_COMPLETE_MS = 200;
const RELAY_COOLDOWN_MS = 8000;

let rl = null;
let watchInterval = null;
export const lastAutoRelayTime = {};
let converseState = null;

const fileWatchers = {};
const fileDebounceTimers = {};

export function isWatching() { return watchInterval !== null; }

function prompt() { if (rl) rl.prompt(); }

// Return binding state summary for user-facing messages
function bindingStatus(tool) {
  const st = sessionState[tool];
  if (st.relayMode === 'session') return 'bound';
  if (st.relayMode === 'pending') return 'pending';
  return 'degraded';
}

// ─── File watcher functions (session-bound event-driven relay) ───────────────

function startFileWatcher(tool) {
  const filePath = sessionState[tool].path;
  if (!filePath || fileWatchers[tool]) return false;
  try {
    try {
      const { mtimeMs } = statSync(filePath);
      sessionState[tool].lastSessionActivityAt = Math.max(mtimeMs, Date.now());
    } catch {
      sessionState[tool].lastSessionActivityAt = Date.now();
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

function stopFileWatcher(tool) {
  if (fileWatchers[tool]) {
    fileWatchers[tool].close();
    delete fileWatchers[tool];
  }
  if (fileDebounceTimers[tool]) {
    clearTimeout(fileDebounceTimers[tool]);
    delete fileDebounceTimers[tool];
  }
}

export function stopFileWatchers() {
  for (const tool of Object.keys(fileWatchers)) stopFileWatcher(tool);
}

function onFileChange(tool) {
  if (!watchInterval) return;
  const { hasNew, complete } = readIncremental(tool);
  if (!hasNew) return;
  sessionState[tool].lastSessionActivityAt = Date.now();
  if (fileDebounceTimers[tool]) clearTimeout(fileDebounceTimers[tool]);
  const delay = complete ? SESSION_COMPLETE_MS : SESSION_DEBOUNCE_MS;
  fileDebounceTimers[tool] = setTimeout(() => triggerSessionRelay(tool), delay);
}

async function triggerSessionRelay(tool) {
  const st = sessionState[tool];
  if (!st.lastResponse) return;
  await handleNewOutput(tool, st.lastResponse);
}

// ─── Polling start / stop ────────────────────────────────────────────────────

let bindingPollTimer = null;

// Pending tools that need binding resolution polling
let pendingTools = new Set();

function scheduleBindingPoll() {
  if (!watchInterval || pendingTools.size === 0) return;
  bindingPollTimer = setTimeout(() => {
    pollBindings();
    scheduleBindingPoll();
  }, BINDING_POLL_MS);
}

function pollBindings() {
  for (const name of [...pendingTools]) {
    resolveSessionPath(name);
    const st = sessionState[name];
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

// Track tools whose watcher failed after binding — bound but not watching
export const watcherFailed = new Set();

function startPolling() {
  if (watchInterval) return;
  pendingTools = new Set();
  watcherFailed.clear();
  for (const name of ['claude', 'codex']) {
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

function stopPolling() {
  watchInterval = null;
  if (bindingPollTimer) { clearTimeout(bindingPollTimer); bindingPollTimer = null; }
  converseState = null;
  stopFileWatchers();
  pendingTools = new Set();
  watcherFailed.clear();
}

// downgradeToPane is removed — stale binding is a status note, not an automatic fallback.
// Use /rebind to manually re-discover a session file.
export function downgradeToPane(tool, reason) {
  // No-op: retained as export for test backward compat but no longer changes transport.
  console.log(`\n${C.yellow}${tool}: ${reason} — use /rebind ${tool} to re-discover session${C.reset}`);
  prompt();
}

// Find the best rebind candidate by scanning for recent .jsonl files
export function findRebindCandidate(tool) {
  const st = sessionState[tool];
  if (!st.path) return null;
  const dir = st.path.replace(/\/[^/]+$/, '');
  try {
    const entries = readdirSync(dir);
    let best = null;
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

// Rebind a tool to a new session file
export async function rebindTool(tool, newPath) {
  const st = sessionState[tool];
  const oldPath = st.path;
  stopFileWatcher(tool);

  st.path = newPath;
  st.resolved = true;
  st.relayMode = 'session';
  st.staleDowngraded = false;
  st.lastResponse = null;

  try {
    const { size } = statSync(newPath);
    st.offset = size;
  } catch {}
  st.lastSessionActivityAt = Date.now();

  // Claude: session ID is the filename UUID. Codex: extract payload.id from first JSONL line.
  let newSid;
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

  const updates = { [`${tool}.binding_path`]: newPath, updated_at: new Date().toISOString() };
  if (newSid) updates[`${tool}.session_id`] = newSid;
  updateRunJson(updates);

  return { oldPath, newPath, newSid };
}

// Read current run.json for debug snapshots
function readRunJson() {
  const runDir = process.env.DUET_RUN_DIR;
  if (!runDir) return null;
  const path = join(runDir, 'run.json');
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  return null;
}

// Assemble router-internal state for the debug snapshot
export function getRouterState() {
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

// Get the latest structured session response for a tool, or null if unavailable
function getSessionResponse(tool) {
  const logResponse = getLastResponse(tool);
  return (logResponse && logResponse.length > 0) ? logResponse : null;
}

export async function handleNewOutput(source, newContent) {
  const other = source === 'claude' ? 'codex' : 'claude';
  const now = Date.now();

  // --- Converse mode auto-relay (turn tracking prevents loops — no cooldown) ---
  if (converseState && converseState.turn === source) {
    converseState.rounds++;
    if (converseState.rounds > converseState.maxRounds) {
      console.log(`\n${C.yellow}[converse] Reached ${converseState.maxRounds} rounds — stopping${C.reset}`);
      converseState = null;
      prompt();
      return;
    }

    const direction = `${source}->${other}`;
    const response = getSessionResponse(source) || newContent;
    console.log(`\n${C.blue}[converse] round ${converseState.rounds}/${converseState.maxRounds}: ${source} -> ${other}${C.reset}`);
    const msg = `${source} says (round ${converseState.rounds} on "${converseState.topic}"):\n${response}`;
    const delivered = await pasteToPane(PANES[other], msg);
    if (!delivered) {
      // Don't advance turn or record cooldown on failed delivery
      converseState.rounds--;
      console.log(`${C.red}[converse] delivery to ${other} failed — turn not advanced${C.reset}`);
      prompt();
      return;
    }
    lastAutoRelayTime[direction] = now;
    converseState.turn = other;
    prompt();
    return;
  }

  // --- @mention detection (per-direction cooldown to prevent loops) ---
  const direction = `${source}->${other}`;
  if (now - (lastAutoRelayTime[direction] || 0) < RELAY_COOLDOWN_MS) return;

  const mentions = detectMentions(newContent);
  const mentionsOther = mentions.includes(other);

  if (mentionsOther) {
    const response = getSessionResponse(source) || newContent;
    console.log(`\n${C.blue}[auto] ${source} mentioned @${other} — relaying${C.reset}`);
    const msg = `${source} says:\n${response}`;
    const delivered = await pasteToPane(PANES[other], msg);
    if (delivered) {
      lastAutoRelayTime[direction] = now;
    } else {
      console.log(`${C.red}[auto] delivery to ${other} failed${C.reset}`);
    }
    prompt();
  }
}

// ─── Input parsing ───────────────────────────────────────────────────────────

export function parseInput(input) {
  if (!input) return { type: 'empty' };

  if (input === '/help') return { type: 'help' };
  if (input === '/quit' || input === '/exit') return { type: 'quit' };
  if (input === '/detach') return { type: 'detach' };
  if (input === '/destroy') return { type: 'destroy' };
  if (input === '/clear') return { type: 'clear' };
  if (input === '/watch') return { type: 'watch' };
  if (input === '/stop') return { type: 'stop' };
  if (input === '/status') return { type: 'status' };
  if (input === '/debug') return { type: 'debug', full: false };
  if (input === '/debug full') return { type: 'debug', full: true };

  if (input.startsWith('/send-debug ')) {
    const rest = input.slice(12).trim();
    const match = rest.match(/^(claude|codex)(?:\s+(.*))?$/);
    if (match) {
      return { type: 'send-debug', target: match[1], note: match[2] || null };
    }
    return { type: 'send-debug-error' };
  }

  if (input.startsWith('/rebind ')) {
    const target = input.slice(8).trim();
    return { type: 'rebind', target };
  }

  if (input.startsWith('/focus ')) {
    const target = input.slice(7).trim();
    return { type: 'focus', target };
  }

  if (input.startsWith('/snap ')) {
    const parts = input.slice(6).trim().split(/\s+/);
    return { type: 'snap', target: parts[0], lines: parseInt(parts[1]) || 40 };
  }

  if (input.startsWith('/converse ')) {
    const rest = input.slice(10).trim();
    const match = rest.match(/^(\d+)\s+(.+)/);
    if (match) {
      return { type: 'converse', maxRounds: parseInt(match[1]), topic: match[2] };
    }
    return { type: 'converse', maxRounds: 10, topic: rest };
  }

  if (input.startsWith('@relay ')) {
    const match = input.match(/@relay\s+(claude|codex)\s*>\s*(claude|codex)(?:\s+(.*))?/);
    if (match) {
      return { type: 'relay', from: match[1], to: match[2], prompt: match[3] || null };
    }
    return { type: 'relay_error' };
  }

  const bothMatch = input.match(/^@both[\s,:.!?;-]\s*(.*)/);
  if (bothMatch) return { type: 'both', msg: bothMatch[1] };

  const claudeMatch = input.match(/^@claude[\s,:.!?;-]\s*(.*)/);
  if (claudeMatch) return { type: 'claude', msg: claudeMatch[1] };

  const codexMatch = input.match(/^@codex[\s,:.!?;-]\s*(.*)/);
  if (codexMatch) return { type: 'codex', msg: codexMatch[1] };

  if (input.startsWith('/')) return { type: 'unknown_command' };
  return { type: 'no_target' };
}

// ─── Banner ──────────────────────────────────────────────────────────────────

function printBanner() {
  console.log(`
${C.cyan}${C.bold}  DUET ${C.reset}${C.dim} - Claude Code + Codex, one conversation${C.reset}

  ${C.magenta}@claude${C.reset} <msg>            Send to Claude Code
  ${C.green}@codex${C.reset}  <msg>            Send to Codex
  ${C.yellow}@both${C.reset}   <msg>            Send to both
  ${C.blue}@relay${C.reset}  src>dst [msg]    Relay one's output to the other

  ${C.cyan}/converse${C.reset} [n] <topic>    Start an n-round discussion (default 10)
  ${C.cyan}/watch${C.reset}                   Watch for @mentions and auto-relay
  ${C.cyan}/stop${C.reset}                    Stop watching / converse
  ${C.cyan}/status${C.reset}                  Show watch/converse state

  ${C.dim}/debug [full]             Print live debug snapshot
  /send-debug target [note] Send debug snapshot to claude|codex
  /focus claude|codex      Switch to pane (click router pane to return)
  /snap  claude|codex      View last output from a pane
  /rebind claude|codex     Re-discover session after manual /resume
  /clear                   Clear this screen
  /quit                    Stop tools, preserve state for resume
  /detach                  Detach — tools keep running
  /destroy                 Stop tools and remove all run state
  /help                    Show this help${C.reset}
`);
}

// ─── Input handling ──────────────────────────────────────────────────────────

async function handleInput(input) {
  const parsed = parseInput(input);

  switch (parsed.type) {
    case 'empty': return;
    case 'help': return printBanner();
    case 'quit':
      stopPolling();
      console.log(`${C.dim}Stopping tools...${C.reset}`);
      await sendKeys(PANES.claude, '/exit');
      await sendKeys(PANES.codex, '/exit');
      updateRunJson({ status: 'stopped', updated_at: new Date().toISOString() });
      console.log(`${C.dim}Run state preserved — use 'duet resume' to continue.${C.reset}`);
      setTimeout(async () => {
        await killSession(SESSION);
        process.exit(0);
      }, 3000);
      return;
    case 'detach':
      console.log(`${C.dim}Detaching — tools will keep running. Reattach with 'duet'.${C.reset}`);
      if (!await detachClient(SESSION)) {
        console.log(`${C.red}Failed to detach${C.reset}`);
      }
      return;
    case 'destroy':
      stopPolling();
      console.log(`${C.dim}Destroying run — stopping tools and removing state...${C.reset}`);
      await sendKeys(PANES.claude, '/exit');
      await sendKeys(PANES.codex, '/exit');
      setTimeout(async () => {
        const DUET_RUN_DIR = process.env.DUET_RUN_DIR || null;
        if (DUET_RUN_DIR) { try { rmSync(DUET_RUN_DIR, { recursive: true, force: true }); } catch {} }
        await killSession(SESSION);
        process.exit(0);
      }, 3000);
      return;
    case 'clear':
      process.stdout.write('\x1b[2J\x1b[H');
      return;
    case 'watch': {
      startPolling();
      console.log(`${C.cyan}Watching for @mentions — tools can now talk to each other${C.reset}`);
      for (const tool of ['claude', 'codex']) {
        const bs = bindingStatus(tool);
        const color = tool === 'claude' ? C.magenta : C.green;
        if (bs === 'bound' && watcherFailed.has(tool)) {
          console.log(`  ${color}${tool}${C.reset}: ${C.red}inactive${C.reset} (watcher failed — /rebind ${tool})`);
        } else if (bs === 'bound') {
          console.log(`  ${color}${tool}${C.reset}: ${C.green}active${C.reset} (session-bound)`);
        } else if (bs === 'pending') {
          console.log(`  ${color}${tool}${C.reset}: ${C.yellow}waiting${C.reset} (binding pending)`);
        } else {
          console.log(`  ${color}${tool}${C.reset}: ${C.red}unavailable${C.reset} (binding degraded)`);
        }
      }
      return;
    }
    case 'stop':
      if (isWatching()) {
        stopPolling();
        console.log(`${C.dim}Stopped watching${C.reset}`);
      } else {
        console.log(`${C.dim}Nothing running${C.reset}`);
      }
      return;
    case 'status': {
      if (converseState) {
        console.log(`${C.cyan}Converse:${C.reset} "${converseState.topic}" — round ${converseState.rounds}/${converseState.maxRounds}, waiting on ${converseState.turn}`);
      } else if (isWatching()) {
        console.log(`${C.cyan}Watching${C.reset} for @mentions`);
      } else {
        console.log(`${C.dim}Idle — not watching${C.reset}`);
      }
      for (const tool of ['claude', 'codex']) {
        const st = sessionState[tool];
        const bs = bindingStatus(tool);
        const color = tool === 'claude' ? C.magenta : C.green;
        const pad = tool === 'claude' ? '' : ' ';
        const level = st.bindingLevel ? ` (${st.bindingLevel})` : '';
        const watching = fileWatchers[tool] ? ', watching' : pendingTools.has(tool) ? ', polling binding' : watcherFailed.has(tool) ? ', watcher failed' : '';
        const bsColor = (bs === 'bound' && !watcherFailed.has(tool)) ? C.green : bs === 'pending' ? C.yellow : C.red;
        const autoLabel = (bs === 'bound' && !watcherFailed.has(tool)) ? 'active' : bs === 'pending' ? 'waiting' : (bs === 'bound' && watcherFailed.has(tool)) ? 'inactive' : 'unavailable';
        console.log(`  ${color}${tool}${C.reset}${pad} binding: ${bsColor}${bs}${level}${C.reset}  automation: ${bsColor}${autoLabel}${watching}${C.reset}`);
      }
      return;
    }
    case 'debug': {
      const runJson = readRunJson();
      const bindings = loadBindings();
      const paneCaptures = parsed.full ? {
        claude: PANES.claude ? await capturePane(PANES.claude, 30) : null,
        codex: PANES.codex ? await capturePane(PANES.codex, 30) : null,
      } : null;
      const snapshot = collectDebugSnapshot({
        sessionState,
        routerState: getRouterState(),
        bindings,
        runJson,
        paneCaptures,
        full: parsed.full,
      });
      console.log(renderDebugReport(snapshot));
      return;
    }
    case 'send-debug': {
      const runJson = readRunJson();
      const bindings = loadBindings();
      const snapshot = collectDebugSnapshot({
        sessionState,
        routerState: getRouterState(),
        bindings,
        runJson,
        full: false,
      });
      const report = renderDebugReport(snapshot);
      const header = 'The operator is sending you a live debug snapshot of the current Duet session. Please review it and help diagnose any issues.';
      const noteBlock = parsed.note ? `\nOperator note: ${parsed.note}\n` : '';
      const msg = `${header}${noteBlock}\n${report}`;
      if (!PANES[parsed.target]) {
        console.log(`${C.red}No pane configured for ${parsed.target}${C.reset}`);
        return;
      }
      if (await pasteToPane(PANES[parsed.target], msg)) {
        console.log(`${C.blue}Debug snapshot sent to ${parsed.target}${C.reset}`);
      } else {
        console.log(`${C.red}Failed to send debug snapshot to ${parsed.target}${C.reset}`);
      }
      return;
    }
    case 'send-debug-error':
      console.log(`Usage: /send-debug claude|codex [optional note]`);
      return;
    case 'rebind': {
      if (parsed.target !== 'claude' && parsed.target !== 'codex') {
        console.log(`${C.red}Usage: /rebind claude|codex${C.reset}`);
        return;
      }
      const tool = parsed.target;
      const candidate = findRebindCandidate(tool);
      if (!candidate) {
        console.log(`${C.red}No rebind candidate found for ${tool} — current binding unchanged${C.reset}`);
        return;
      }
      const { oldPath, newPath, newSid } = await rebindTool(tool, candidate);
      console.log(`${C.green}Rebound ${tool}:${C.reset}`);
      console.log(`  ${C.dim}old: ${oldPath}${C.reset}`);
      console.log(`  ${C.green}new: ${newPath}${C.reset}`);
      if (newSid) console.log(`  ${C.green}session: ${newSid}${C.reset}`);
      return;
    }
    case 'converse': {
      // Resolve latest binding state
      for (const t of ['claude', 'codex']) resolveSessionPath(t);
      const cbs = bindingStatus('claude');
      const xbs = bindingStatus('codex');
      if (cbs !== 'bound' || xbs !== 'bound') {
        console.log(`${C.red}Cannot start conversation — both tools must be session-bound${C.reset}`);
        if (cbs !== 'bound') console.log(`  ${C.magenta}claude${C.reset}: ${C.red}${cbs}${C.reset}`);
        if (xbs !== 'bound') console.log(`  ${C.green}codex${C.reset}:  ${C.red}${xbs}${C.reset}`);
        return;
      }
      startPolling();
      console.log(`${C.cyan}Starting conversation: "${parsed.topic}" (${parsed.maxRounds} rounds)${C.reset}`);
      const opener = `Let's discuss with @codex: ${parsed.topic}`;
      if (await pasteToPane(PANES.claude, opener)) {
        converseState = {
          turn: 'claude',
          rounds: 0,
          maxRounds: parsed.maxRounds,
          topic: parsed.topic,
        };
      } else {
        console.log(`${C.red}Failed to deliver opener to claude — conversation not started${C.reset}`);
      }
      return;
    }
    case 'focus':
      if (PANES[parsed.target]) {
        await focusPane(PANES[parsed.target]);
        console.log(`${C.dim}Focused ${parsed.target}. Click the bottom pane or Ctrl-B ; to return.${C.reset}`);
      } else {
        console.log(`${C.red}Unknown target. Use: claude, codex${C.reset}`);
      }
      return;
    case 'snap':
      if (PANES[parsed.target]) {
        const output = await capturePane(PANES[parsed.target], parsed.lines);
        console.log(`${C.yellow}-- ${parsed.target} (last ${parsed.lines} lines) --${C.reset}`);
        console.log(output);
        console.log(`${C.yellow}-- end --${C.reset}`);
      } else {
        console.log(`${C.red}Unknown target. Use: claude, codex${C.reset}`);
      }
      return;
    case 'relay': {
      const fromBs = bindingStatus(parsed.from);
      if (fromBs !== 'bound') {
        console.log(`${C.red}Cannot relay — ${parsed.from} is not session-bound (${fromBs})${C.reset}`);
        return;
      }
      const response = getSessionResponse(parsed.from);
      if (!response) {
        console.log(`${C.red}No structured response available from ${parsed.from} — nothing to relay${C.reset}`);
        return;
      }
      const msg = parsed.prompt
        ? `${parsed.prompt.trim()}\n\n${parsed.from} says:\n${response}`
        : `${parsed.from} says:\n${response}`;
      if (await pasteToPane(PANES[parsed.to], msg)) {
        console.log(`${C.blue}Relayed ${parsed.from} -> ${parsed.to}${C.reset}`);
      } else {
        console.log(`${C.red}Failed to relay to ${parsed.to}${C.reset}`);
      }
      return;
    }
    case 'relay_error':
      console.log(`Usage: @relay claude>codex [optional prompt]`);
      return;
    case 'both': {
      const [cOk, xOk] = await Promise.all([
        sendKeys(PANES.claude, parsed.msg),
        sendKeys(PANES.codex, parsed.msg),
      ]);
      if (cOk && xOk) {
        console.log(`${C.yellow}-> both${C.reset}`);
      } else {
        const failed = [!cOk && 'claude', !xOk && 'codex'].filter(Boolean).join(', ');
        console.log(`${C.red}Failed to send to ${failed}${C.reset}`);
      }
      return;
    }
    case 'claude':
      if (await sendKeys(PANES.claude, parsed.msg)) {
        console.log(`${C.magenta}-> claude${C.reset}`);
      } else {
        console.log(`${C.red}Failed to send to claude${C.reset}`);
      }
      return;
    case 'codex':
      if (await sendKeys(PANES.codex, parsed.msg)) {
        console.log(`${C.green}-> codex${C.reset}`);
      } else {
        console.log(`${C.red}Failed to send to codex${C.reset}`);
      }
      return;
    case 'unknown_command':
      console.log(`${C.dim}Unknown command. /help for usage.${C.reset}`);
      return;
    case 'no_target':
      console.log(`${C.dim}Prefix with @claude, @codex, or @both. /help for commands.${C.reset}`);
      return;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] &&
  (process.argv[1].endsWith('router.mjs') || process.argv[1].endsWith('router'));

if (isMain) {
  const DUET_MODE = process.env.DUET_MODE || 'new';

  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}${C.bold}duet>${C.reset} `,
    historySize: 200,
  });

  printBanner();

  if (DUET_MODE === 'resumed') {
    console.log(`${C.green}Resumed session — reader initialized at EOF to skip history${C.reset}`);
  } else if (DUET_MODE === 'forked') {
    console.log(`${C.green}Forked session${C.reset}`);
  }

  startPolling();

  for (const tool of ['claude', 'codex']) {
    const bs = bindingStatus(tool);
    const st = sessionState[tool];
    const level = st.bindingLevel ? ` [${st.bindingLevel}]` : '';
    if (bs === 'bound' && watcherFailed.has(tool)) {
      console.log(`${C.red}${tool}: session-bound but watcher failed — automation inactive${C.reset}`);
    } else if (bs === 'bound') {
      console.log(`${C.green}${tool}: session-bound — automation active${level}${C.reset}`);
    } else if (bs === 'pending') {
      console.log(`${C.yellow}${tool}: binding pending — automation will start when bound${C.reset}`);
    } else {
      console.log(`${C.red}${tool}: binding degraded — automation unavailable${C.reset}`);
    }
  }
  console.log(`${C.cyan}Watching for @mentions — tools can talk to each other${C.reset}\n`);

  rl.prompt();

  rl.on('line', (line) => {
    handleInput(line.trim()).then(() => rl.prompt());
  });

  rl.on('close', () => {
    stopPolling();
    process.exit(0);
  });
}

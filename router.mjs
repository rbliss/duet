import { createInterface } from 'readline';
import { writeFileSync, readFileSync, rmSync, statSync, readdirSync, watch } from 'fs';
import { join } from 'path';

// ─── Module imports ──────────────────────────────────────────────────────────

import { setRunDir, updateRunJson } from './src/runtime/run-store.mjs';
import { STATE_DIR, setStateDir, loadBindings } from './src/runtime/bindings-store.mjs';
import {
  sessionState, resolveSessionPath, readIncremental,
  extractClaudeResponse, extractCodexResponse, isResponseComplete,
  getClaudeLastResponse, getCodexLastResponse, getLastResponse,
  setDuetMode,
} from './src/relay/session-reader.mjs';
import {
  shellEscape, sendKeys, pasteToPane, capturePane, focusPane,
  killSession, detachClient,
} from './src/transport/tmux-client.mjs';

// ─── Re-exports for test backward compatibility ──────────────────────────────

export { shellEscape, sendKeys, pasteToPane, capturePane, focusPane } from './src/transport/tmux-client.mjs';
export { setRunDir, updateRunJson } from './src/runtime/run-store.mjs';
export { STATE_DIR, setStateDir } from './src/runtime/bindings-store.mjs';
export {
  sessionState, resolveSessionPath, readIncremental,
  extractClaudeResponse, extractCodexResponse, isResponseComplete,
  getClaudeLastResponse, getCodexLastResponse, getLastResponse,
  setDuetMode,
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

const PANE_POLL_MS = 1000;
const PANE_STABLE_TICKS = 2;
const SESSION_DEBOUNCE_MS = 800;
const SESSION_COMPLETE_MS = 200;
const RELAY_COOLDOWN_MS = 8000;
const STALE_BINDING_MS = 5000;

let rl = null;
let watchInterval = null;
export const lastAutoRelayTime = {};
let converseState = null;

const watchState = {
  claude: { baseline: '', lastSeen: '', unchangedCount: 0 },
  codex:  { baseline: '', lastSeen: '', unchangedCount: 0 },
};

const fileWatchers = {};
const fileDebounceTimers = {};
let panePolledTools = new Set();

export function isWatching() { return watchInterval !== null; }

function prompt() { if (rl) rl.prompt(); }

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
      panePolledTools.add(tool);
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
  // Sync pane baseline to prevent duplicate relay on fallback to pane polling
  if (PANES[tool]) {
    try {
      const cap = (await capturePane(PANES[tool], 80)).trim();
      watchState[tool] = { baseline: cap, lastSeen: cap, unchangedCount: 0 };
    } catch {}
  }
}

// ─── Polling start / stop ────────────────────────────────────────────────────

let pollTimer = null;

async function initBaselines() {
  for (const name of ['claude', 'codex']) {
    if (PANES[name]) {
      const cap = (await capturePane(PANES[name], 80)).trim();
      watchState[name] = { baseline: cap, lastSeen: cap, unchangedCount: 0 };
    }
  }
}

function schedulePoll() {
  if (!watchInterval) return;
  pollTimer = setTimeout(async () => {
    await pollPanes();
    schedulePoll();
  }, PANE_POLL_MS);
}

async function startPolling() {
  if (watchInterval) return;
  panePolledTools = new Set();
  for (const name of ['claude', 'codex']) {
    resolveSessionPath(name);
    const st = sessionState[name];
    if (st.relayMode === 'session' && st.path && startFileWatcher(name)) {
      // event-driven relay via session log
    } else {
      panePolledTools.add(name);
    }
  }
  // Initialize pane baseline before first poll (sentinel for stale detection)
  await initBaselines();
  watchInterval = true; // flag: polling is active
  schedulePoll();
}

function stopPolling() {
  watchInterval = null;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  converseState = null;
  stopFileWatchers();
  panePolledTools = new Set();
}

// Downgrade a tool from session-bound to pane relay (e.g. stale binding)
export function downgradeToPane(tool, reason) {
  stopFileWatcher(tool);
  const st = sessionState[tool];
  st.relayMode = 'pane';
  st.staleDowngraded = true;
  panePolledTools.add(tool);
  console.log(`\n${C.yellow}${tool}: ${reason} — falling back to pane relay${C.reset}`);
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

  const match = newPath.match(/([0-9a-f-]{36})\.jsonl$/i);
  const newSid = match ? match[1] : null;

  if (startFileWatcher(tool)) {
    panePolledTools.delete(tool);
  }

  if (PANES[tool]) {
    try {
      const cap = (await capturePane(PANES[tool], 80)).trim();
      watchState[tool] = { baseline: cap, lastSeen: cap, unchangedCount: 0 };
    } catch {}
  }

  const updates = { [`${tool}.binding_path`]: newPath, updated_at: new Date().toISOString() };
  if (newSid) updates[`${tool}.session_id`] = newSid;
  updateRunJson(updates);

  return { oldPath, newPath, newSid };
}

async function pollPanes() {
  // Dynamic upgrade: check if any pending tools have resolved to session-bound
  for (const name of [...panePolledTools]) {
    if (sessionState[name].relayMode === 'pending') {
      resolveSessionPath(name);
      if (sessionState[name].relayMode === 'session' && sessionState[name].path) {
        if (startFileWatcher(name)) {
          panePolledTools.delete(name);
          console.log(`\n${C.green}${name}: upgraded to session log watcher${C.reset}`);
          prompt();
        }
      } else if (sessionState[name].relayMode === 'pane') {
        console.log(`\n${C.yellow}${name}: binding timed out — using pane relay${C.reset}`);
        prompt();
      }
    }
  }

  // Stale-binding sentinel: poll Claude pane to detect binding divergence.
  for (const name of ['claude']) {
    if (!fileWatchers[name] || !PANES[name]) continue;
    const state = watchState[name];
    if (!state) continue;
    const current = (await capturePane(PANES[name], 80)).trim();

    if (current === state.lastSeen) {
      state.unchangedCount++;
      if (state.unchangedCount === PANE_STABLE_TICKS && current !== state.baseline) {
        const paneNew = getNewContent(state.baseline, current);
        state.baseline = current;
        state.unchangedCount = 0;
        if (paneNew) {
          const st = sessionState[name];
          const sessionCold = Date.now() - st.lastSessionActivityAt > STALE_BINDING_MS;
          if (sessionCold) {
            try {
              const { mtimeMs } = statSync(st.path);
              if (Date.now() - mtimeMs <= STALE_BINDING_MS) continue;
            } catch {}
            downgradeToPane(name, 'session binding appears stale (possible manual /resume)');
            await handleNewOutput(name, paneNew);
          }
        }
      }
    } else {
      state.lastSeen = current;
      state.unchangedCount = 0;
    }
  }

  for (const name of panePolledTools) {
    const state = watchState[name];
    const current = (await capturePane(PANES[name], 80)).trim();

    if (current === state.lastSeen) {
      state.unchangedCount++;

      if (state.unchangedCount === PANE_STABLE_TICKS && current !== state.baseline) {
        const newContent = getNewContent(state.baseline, current);
        state.baseline = current;
        state.unchangedCount = 0;

        if (newContent) await handleNewOutput(name, newContent);
      }
    } else {
      state.lastSeen = current;
      state.unchangedCount = 0;
    }
  }
}

// Returns { text, via } where via is 'session' or 'pane'.
function getCleanResponse(source, fallbackContent) {
  const logResponse = getLastResponse(source);
  if (logResponse && logResponse.length > 10) return { text: logResponse, via: 'session' };
  const text = cleanCapture(fallbackContent) || fallbackContent;
  return { text, via: 'pane' };
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
    lastAutoRelayTime[direction] = now;
    const { text: response, via } = getCleanResponse(source, newContent);
    console.log(`\n${C.blue}[converse|${via}] round ${converseState.rounds}/${converseState.maxRounds}: ${source} -> ${other}${C.reset}`);
    const msg = `${source} says (round ${converseState.rounds} on "${converseState.topic}"):\n${response}`;
    await pasteToPane(PANES[other], msg);
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
    lastAutoRelayTime[direction] = now;
    const { text: response, via } = getCleanResponse(source, newContent);
    console.log(`\n${C.blue}[auto|${via}] ${source} mentioned @${other} — relaying${C.reset}`);
    const msg = `${source} says:\n${response}`;
    await pasteToPane(PANES[other], msg);
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

  ${C.dim}/focus claude|codex      Switch to pane (click router pane to return)
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
    case 'watch':
      await startPolling();
      console.log(`${C.cyan}Watching for @mentions — tools can now talk to each other${C.reset}`);
      console.log(`${C.dim}Either tool can include @claude or @codex in its output to trigger a relay.${C.reset}`);
      return;
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
      const modeColor = (m) => m === 'session' ? C.green : m === 'pane' ? C.yellow : C.dim;
      for (const tool of ['claude', 'codex']) {
        const st = sessionState[tool];
        const color = tool === 'claude' ? C.magenta : C.green;
        const pad = tool === 'claude' ? '' : ' ';
        const level = st.bindingLevel ? ` (${st.bindingLevel})` : '';
        const transport = fileWatchers[tool] ? ', event-driven' : panePolledTools.has(tool) ? ', polling' : '';
        const staleNote = st.staleDowngraded ? ` ${C.red}(stale session binding; possible manual /resume)${C.reset}` : '';
        console.log(`  ${color}${tool}${C.reset}${pad} relay: ${modeColor(st.relayMode)}${st.relayMode}${level}${transport}${C.reset}${staleNote}`);
      }
      return;
    }
    case 'rebind': {
      if (parsed.target !== 'claude' && parsed.target !== 'codex') {
        console.log(`${C.red}Usage: /rebind claude|codex${C.reset}`);
        return;
      }
      const tool = parsed.target;
      const candidate = findRebindCandidate(tool);
      if (!candidate) {
        console.log(`${C.red}No rebind candidate found for ${tool} — staying on pane relay${C.reset}`);
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
      await startPolling();
      converseState = {
        turn: 'claude',
        rounds: 0,
        maxRounds: parsed.maxRounds,
        topic: parsed.topic,
      };
      console.log(`${C.cyan}Starting conversation: "${parsed.topic}" (${parsed.maxRounds} rounds)${C.reset}`);
      const opener = `Let's discuss with @codex: ${parsed.topic}`;
      await pasteToPane(PANES.claude, opener);
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
      const raw = (await capturePane(PANES[parsed.from], 80)).trim();
      const { text: response, via } = getCleanResponse(parsed.from, raw);
      if (!response) {
        console.log(`${C.red}Nothing captured from ${parsed.from}${C.reset}`);
        return;
      }
      const msg = parsed.prompt
        ? `${parsed.prompt.trim()}\n\n${parsed.from} says:\n${response}`
        : `${parsed.from} says:\n${response}`;
      await pasteToPane(PANES[parsed.to], msg);
      console.log(`${C.blue}Relayed ${parsed.from} -> ${parsed.to} [${via}]${C.reset}`);
      return;
    }
    case 'relay_error':
      console.log(`Usage: @relay claude>codex [optional prompt]`);
      return;
    case 'both':
      await sendKeys(PANES.claude, parsed.msg);
      await sendKeys(PANES.codex, parsed.msg);
      console.log(`${C.yellow}-> both${C.reset}`);
      return;
    case 'claude':
      await sendKeys(PANES.claude, parsed.msg);
      console.log(`${C.magenta}-> claude${C.reset}`);
      return;
    case 'codex':
      await sendKeys(PANES.codex, parsed.msg);
      console.log(`${C.green}-> codex${C.reset}`);
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

  startPolling().then(() => {
    for (const tool of ['claude', 'codex']) {
      const st = sessionState[tool];
      if (st.relayMode === 'session') {
        const level = st.bindingLevel ? ` [${st.bindingLevel}]` : '';
        const transport = fileWatchers[tool] ? ' (event-driven)' : '';
        console.log(`${C.green}${tool}: session-bound relay active${level}${transport}${C.reset}`);
      } else if (st.relayMode === 'pending') {
        console.log(`${C.yellow}${tool}: binding pending — will upgrade when available${C.reset}`);
      } else {
        console.log(`${C.yellow}${tool}: pane-capture relay (binding failed)${C.reset}`);
      }
    }
    console.log(`${C.cyan}Watching for @mentions — tools can talk to each other${C.reset}\n`);

    rl.prompt();
  });

  rl.on('line', (line) => {
    handleInput(line.trim()).then(() => rl.prompt());
  });

  rl.on('close', () => {
    stopPolling();
    process.exit(0);
  });
}

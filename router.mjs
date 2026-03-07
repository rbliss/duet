import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync, rmSync, watch } from 'fs';
import { join } from 'path';

const SESSION = process.env.DUET_SESSION || 'duet';
const CLAUDE_PANE = process.env.CLAUDE_PANE;
const CODEX_PANE = process.env.CODEX_PANE;
export let STATE_DIR = process.env.DUET_STATE_DIR || null;
let DUET_MODE = process.env.DUET_MODE || 'new';   // 'new' | 'resumed' | 'forked'
let DUET_RUN_DIR = process.env.DUET_RUN_DIR || null;

export function setStateDir(dir) { STATE_DIR = dir; bindingsCache = null; }
export function setDuetMode(mode) { DUET_MODE = mode; }
export function setRunDir(dir) { DUET_RUN_DIR = dir; }

const PANES = { claude: CLAUDE_PANE, codex: CODEX_PANE };

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m',
  bg: '\x1b[48;5;236m',
};

// ─── Core tmux functions ─────────────────────────────────────────────────────

export function shellEscape(text) {
  return "'" + text.replace(/'/g, "'\"'\"'") + "'";
}

export function sendKeys(pane, text) {
  try {
    execSync(`tmux send-keys -t ${shellEscape(pane)} -l ${shellEscape(text)}`);
    // Small delay so TUI apps (Codex/Ink) can process the input before Enter
    execSync('sleep 0.15');
    execSync(`tmux send-keys -t ${shellEscape(pane)} Enter`);
    return true;
  } catch {
    console.log(`${C.red}Failed to send${C.reset}`);
    return false;
  }
}

export function pasteToPane(pane, text) {
  const tmp = `/tmp/duet-paste-${Date.now()}.txt`;
  try {
    writeFileSync(tmp, text);
    execSync(`tmux load-buffer -b duet ${shellEscape(tmp)}`);
    execSync(`tmux paste-buffer -p -b duet -t ${shellEscape(pane)}`);
    // Wait for TUI to process the pasted content before submitting
    execSync('sleep 0.5');
    execSync(`tmux send-keys -t ${shellEscape(pane)} Enter`);
    return true;
  } catch {
    console.log(`${C.red}Paste failed${C.reset}`);
    return false;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

export function capturePane(pane, lines = 50) {
  try {
    return execSync(
      `tmux capture-pane -t ${shellEscape(pane)} -p -S -${lines}`,
      { encoding: 'utf8' }
    );
  } catch {
    return '';
  }
}

export function focusPane(pane) {
  try {
    execSync(`tmux select-pane -t ${shellEscape(pane)}`);
    return true;
  } catch {
    return false;
  }
}

// ─── Session log readers (clean text from tool logs) ─────────────────────────
//
// Session ownership model:
//   - Claude: launcher generates a UUID, passes --session-id, polls until the
//     exact UUID-named .jsonl appears on disk. Process-level ownership.
//   - Codex: launcher sets CODEX_HOME to a run-scoped overlay that isolates
//     session storage while reusing auth/config (read-only). Process-level if
//     CODEX_HOME works; degrades to workspace-level if it doesn't.
//     Only read-only config is shared — mutable SQLite state is NOT symlinked.
//
// Binding is an eventually-consistent runtime property. bind-sessions.sh runs
// as a background reconciler that keeps polling and incrementally updates
// bindings.json. The router re-reads the manifest while any tool is pending
// and upgrades transport when status flips to "bound" or "degraded".
//
// The STATE_DIR lifetime is tied to the Duet session (not the bootstrap shell).
// It persists until /quit cleans it up or a new Duet session replaces it.
//
// Each session is read incrementally via a byte-offset cursor. On each call
// we read only new bytes appended since the last read, parse complete JSONL
// lines, and update a cached lastResponse. This means:
//   - Relay always returns the latest complete assistant message
//   - Read cost is proportional to new output, not total file size
//   - No risk of a fixed tail window cutting into a long response

// relayMode tracks durable binding state per tool:
//   'pending'  — binder is still looking for session file
//   'session'  — authoritative session binding exists
//   'pane'     — binding degraded or unavailable
// This is never downgraded by transient relay fallbacks.
// Per-relay transport ('session' or 'pane') is returned by getCleanResponse().
//
// bindingLevel describes the ownership guarantee:
//   'process'   — bound to exact launched process (both Claude and Codex)
//   null        — not yet bound
export const sessionState = {
  claude: { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null },
  codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null },
};

// ─── Binding resolution ─────────────────────────────────────────────────────
//
// The router is a pure manifest consumer. bind-sessions.sh owns discovery and
// writes bindings.json with status transitions:
//   pending  → tool launched, session file not yet found
//   bound    → session file discovered, path confirmed
//   degraded → binding deadline expired, file never appeared
//
// The router re-reads the manifest while any tool is still "pending" and
// upgrades transport (pane → session file watcher) when status flips to "bound".

// ─── Run manifest (run.json) updates ──────────────────────────────────────────

export function updateRunJson(updates) {
  const runDir = DUET_RUN_DIR;
  if (!runDir) return;
  const path = join(runDir, 'run.json');
  try {
    let data = {};
    if (existsSync(path)) {
      data = JSON.parse(readFileSync(path, 'utf8'));
    }
    for (const [key, value] of Object.entries(updates)) {
      if (key.includes('.')) {
        const [parent, child] = key.split('.', 2);
        if (!data[parent] || typeof data[parent] !== 'object') data[parent] = {};
        data[parent][child] = value;
      } else {
        data[key] = value;
      }
    }
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch {}
}

// Cache for the parsed bindings.json manifest
let bindingsCache = null;

function loadBindings() {
  if (bindingsCache !== null) {
    // Re-read if any tool is still pending (binder may have updated it)
    const hasPending = ['claude', 'codex'].some(t =>
      bindingsCache[t]?.status === 'pending');
    if (!hasPending) return bindingsCache;
    bindingsCache = null;
  }
  if (!STATE_DIR) return null;
  const manifestPath = join(STATE_DIR, 'bindings.json');
  try {
    if (existsSync(manifestPath)) {
      bindingsCache = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return bindingsCache;
    }
  } catch {}
  return null;
}

export function resolveSessionPath(tool) {
  const st = sessionState[tool];
  if (st.resolved) return st.path;
  if (!STATE_DIR) {
    st.relayMode = 'pane';
    return null;
  }
  const bindings = loadBindings();
  if (bindings && bindings[tool]) {
    const b = bindings[tool];
    if (b.status === 'bound' && b.path) {
      st.path = b.path;
      st.resolved = true;
      st.relayMode = 'session';
      st.bindingLevel = b.level || null;

      // On resume, seek reader to end of file to avoid replaying history
      if (DUET_MODE === 'resumed' && st.path) {
        try {
          const { size } = statSync(st.path);
          st.offset = size;
        } catch {}
      }

      // Propagate binding info to run.json
      const updates = { [`${tool}.binding_path`]: b.path, updated_at: new Date().toISOString() };
      if (b.session_id) updates[`${tool}.session_id`] = b.session_id;
      updateRunJson(updates);

      return st.path;
    }
    if (b.status === 'degraded') {
      // Binder gave up — terminal state
      st.resolved = true;
      st.relayMode = 'pane';
      return null;
    }
    // status === 'pending' — binder is still looking
    st.relayMode = 'pending';
    return null;
  }
  // No manifest yet — genuinely pending
  st.relayMode = 'pending';
  return null;
}

export function readIncremental(tool) {
  const st = sessionState[tool];
  const filePath = resolveSessionPath(tool);
  if (!filePath) return { hasNew: false, complete: false };
  let hasNew = false;
  let complete = false;
  try {
    const { size } = statSync(filePath);
    if (size <= st.offset) return { hasNew: false, complete: false };
    const fd = openSync(filePath, 'r');
    try {
      const len = size - st.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.offset);
      const chunk = buf.toString('utf8');
      // Only process complete lines; save any trailing partial line for next read
      const lastNl = chunk.lastIndexOf('\n');
      if (lastNl < 0) return { hasNew: false, complete: false };
      const completeText = chunk.slice(0, lastNl);
      st.offset += lastNl + 1; // advance past the newline
      // Parse lines and update cached response
      const lines = completeText.split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const extracted = tool === 'claude'
            ? extractClaudeResponse(obj)
            : extractCodexResponse(obj);
          if (extracted) { st.lastResponse = extracted; hasNew = true; }
          if (isResponseComplete(tool, obj)) complete = true;
        } catch {}
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
  return { hasNew, complete };
}

export function extractClaudeResponse(obj) {
  const msg = obj.message;
  if (msg?.role !== 'assistant') return null;
  const texts = [];
  for (const block of msg.content || []) {
    if (block.type === 'text' && block.text) texts.push(block.text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

export function extractCodexResponse(obj) {
  if (obj.payload?.type === 'task_complete' && obj.payload.last_agent_message) {
    return obj.payload.last_agent_message;
  }
  if (obj.type === 'event_msg' && obj.payload?.type === 'message' && obj.payload.role === 'assistant') {
    const texts = [];
    for (const block of obj.payload.content || []) {
      if (block.type === 'output_text' && block.text) texts.push(block.text);
      if (block.type === 'text' && block.text) texts.push(block.text);
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

// Detect JSONL entries that signal the tool has finished its response.
// Used by file watchers to trigger immediate relay instead of waiting for debounce.
export function isResponseComplete(tool, obj) {
  if (tool === 'claude') {
    if (obj.type === 'result') return true;
    if (obj.message?.role === 'assistant' && obj.message?.stop_reason === 'end_turn') return true;
  }
  if (tool === 'codex') {
    if (obj.payload?.type === 'task_complete') return true;
  }
  return false;
}

export function getClaudeLastResponse() {
  readIncremental('claude');
  return sessionState.claude.lastResponse;
}

export function getCodexLastResponse() {
  readIncremental('codex');
  return sessionState.codex.lastResponse;
}

export function getLastResponse(tool) {
  return tool === 'claude' ? getClaudeLastResponse() : getCodexLastResponse();
}

// ─── Watch & converse helpers ────────────────────────────────────────────────

export function getNewContent(baseline, current) {
  if (!baseline) return current;
  if (baseline === current) return '';

  const baseLines = baseline.split('\n');
  const currLines = current.split('\n');

  // Prefix/suffix matching: find shared header and footer between captures.
  // New content is the inserted middle region. This handles TUIs (like Claude
  // Code) that insert assistant output above a preserved prompt/footer block.
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

  // Fallback: line-level set diff for complete screen replacement / scroll
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

// Strip TUI chrome (box-drawing, status bars, spinners) from captured pane output
const BOX_CHARS = /[─│╭╮╰╯┌┐└┘├┤┬┴┼╔╗╚╝║═▔▁█▓▒░]/g;
const SPINNER = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷]\s*/;

export function cleanCapture(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // Drop lines that are mostly box-drawing / borders
      const withoutBox = trimmed.replace(BOX_CHARS, '').trim();
      if (withoutBox.length < 3) return false;
      // Drop spinner / thinking lines
      if (SPINNER.test(trimmed)) return false;
      // Drop status bar hints
      if (/^[⏎↩]?\s*(to send|to interrupt|\/help|\/compact|ESC to|Ctrl[+-])/i.test(trimmed)) return false;
      // Drop tool header/identity lines
      if (/^(Claude Code|Codex)\s*(v[\d.]|$)/i.test(trimmed)) return false;
      // Drop pure prompt lines ($ or >)
      if (/^[$>]\s*$/.test(trimmed)) return false;
      return true;
    })
    // Strip leading/trailing box chars from content lines
    .map(line => line.replace(/^[\s│║▏]+/, '').replace(/[\s│║▕]+$/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// ─── Watch / converse state ──────────────────────────────────────────────────
//
// Two relay paths, selected per-tool based on session binding:
//   1. Session-bound: fs.watch() on the session log file. On new JSONL content,
//      debounce briefly (200ms if completion signal detected, 800ms otherwise).
//      Latency: <1s vs the old ~6s.
//   2. Pane-only: poll tmux capture-pane at 1s intervals, 2 stable ticks (~2s).
//      Latency: ~2s vs the old ~6s.
// Tools that start as 'pending' are polled via pane and auto-upgraded to file
// watching once their binding resolves.

const PANE_POLL_MS = 1000;
const PANE_STABLE_TICKS = 2;        // 2 unchanged polls (~2s) = pane output done
const SESSION_DEBOUNCE_MS = 800;    // debounce after session log change
const SESSION_COMPLETE_MS = 200;    // shorter debounce when completion signal detected
const RELAY_COOLDOWN_MS = 8000;     // prevent rapid-fire auto-relays (watch mode only)

let rl = null; // set when running as main
let watchInterval = null;
// Per-direction cooldown: keyed by "source->target" (e.g. "claude->codex")
// so a reply in the opposite direction isn't suppressed.
export const lastAutoRelayTime = {};
let converseState = null;       // null | { turn, rounds, maxRounds, topic }

const watchState = {
  claude: { baseline: '', lastSeen: '', unchangedCount: 0 },
  codex:  { baseline: '', lastSeen: '', unchangedCount: 0 },
};

// File watcher state (session-bound tools use fs.watch for event-driven relay)
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

function stopFileWatchers() {
  for (const tool of Object.keys(fileWatchers)) stopFileWatcher(tool);
}

function onFileChange(tool) {
  if (!watchInterval) return; // not in watch/converse mode
  const { hasNew, complete } = readIncremental(tool);
  if (!hasNew) return;
  if (fileDebounceTimers[tool]) clearTimeout(fileDebounceTimers[tool]);
  const delay = complete ? SESSION_COMPLETE_MS : SESSION_DEBOUNCE_MS;
  fileDebounceTimers[tool] = setTimeout(() => triggerSessionRelay(tool), delay);
}

function triggerSessionRelay(tool) {
  const st = sessionState[tool];
  if (!st.lastResponse) return;
  handleNewOutput(tool, st.lastResponse);
  // Sync pane baseline to prevent duplicate relay on fallback to pane polling
  if (PANES[tool]) {
    try {
      const cap = capturePane(PANES[tool], 80).trim();
      watchState[tool] = { baseline: cap, lastSeen: cap, unchangedCount: 0 };
    } catch {}
  }
}

// ─── Polling start / stop ────────────────────────────────────────────────────

function startPolling() {
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
  for (const name of panePolledTools) {
    const cap = capturePane(PANES[name], 80).trim();
    watchState[name] = { baseline: cap, lastSeen: cap, unchangedCount: 0 };
  }
  watchInterval = setInterval(pollPanes, PANE_POLL_MS);
}

function stopPolling() {
  if (watchInterval) clearInterval(watchInterval);
  watchInterval = null;
  converseState = null;
  stopFileWatchers();
  panePolledTools = new Set();
}

function pollPanes() {
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
  for (const name of panePolledTools) {
    const state = watchState[name];
    const current = capturePane(PANES[name], 80).trim();

    if (current === state.lastSeen) {
      state.unchangedCount++;

      if (state.unchangedCount === PANE_STABLE_TICKS && current !== state.baseline) {
        const newContent = getNewContent(state.baseline, current);
        state.baseline = current;
        state.unchangedCount = 0;

        if (newContent) handleNewOutput(name, newContent);
      }
    } else {
      state.lastSeen = current;
      state.unchangedCount = 0;
    }
  }
}

// Returns { text, via } where via is 'session' or 'pane'.
// Never mutates relayMode — that tracks durable binding state, not per-relay transport.
function getCleanResponse(source, fallbackContent) {
  // Prefer reading from session logs (clean text) over pane scraping
  const logResponse = getLastResponse(source);
  if (logResponse && logResponse.length > 10) return { text: logResponse, via: 'session' };
  // Fall back to cleaned pane capture
  const text = cleanCapture(fallbackContent) || fallbackContent;
  return { text, via: 'pane' };
}

export function handleNewOutput(source, newContent) {
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
    pasteToPane(PANES[other], msg);
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
    pasteToPane(PANES[other], msg);
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
    // /converse [rounds] topic
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
  /clear                   Clear this screen
  /quit                    Stop tools, preserve state for resume
  /detach                  Detach — tools keep running
  /destroy                 Stop tools and remove all run state
  /help                    Show this help${C.reset}
`);
}

// ─── Input handling ──────────────────────────────────────────────────────────

function handleInput(input) {
  const parsed = parseInput(input);

  switch (parsed.type) {
    case 'empty': return;
    case 'help': return printBanner();
    case 'quit':
      stopPolling();
      console.log(`${C.dim}Stopping tools...${C.reset}`);
      sendKeys(PANES.claude, '/exit');
      sendKeys(PANES.codex, '/exit');
      updateRunJson({ status: 'stopped', updated_at: new Date().toISOString() });
      console.log(`${C.dim}Run state preserved — use 'duet resume' to continue.${C.reset}`);
      setTimeout(() => {
        try { execSync(`tmux kill-session -t ${shellEscape(SESSION)}`); } catch {}
        process.exit(0);
      }, 3000);
      return;
    case 'detach':
      console.log(`${C.dim}Detaching — tools will keep running. Reattach with 'duet'.${C.reset}`);
      try { execSync(`tmux detach-client -s ${shellEscape(SESSION)}`); } catch {
        console.log(`${C.red}Failed to detach${C.reset}`);
      }
      return;
    case 'destroy':
      stopPolling();
      console.log(`${C.dim}Destroying run — stopping tools and removing state...${C.reset}`);
      sendKeys(PANES.claude, '/exit');
      sendKeys(PANES.codex, '/exit');
      setTimeout(() => {
        // Remove persistent state BEFORE killing tmux (which kills this process)
        if (DUET_RUN_DIR) { try { rmSync(DUET_RUN_DIR, { recursive: true, force: true }); } catch {} }
        try { execSync(`tmux kill-session -t ${shellEscape(SESSION)}`); } catch {}
        process.exit(0);
      }, 3000);
      return;
    case 'clear':
      process.stdout.write('\x1b[2J\x1b[H');
      return;
    case 'watch':
      startPolling();
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
        console.log(`  ${color}${tool}${C.reset}${pad} relay: ${modeColor(st.relayMode)}${st.relayMode}${level}${transport}${C.reset}`);
      }
      return;
    }
    case 'converse': {
      startPolling();
      converseState = {
        turn: 'claude',
        rounds: 0,
        maxRounds: parsed.maxRounds,
        topic: parsed.topic,
      };
      console.log(`${C.cyan}Starting conversation: "${parsed.topic}" (${parsed.maxRounds} rounds)${C.reset}`);
      const opener = `Let's discuss with @codex: ${parsed.topic}`;
      pasteToPane(PANES.claude, opener);
      return;
    }
    case 'focus':
      if (PANES[parsed.target]) {
        focusPane(PANES[parsed.target]);
        console.log(`${C.dim}Focused ${parsed.target}. Click the bottom pane or Ctrl-B ; to return.${C.reset}`);
      } else {
        console.log(`${C.red}Unknown target. Use: claude, codex${C.reset}`);
      }
      return;
    case 'snap':
      if (PANES[parsed.target]) {
        const output = capturePane(PANES[parsed.target], parsed.lines);
        console.log(`${C.yellow}-- ${parsed.target} (last ${parsed.lines} lines) --${C.reset}`);
        console.log(output);
        console.log(`${C.yellow}-- end --${C.reset}`);
      } else {
        console.log(`${C.red}Unknown target. Use: claude, codex${C.reset}`);
      }
      return;
    case 'relay': {
      const raw = capturePane(PANES[parsed.from], 80).trim();
      const { text: response, via } = getCleanResponse(parsed.from, raw);
      if (!response) {
        console.log(`${C.red}Nothing captured from ${parsed.from}${C.reset}`);
        return;
      }
      const msg = parsed.prompt
        ? `${parsed.prompt.trim()}\n\n${parsed.from} says:\n${response}`
        : `${parsed.from} says:\n${response}`;
      pasteToPane(PANES[parsed.to], msg);
      console.log(`${C.blue}Relayed ${parsed.from} -> ${parsed.to} [${via}]${C.reset}`);
      return;
    }
    case 'relay_error':
      console.log(`Usage: @relay claude>codex [optional prompt]`);
      return;
    case 'both':
      sendKeys(PANES.claude, parsed.msg);
      sendKeys(PANES.codex, parsed.msg);
      console.log(`${C.yellow}-> both${C.reset}`);
      return;
    case 'claude':
      sendKeys(PANES.claude, parsed.msg);
      console.log(`${C.magenta}-> claude${C.reset}`);
      return;
    case 'codex':
      sendKeys(PANES.codex, parsed.msg);
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

  // Auto-start watching for @mentions (also sets up file watchers for session-bound tools)
  startPolling();

  // Report relay status
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

  rl.on('line', (line) => {
    handleInput(line.trim());
    rl.prompt();
  });

  rl.on('close', () => {
    stopPolling();
    process.exit(0);
  });
}

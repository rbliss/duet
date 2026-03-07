import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';

const SESSION = process.env.DUET_SESSION || 'duet';
const CLAUDE_PANE = process.env.CLAUDE_PANE;
const CODEX_PANE = process.env.CODEX_PANE;
const STATE_DIR = process.env.DUET_STATE_DIR || null;

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
    execSync(`tmux paste-buffer -b duet -t ${shellEscape(pane)}`);
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
// Session binding is explicit: duet.sh snapshots session dirs before/after
// launching each tool, diffs to find the new file, and writes the resolved
// path to STATE_DIR/{claude,codex}-session.path. The router reads those paths
// once and never scans global session history.
//
// Each session is read incrementally via a byte-offset cursor. On each call
// we read only new bytes appended since the last read, parse complete JSONL
// lines, and update a cached lastResponse. This means:
//   - Relay always returns the latest complete assistant message
//   - Read cost is proportional to new output, not total file size
//   - No risk of a fixed tail window cutting into a long response

export const sessionState = {
  claude: { path: null, resolved: false, offset: 0, lastResponse: null },
  codex:  { path: null, resolved: false, offset: 0, lastResponse: null },
};

function resolveSessionPath(tool) {
  const st = sessionState[tool];
  if (st.resolved) return st.path;
  if (!STATE_DIR) return null;
  const pathFile = join(STATE_DIR, `${tool}-session.path`);
  try {
    if (existsSync(pathFile)) {
      const p = readFileSync(pathFile, 'utf8').trim();
      if (p && existsSync(p)) {
        st.path = p;
        st.resolved = true;
      }
    }
  } catch {}
  return st.path;
}

function readIncremental(tool) {
  const st = sessionState[tool];
  const filePath = resolveSessionPath(tool);
  if (!filePath) return;
  try {
    const { size } = statSync(filePath);
    if (size <= st.offset) return; // no new data
    const fd = openSync(filePath, 'r');
    try {
      const len = size - st.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.offset);
      const chunk = buf.toString('utf8');
      // Only process complete lines; save any trailing partial line for next read
      const lastNl = chunk.lastIndexOf('\n');
      if (lastNl < 0) return; // no complete line yet
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
          if (extracted) st.lastResponse = extracted;
        } catch {}
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
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

  // Try to find where old content ends in the new capture.
  // Match the last few non-empty lines of baseline in current.
  const baseTail = baseLines.filter(l => l.trim()).slice(-4);
  if (baseTail.length === 0) return current;

  const tailStr = baseTail.join('\n');
  const idx = current.lastIndexOf(tailStr);
  if (idx >= 0) {
    return current.slice(idx + tailStr.length).trim();
  }

  // If screen scrolled past overlap, compute line-level diff
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

const POLL_MS = 2000;
const STABLE_TICKS = 3;        // 3 unchanged polls (~6s) = output is done
const RELAY_COOLDOWN_MS = 8000; // prevent rapid-fire auto-relays

let rl = null; // set when running as main
let watchInterval = null;
let lastAutoRelayTime = 0;
let converseState = null;       // null | { turn, rounds, maxRounds, topic }

const watchState = {
  claude: { baseline: '', lastSeen: '', unchangedCount: 0 },
  codex:  { baseline: '', lastSeen: '', unchangedCount: 0 },
};

export function isWatching() { return watchInterval !== null; }

function prompt() { if (rl) rl.prompt(); }

function startPolling() {
  if (watchInterval) return;
  for (const name of ['claude', 'codex']) {
    const cap = capturePane(PANES[name], 80).trim();
    watchState[name] = { baseline: cap, lastSeen: cap, unchangedCount: 0 };
  }
  watchInterval = setInterval(pollPanes, POLL_MS);
}

function stopPolling() {
  if (watchInterval) clearInterval(watchInterval);
  watchInterval = null;
  converseState = null;
}

function pollPanes() {
  for (const name of ['claude', 'codex']) {
    const state = watchState[name];
    const current = capturePane(PANES[name], 80).trim();

    if (current === state.lastSeen) {
      state.unchangedCount++;

      if (state.unchangedCount === STABLE_TICKS && current !== state.baseline) {
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

function getCleanResponse(source, fallbackContent) {
  // Prefer reading from session logs (clean text) over pane scraping
  const logResponse = getLastResponse(source);
  if (logResponse && logResponse.length > 10) return logResponse;
  // Fall back to cleaned pane capture
  return cleanCapture(fallbackContent) || fallbackContent;
}

function handleNewOutput(source, newContent) {
  const other = source === 'claude' ? 'codex' : 'claude';
  const now = Date.now();

  // Cooldown: don't auto-relay too fast from the same event
  if (now - lastAutoRelayTime < RELAY_COOLDOWN_MS) return;

  // --- @mention detection (use pane content for detection, logs for relay) ---
  const mentions = detectMentions(newContent);
  const mentionsOther = mentions.includes(other);

  if (mentionsOther && !converseState) {
    lastAutoRelayTime = now;
    const response = getCleanResponse(source, newContent);
    console.log(`\n${C.blue}[auto] ${source} mentioned @${other} — relaying${C.reset}`);
    const msg = `${source} says:\n${response}`;
    pasteToPane(PANES[other], msg);
    prompt();
    return;
  }

  // --- Converse mode auto-relay ---
  if (converseState && converseState.turn === source) {
    converseState.rounds++;
    if (converseState.rounds > converseState.maxRounds) {
      console.log(`\n${C.yellow}[converse] Reached ${converseState.maxRounds} rounds — stopping${C.reset}`);
      converseState = null;
      prompt();
      return;
    }

    lastAutoRelayTime = now;
    const response = getCleanResponse(source, newContent);
    console.log(`\n${C.blue}[converse] round ${converseState.rounds}/${converseState.maxRounds}: ${source} -> ${other}${C.reset}`);
    const msg = `${source} says (round ${converseState.rounds} on "${converseState.topic}"):\n${response}`;
    pasteToPane(PANES[other], msg);
    converseState.turn = other;
    prompt();
  }
}

// ─── Input parsing ───────────────────────────────────────────────────────────

export function parseInput(input) {
  if (!input) return { type: 'empty' };

  if (input === '/help') return { type: 'help' };
  if (input === '/quit' || input === '/exit') return { type: 'quit' };
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
  /quit                    Exit duet
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
      console.log(`${C.dim}Shutting down claude...${C.reset}`);
      sendKeys(PANES.claude, '/exit');
      console.log(`${C.dim}Shutting down codex...${C.reset}`);
      sendKeys(PANES.codex, '/exit');
      console.log(`${C.dim}Waiting for tools to exit...${C.reset}`);
      setTimeout(() => {
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
    case 'status':
      if (converseState) {
        console.log(`${C.cyan}Converse:${C.reset} "${converseState.topic}" — round ${converseState.rounds}/${converseState.maxRounds}, waiting on ${converseState.turn}`);
      } else if (isWatching()) {
        console.log(`${C.cyan}Watching${C.reset} for @mentions`);
      } else {
        console.log(`${C.dim}Idle — not watching${C.reset}`);
      }
      return;
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
      const response = getCleanResponse(parsed.from, raw);
      if (!response) {
        console.log(`${C.red}Nothing captured from ${parsed.from}${C.reset}`);
        return;
      }
      const msg = parsed.prompt
        ? `${parsed.prompt.trim()}\n\n${parsed.from} says:\n${response}`
        : `${parsed.from} says:\n${response}`;
      pasteToPane(PANES[parsed.to], msg);
      console.log(`${C.blue}Relayed ${parsed.from} -> ${parsed.to}${C.reset}`);
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

  // Auto-start watching for @mentions
  startPolling();
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

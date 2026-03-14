#!/usr/bin/env node
// Fake Codex agent for integration tests.
// Honors the real binding contract:
//   - Creates a JSONL file under $CODEX_SESSIONS (from CODEX_HOME)
//   - First line contains authoritative payload.id (different from filename)
//   - Includes payload.cwd for fallback compatibility
//   - On stdin input: writes structured Codex responses to session log
//
// Test knobs (env vars):
//   FAKE_CODEX_BIND_DELAY_MS  - delay before creating session log (tests late binding)
//   FAKE_CODEX_LAZY_SESSION   - if '1', defer session log creation until first stdin input
//                                (simulates Codex v0.114.0+ lazy session behavior)
//   DUET_INBOX_DIR            - where to write inbox log (overrides DUET_RUN_DIR)
//   FAKE_PASTE_SETTLE_MS      - if >0 and stdin is TTY, enter raw/TUI mode that
//                                ignores Enter presses arriving within this many ms
//                                after a bracketed paste ends (tests paste-settle timing)

import { createInterface } from 'readline';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTuiStdin } from './tui-stdin.mjs';

// Parse launch mode: `codex resume <id> ...` vs `codex ...`
const args = process.argv.slice(2);
let launchMode = 'new';
let resumeId = null;
if (args[0] === 'resume' && args[1]) {
  launchMode = 'resume';
  resumeId = args[1];
}

const codexHome = process.env.CODEX_HOME;
if (!codexHome) {
  console.error('fake-codex: CODEX_HOME required');
  process.exit(1);
}

const sessionsDir = join(codexHome, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

// Filename UUID is deliberately different from payload.id
const fileUuid = randomUUID();
const payloadId = resumeId || `codex-session-${randomUUID().slice(0, 8)}`;
const sessionLog = join(sessionsDir, `${fileUuid}.jsonl`);
const inboxLog = join(process.env.DUET_INBOX_DIR || process.env.DUET_RUN_DIR || '/tmp', 'codex-inbox.log');
const cwd = process.cwd();

// Write startup log recording launch mode and IDs for test assertions
const startupLog = join(process.env.DUET_INBOX_DIR || process.env.DUET_RUN_DIR || '/tmp', 'codex-startup.log');
appendFileSync(startupLog, JSON.stringify({ tool: 'codex', launchMode, resumeId, payloadId, pid: process.pid, ts: new Date().toISOString() }) + '\n');

function writeSessionInit() {
  // Write initial session metadata with payload.id (different from filename)
  appendFileSync(sessionLog, JSON.stringify({
    type: 'event_msg',
    payload: {
      id: payloadId,
      type: 'session_start',
      cwd: cwd,
    },
  }) + '\n');
  console.log(`fake-codex: session ${payloadId} (file: ${fileUuid.slice(0, 8)}…) ready`);
}

function writeResponse(text) {
  const entry = {
    type: 'event_msg',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  };
  appendFileSync(sessionLog, JSON.stringify(entry) + '\n');
  appendFileSync(sessionLog, JSON.stringify({
    payload: { type: 'task_complete', last_agent_message: text },
  }) + '\n');
}

// Write response using Codex CLI ≥0.105 formats:
//   - event_msg with payload.type 'agent_message' (string in payload.message)
//   - response_item with assistant content blocks (output_text)
//   - task_complete WITHOUT last_agent_message (marks completion for fast debounce
//     but cannot overwrite lastResponse, ensuring the test proves the new parser)
function writeResponseNewFormat(text) {
  // 1. event_msg agent_message (Codex CLI ≥0.105)
  appendFileSync(sessionLog, JSON.stringify({
    type: 'event_msg',
    payload: { type: 'agent_message', message: text },
  }) + '\n');
  // 2. response_item with assistant content blocks
  appendFileSync(sessionLog, JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  }) + '\n');
  // 3. task_complete without last_agent_message — signals completion to isResponseComplete()
  //    but extractCodexResponse returns null (no text to extract), so lastResponse is preserved
  appendFileSync(sessionLog, JSON.stringify({
    payload: { type: 'task_complete' },
  }) + '\n');
}

// Session creation modes:
//   - lazy: defer session file until first stdin input (FAKE_CODEX_LAZY_SESSION=1)
//   - delayed: create after a fixed delay (FAKE_CODEX_BIND_DELAY_MS)
//   - immediate: create now (default)
const lazySession = process.env.FAKE_CODEX_LAZY_SESSION === '1';
let sessionInitialized = false;

function ensureSessionInit() {
  if (sessionInitialized) return;
  sessionInitialized = true;
  writeSessionInit();
}

if (lazySession) {
  console.log('fake-codex: lazy session mode — will create session log on first input');
} else {
  const bindDelay = parseInt(process.env.FAKE_CODEX_BIND_DELAY_MS || '0', 10);
  if (bindDelay > 0) {
    console.log(`fake-codex: delaying session log by ${bindDelay}ms`);
    setTimeout(ensureSessionInit, bindDelay);
  } else {
    ensureSessionInit();
  }
}

// ─── Input processing (shared between readline and raw-TUI modes) ────────────

function processInputLine(trimmed) {
  if (!trimmed) return;

  // Lazy session: create session file on first input
  ensureSessionInit();

  // Log received input
  appendFileSync(inboxLog, `${new Date().toISOString()} ${trimmed}\n`);

  // Mention @claude mode — @claude at line start for strict detection
  if (trimmed.includes('MENTION_CLAUDE')) {
    const responseText = `@claude should look at this. Input was: ${trimmed}`;
    writeResponseNewFormat(responseText);
    console.log(responseText);
    return;
  }

  const responseText = `Codex ACK: ${trimmed}`;
  writeResponse(responseText);
  console.log(responseText);
}

// ─── Input mode selection ────────────────────────────────────────────────────

const pasteSettleMs = parseInt(process.env.FAKE_PASTE_SETTLE_MS || '0', 10);

if (pasteSettleMs > 0 && process.stdin.isTTY) {
  // TUI mode: uses shared raw-stdin handler with bracketed paste detection
  // and settle timing. See tui-stdin.mjs for the implementation.
  console.log(`fake-codex: TUI mode (settle=${pasteSettleMs}ms)`);
  createTuiStdin(pasteSettleMs, processInputLine);
} else {
  // Line mode (default): simple readline-based input
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    processInputLine(line.trim());
  });

  rl.on('close', () => process.exit(0));
}

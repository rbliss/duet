#!/usr/bin/env node
// Fake Claude agent for integration tests.
// Honors the real binding contract:
//   - Accepts --session-id <uuid>
//   - Creates <session-id>.jsonl under CLAUDE_PROJECTS/<project-hash>/
//   - On stdin input: writes structured Claude assistant responses to session log
//   - If input contains MENTION_CODEX marker, response includes @codex
//
// Test knobs (env vars):
//   FAKE_CLAUDE_BIND_DELAY_MS  - delay before creating session log (tests late binding)
//   FAKE_CLAUDE_LAZY_SESSION   - if '1', defer session log creation until first input
//                                 (simulates lazy session behavior)
//   DUET_INBOX_DIR             - where to write inbox log (overrides DUET_RUN_DIR)

import { createInterface } from 'readline';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
let sessionId = null;
let launchMode = 'unknown';
let startupPrompt = null;

// Parse flags and positional args
const flagsWithValue = new Set(['--session-id', '--resume', '--append-system-prompt']);
const flagsStandalone = new Set(['--dangerously-skip-permissions', '--fork-session']);

let i = 0;
while (i < args.length) {
  if (flagsWithValue.has(args[i])) {
    if (args[i] === '--session-id') { sessionId = args[i + 1]; launchMode = 'new'; }
    if (args[i] === '--resume') { sessionId = args[i + 1]; launchMode = 'resume'; }
    i += 2;
  } else if (flagsStandalone.has(args[i])) {
    i += 1;
  } else {
    // Positional argument = startup prompt
    startupPrompt = args[i];
    i += 1;
  }
}

if (!sessionId) {
  console.error('fake-claude: --session-id or --resume required');
  process.exit(1);
}

// Create session log in the same directory structure Claude Code uses
const projectsDir = process.env.CLAUDE_PROJECTS || join(process.env.HOME, '.claude', 'projects');
// Use a test-specific project path
const cwd = process.cwd();
const projectHash = cwd.replace(/\//g, '-').replace(/^-/, '');
const sessionDir = join(projectsDir, projectHash);
mkdirSync(sessionDir, { recursive: true });

const sessionLog = join(sessionDir, `${sessionId}.jsonl`);
const inboxLog = join(process.env.DUET_INBOX_DIR || process.env.DUET_RUN_DIR || '/tmp', 'claude-inbox.log');

// Write startup log recording launch mode and session ID for test assertions
const startupLog = join(process.env.DUET_INBOX_DIR || process.env.DUET_RUN_DIR || '/tmp', 'claude-startup.log');
appendFileSync(startupLog, JSON.stringify({ tool: 'claude', launchMode, sessionId, startupPrompt: startupPrompt || null, pid: process.pid, ts: new Date().toISOString() }) + '\n');

let sessionInitialized = false;

function ensureSessionInit() {
  if (sessionInitialized) return;
  sessionInitialized = true;
  // Write initial session metadata
  appendFileSync(sessionLog, JSON.stringify({
    type: 'session',
    session_id: sessionId,
  }) + '\n');
  console.log(`fake-claude: session ${sessionId.slice(0, 8)}… ready`);
}

function generateResponse(trimmed) {
  // Large multiline response mode
  if (trimmed.includes('LARGE_RESPONSE')) {
    const lines = [];
    lines.push('---BEGIN_LARGE_RESPONSE---');
    for (let i = 1; i <= 50; i++) {
      lines.push(`Line ${i}: This is a large multiline response to test transport integrity.`);
    }
    lines.push('---END_LARGE_RESPONSE---');
    return lines.join('\n');
  }

  // Inline mention mode — incidental @codex that should NOT auto-relay
  if (trimmed.includes('INLINE_MENTION_CODEX')) {
    return `I think we should share with @codex later. Input was: ${trimmed}`;
  }

  // Mention codex mode — @codex at line start for strict detection
  if (trimmed.includes('MENTION_CODEX')) {
    return `@codex should review this. Input was: ${trimmed}`;
  }

  return `Claude response to: ${trimmed}`;
}

function writeResponse(text) {
  const entry = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  };
  appendFileSync(sessionLog, JSON.stringify(entry) + '\n');
  appendFileSync(sessionLog, JSON.stringify({ type: 'result' }) + '\n');
}

// Session creation modes:
//   - lazy: defer session file until first input (FAKE_CLAUDE_LAZY_SESSION=1)
//   - delayed: create after a fixed delay (FAKE_CLAUDE_BIND_DELAY_MS)
//   - immediate: create now (default)
const lazySession = process.env.FAKE_CLAUDE_LAZY_SESSION === '1';

if (lazySession) {
  console.log('fake-claude: lazy session mode — will create session log on first input');
} else {
  const bindDelay = parseInt(process.env.FAKE_CLAUDE_BIND_DELAY_MS || '0', 10);
  if (bindDelay > 0) {
    console.log(`fake-claude: delaying session log by ${bindDelay}ms`);
    setTimeout(ensureSessionInit, bindDelay);
  } else {
    ensureSessionInit();
  }
}

// Handle startup prompt (positional arg from warmup)
if (startupPrompt) {
  ensureSessionInit();
  const responseText = generateResponse(startupPrompt);
  writeResponse(responseText);
  console.log(responseText);
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Lazy session: create session file on first input
  ensureSessionInit();

  // Log received input
  appendFileSync(inboxLog, `${new Date().toISOString()} ${trimmed}\n`);

  const responseText = generateResponse(trimmed);
  writeResponse(responseText);
  console.log(responseText);
});

rl.on('close', () => process.exit(0));

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
//   DUET_INBOX_DIR             - where to write inbox log (overrides DUET_RUN_DIR)

import { createInterface } from 'readline';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
let sessionId = null;
let launchMode = 'unknown';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id') { sessionId = args[i + 1]; launchMode = 'new'; }
  if (args[i] === '--resume') { sessionId = args[i + 1]; launchMode = 'resume'; }
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
appendFileSync(startupLog, JSON.stringify({ tool: 'claude', launchMode, sessionId, pid: process.pid, ts: new Date().toISOString() }) + '\n');

function writeSessionInit() {
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

  // Mention codex mode
  if (trimmed.includes('MENTION_CODEX')) {
    return `I think @codex should review this. Input was: ${trimmed}`;
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

// Delayed binding: wait before creating session log
const bindDelay = parseInt(process.env.FAKE_CLAUDE_BIND_DELAY_MS || '0', 10);
if (bindDelay > 0) {
  console.log(`fake-claude: delaying session log by ${bindDelay}ms`);
  setTimeout(writeSessionInit, bindDelay);
} else {
  writeSessionInit();
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Log received input
  appendFileSync(inboxLog, `${new Date().toISOString()} ${trimmed}\n`);

  const responseText = generateResponse(trimmed);
  writeResponse(responseText);
  console.log(responseText);
});

rl.on('close', () => process.exit(0));

#!/usr/bin/env node
// Fake Claude agent for integration tests.
// Honors the real binding contract:
//   - Accepts --session-id <uuid>
//   - Creates <session-id>.jsonl under CLAUDE_PROJECTS/<project-hash>/
//   - On stdin input: writes structured Claude assistant responses to session log
//   - If input contains MENTION_CODEX marker, response includes @codex

import { createInterface } from 'readline';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
let sessionId = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session-id') sessionId = args[i + 1];
}

if (!sessionId) {
  console.error('fake-claude: --session-id required');
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

// Write initial session metadata
appendFileSync(sessionLog, JSON.stringify({
  type: 'session',
  session_id: sessionId,
}) + '\n');

console.log(`fake-claude: session ${sessionId.slice(0, 8)}… ready`);

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Log received input
  appendFileSync(inboxLog, `${new Date().toISOString()} ${trimmed}\n`);

  // Generate response
  const mentionCodex = trimmed.includes('MENTION_CODEX');
  const responseText = mentionCodex
    ? `I think @codex should review this. Input was: ${trimmed}`
    : `Claude response to: ${trimmed}`;

  // Write structured assistant message that extractClaudeResponse() accepts
  const entry = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: responseText }],
      stop_reason: 'end_turn',
    },
  };
  appendFileSync(sessionLog, JSON.stringify(entry) + '\n');

  // Also write a result entry for completion detection
  appendFileSync(sessionLog, JSON.stringify({ type: 'result' }) + '\n');

  console.log(responseText);
});

rl.on('close', () => process.exit(0));

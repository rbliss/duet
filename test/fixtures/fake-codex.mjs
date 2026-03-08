#!/usr/bin/env node
// Fake Codex agent for integration tests.
// Honors the real binding contract:
//   - Creates a JSONL file under $CODEX_SESSIONS (from CODEX_HOME)
//   - First line contains authoritative payload.id (different from filename)
//   - Includes payload.cwd for fallback compatibility
//   - On stdin input: writes structured Codex responses to session log

import { createInterface } from 'readline';
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const codexHome = process.env.CODEX_HOME;
if (!codexHome) {
  console.error('fake-codex: CODEX_HOME required');
  process.exit(1);
}

const sessionsDir = join(codexHome, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

// Filename UUID is deliberately different from payload.id
const fileUuid = randomUUID();
const payloadId = `codex-session-${randomUUID().slice(0, 8)}`;
const sessionLog = join(sessionsDir, `${fileUuid}.jsonl`);
const inboxLog = join(process.env.DUET_INBOX_DIR || process.env.DUET_RUN_DIR || '/tmp', 'codex-inbox.log');
const cwd = process.cwd();

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

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Log received input
  appendFileSync(inboxLog, `${new Date().toISOString()} ${trimmed}\n`);

  const responseText = `Codex ACK: ${trimmed}`;

  // Write structured Codex response that extractCodexResponse() accepts
  const entry = {
    type: 'event_msg',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: responseText }],
    },
  };
  appendFileSync(sessionLog, JSON.stringify(entry) + '\n');

  // Write task_complete for completion detection
  appendFileSync(sessionLog, JSON.stringify({
    payload: { type: 'task_complete', last_agent_message: responseText },
  }) + '\n');

  console.log(responseText);
});

rl.on('close', () => process.exit(0));

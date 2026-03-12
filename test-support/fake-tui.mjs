#!/usr/bin/env node
// Fake TUI process for paste-settle timing tests.
//
// Simulates a TUI application that needs a settle period after bracketed paste
// before it accepts Enter. Reproduces the real failure mode:
//   1. Pasted content appears visibly in the pane (rendered as draft)
//   2. Enter is ignored if it arrives before the settle period
//   3. Draft persists — a later Enter (after settle) submits it
//
// Env vars:
//   FAKE_PASTE_SETTLE_MS  - ms to wait after paste-end before accepting Enter (default 800)
//   FAKE_TUI_INBOX        - file to write accepted submissions to

import { appendFileSync, writeFileSync } from 'fs';
import { createTuiStdin } from './tui-stdin.mjs';

const settleMs = parseInt(process.env.FAKE_PASTE_SETTLE_MS || '800', 10);
const inboxFile = process.env.FAKE_TUI_INBOX;
if (!inboxFile) {
  console.error('fake-tui: FAKE_TUI_INBOX required');
  process.exit(1);
}

// Clear inbox
writeFileSync(inboxFile, '');

createTuiStdin(settleMs, (line) => {
  console.log(`\nSUBMITTED: ${line}`);
  appendFileSync(inboxFile, `${line}\n`);
});

console.log(`fake-tui: ready (settle=${settleMs}ms)`);

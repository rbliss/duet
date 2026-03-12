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

const settleMs = parseInt(process.env.FAKE_PASTE_SETTLE_MS || '800', 10);
const inboxFile = process.env.FAKE_TUI_INBOX;
if (!inboxFile) {
  console.error('fake-tui: FAKE_TUI_INBOX required');
  process.exit(1);
}

// Clear inbox
writeFileSync(inboxFile, '');

// Enable bracketed paste mode — tells tmux to send \e[200~ / \e[201~ markers
process.stdout.write('\x1b[?2004h');

process.stdin.setRawMode(true);
process.stdin.resume();

let buf = '';
let pasteEndAt = 0;

function renderDraft() {
  // Show current draft in the pane so it's visible via capturePane.
  // Uses \r to overwrite the current line, mimicking a TUI input field.
  process.stdout.write(`\r\x1b[K[draft] ${buf}`);
}

process.stdin.on('data', (data) => {
  let str = data.toString('utf8');

  // Detect bracketed paste markers and strip them from content
  if (str.includes('\x1b[200~')) {
    str = str.replace('\x1b[200~', '');
  }
  if (str.includes('\x1b[201~')) {
    str = str.replace('\x1b[201~', '');
    pasteEndAt = Date.now();
  }

  for (const ch of str) {
    if (ch === '\r' || ch === '\n') {
      if (!buf.trim()) continue;

      const elapsed = Date.now() - pasteEndAt;
      if (pasteEndAt > 0 && elapsed < settleMs) {
        // Enter arrived too soon after paste — ignore it but KEEP the draft
        console.log(`\n[settle] Enter ignored (${elapsed}ms < ${settleMs}ms)`);
        renderDraft(); // re-render draft so it stays visible
        continue;
      }

      // Accept submission — clear draft and write to inbox
      const line = buf.trim();
      buf = '';
      pasteEndAt = 0;
      console.log(`\nSUBMITTED: ${line}`);
      appendFileSync(inboxFile, `${line}\n`);
      continue;
    }
    if (ch === '\x03') process.exit(0); // Ctrl+C
    if (ch.charCodeAt(0) >= 32 || ch === '\t') buf += ch;
  }

  // Render draft after each data chunk so pasted content is visible
  if (buf) renderDraft();
});

console.log(`fake-tui: ready (settle=${settleMs}ms)`);

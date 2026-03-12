// Shared raw-stdin handler with bracketed paste detection and settle timing.
//
// Used by fake-tui.mjs and fake-codex.mjs TUI mode to reproduce the real
// failure mode: pasted content appears in the pane but Enter is ignored
// until a settle period elapses after paste-end.
//
// Usage:
//   import { createTuiStdin } from './tui-stdin.mjs';
//   createTuiStdin(settleMs, (line) => { /* handle submitted line */ });

export function createTuiStdin(settleMs, onSubmit) {
  process.stdout.write('\x1b[?2004h'); // enable bracketed paste
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let buf = '';
  let pasteEndAt = 0;

  function renderDraft() {
    process.stdout.write(`\r\x1b[K[draft] ${buf}`);
  }

  process.stdin.on('data', (data) => {
    let str = data.toString('utf8');

    // Detect and strip bracketed paste markers
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
          // Enter too soon — ignore but KEEP draft for later submission
          console.log(`\n[settle] Enter ignored (${elapsed}ms < ${settleMs}ms)`);
          renderDraft();
          continue;
        }

        // Accept submission
        const line = buf.trim();
        buf = '';
        pasteEndAt = 0;
        onSubmit(line);
        continue;
      }
      if (ch === '\x03') process.exit(0); // Ctrl+C
      if (ch.charCodeAt(0) >= 32 || ch === '\t') buf += ch;
    }

    // Render draft after each data chunk so pasted content is visible
    if (buf) renderDraft();
  });

  process.stdin.on('end', () => process.exit(0));
}

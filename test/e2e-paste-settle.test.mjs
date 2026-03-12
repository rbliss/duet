import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createE2eHarness, e2eWaitFor, e2eSleep } from '../test-support/e2e-harness.mjs';

// ─── E2e: paste-settle timing with real Duet stack ───────────────────────────
//
// Verifies that relay delivery (pasteToPane) works when the target TUI has a
// paste-settle period — the real failure mode where pasted content appears in
// the pane but Enter is ignored because the TUI isn't ready yet.
//
// Uses FAKE_PASTE_SETTLE_MS=800 on fake-codex, which enters raw/TUI mode and
// ignores Enter presses arriving within 800ms of a bracketed paste end.
// The transport fix (PASTE_SUBMIT_DELAY_MS=1000) waits long enough for the
// settle period to elapse before sending Enter.

describe('e2e: paste-settle relay delivery', { timeout: 60000 }, () => {
  const h = createE2eHarness('paste-settle', { FAKE_PASTE_SETTLE_MS: '800' });

  before(async () => {
    h.setup();
    await h.launchDuet();
    await h.waitForBinding();
  });

  after(() => h.cleanup());

  it('both agents bind with paste-settle enabled', () => {
    const b = h.readBindings();
    assert.equal(b.claude.status, 'bound');
    assert.equal(b.codex.status, 'bound');
  });

  it('@relay claude>codex delivers through paste-settle TUI', async () => {
    // Step 1: send a message to Claude so it has a response to relay
    const token = `SETTLE_RELAY_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 8000);

    // Wait for Claude's response to be written to session log
    await e2eSleep(1500);

    // Step 2: relay Claude's response to Codex (uses pasteToPane)
    await h.sendToRouter(`@relay claude>codex check this`);

    // Step 3: verify Codex received the relayed message
    // With old 500ms delay this would fail (Enter ignored by 800ms settle timer)
    // With new 1000ms delay this succeeds (Enter arrives after settle period)
    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes('claude says') || inbox.includes(token);
    }, 15000);

    const codexInbox = h.readInbox('codex');
    assert.ok(codexInbox.includes('claude says') || codexInbox.includes(token),
      'codex should receive relayed message through paste-settle TUI');
  });
});

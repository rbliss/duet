import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createE2eHarness, e2eWaitFor, e2eSleep, findRouterPane } from '../test-support/e2e-harness.mjs';

// ─── Source-mode e2e ─────────────────────────────────────────────────────────

describe('e2e: multiline paste into router', { timeout: 60000 }, () => {
  const h = createE2eHarness('mlpaste');

  before(async () => {
    h.setup();
    await h.launchDuet();
    await h.waitForBinding();
    await h.waitForRouterReady();
  });

  after(() => h.cleanup());

  it('multiline @codex paste is delivered as one message', async () => {
    const token = `MLPASTE_${Date.now()}`;
    // sendToRouter uses pasteToPane which does bracketed paste (-p)
    // The router's readline splits this into multiple 'line' events,
    // and the coalescer buffers them into a single input
    const multiline = `@codex ${token}\nStep 1: analyze\nStep 2: implement\nStep 3: test`;
    await h.sendToRouter(multiline);

    // Verify codex received ALL lines
    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes(token) && inbox.includes('Step 3');
    }, 15000);

    const inbox = h.readInbox('codex');
    assert.ok(inbox.includes(token), 'codex should receive the token');
    assert.ok(inbox.includes('Step 1'), 'codex should receive step 1');
    assert.ok(inbox.includes('Step 2'), 'codex should receive step 2');
    assert.ok(inbox.includes('Step 3'), 'codex should receive step 3');
  });

  it('multiline @claude paste is delivered', async () => {
    const token = `MLCLAUDE_${Date.now()}`;
    const multiline = `@claude ${token}\nLine A\nLine B`;
    await h.sendToRouter(multiline);

    await e2eWaitFor(() => {
      const inbox = h.readInbox('claude');
      return inbox.includes(token) && inbox.includes('Line B');
    }, 15000);

    const inbox = h.readInbox('claude');
    assert.ok(inbox.includes(token), 'claude should receive the token');
    assert.ok(inbox.includes('Line A'), 'claude should receive Line A');
    assert.ok(inbox.includes('Line B'), 'claude should receive Line B');
  });

  it('single-line commands still work after multiline paste', async () => {
    const token = `SINGLE_${Date.now()}`;
    await h.sendToRouter(`@codex ${token}`);

    await e2eWaitFor(() => h.readInbox('codex').includes(token), 10000);
    assert.ok(h.readInbox('codex').includes(token));
  });
});

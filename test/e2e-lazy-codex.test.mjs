import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createE2eHarness, e2eWaitFor, e2eSleep } from '../test-support/e2e-harness.mjs';

/**
 * E2e test for lazy Codex session creation (Codex v0.114.0+ behavior).
 *
 * Proves the whole-stack flow:
 *   1. Launch headless Duet with a short bind timeout
 *   2. Codex does NOT create its session file at startup
 *   3. Reconciler finishes → Codex stays pending (not degraded)
 *   4. Send @codex <token> which triggers session file creation
 *   5. Router auto-discovers the new session via late discovery
 *   6. bindings.json updates to bound without manual /rebind
 */
describe('e2e: lazy Codex session creation', { timeout: 60000 }, () => {
  const h = createE2eHarness('lazycx', {
    FAKE_CODEX_LAZY_SESSION: '1',
    BIND_TIMEOUT: '2',  // 1 second (2 iterations × 500ms)
  });

  before(async () => {
    h.setup();
    await h.launchDuet();
  });

  after(() => h.cleanup());

  it('codex stays pending after reconciler timeout (not degraded)', async () => {
    // Wait for router to be ready
    await h.waitForRouterReady();

    // Wait for reconciler to finish (BIND_TIMEOUT=2 → ~1s polling)
    // Plus some margin for process startup
    await e2eSleep(3000);

    const b = h.readBindings();
    assert.ok(b, 'bindings.json should exist');
    assert.equal(b.claude.status, 'bound', 'claude should be bound (creates session immediately)');
    assert.equal(b.codex.status, 'pending',
      'codex should be pending (not degraded) — fresh launch with lazy session');
  });

  it('first message triggers session creation and auto-binding', async () => {
    const token = `LAZY_${Date.now()}`;

    // Send a message to codex — this triggers lazy session file creation
    await h.sendToRouter(`@codex ${token}`);

    // Verify codex received the message
    await e2eWaitFor(() => h.readInbox('codex').includes(token), 10000);

    // Wait for router late discovery to find the new session and bind it
    await e2eWaitFor(() => {
      const b = h.readBindings();
      return b && b.codex?.status === 'bound';
    }, 15000);

    const b = h.readBindings();
    assert.equal(b.codex.status, 'bound', 'codex should be auto-bound after session creation');
    assert.ok(b.codex.path, 'codex binding should have a path');
    assert.equal(b.codex.level, 'process', 'codex binding level should be process');
  });

  it('relay works after auto-binding', async () => {
    // Send another message to codex so the watcher (started after rebind)
    // sees a fresh response — the initial ACK was written before the watcher started.
    const relayToken = `RELAY_${Date.now()}`;
    await h.sendToRouter(`@codex ${relayToken}`);
    await e2eWaitFor(() => h.readInbox('codex').includes(relayToken), 10000);

    // Give the session watcher time to detect the new response
    await e2eSleep(2000);

    // Now relay codex's latest response to claude
    await h.sendToRouter(`@relay codex>claude post-lazy relay test`);

    await e2eWaitFor(() => {
      const inbox = h.readInbox('claude');
      return inbox.includes('codex says') || inbox.includes('post-lazy');
    }, 15000);

    const claudeInbox = h.readInbox('claude');
    assert.ok(
      claudeInbox.includes('codex says') || claudeInbox.includes('post-lazy'),
      'claude should receive relay from codex after auto-binding'
    );
  });
});

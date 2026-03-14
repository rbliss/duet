import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createE2eHarness, e2eWaitFor, e2eSleep } from '../test-support/e2e-harness.mjs';

/**
 * E2e test for startup warmup binding.
 *
 * Proves that when both tools are lazy (no session file until first prompt),
 * the warmup positional prompt forces session creation at launch, so both
 * tools become session-bound without any operator input.
 *
 * Also verifies the router skips the warmup history (DUET_SKIP_STARTUP_HISTORY)
 * so that the startup READY response is never relayed.
 */
describe('e2e: startup warmup auto-binding', { timeout: 60000 }, () => {
  const h = createE2eHarness('warmup', {
    FAKE_CLAUDE_LAZY_SESSION: '1',
    FAKE_CODEX_LAZY_SESSION: '1',
    BIND_TIMEOUT: '10',
  });

  before(async () => {
    h.setup();
    await h.launchDuet();
  });

  after(() => h.cleanup());

  it('both lazy tools become bound without operator input', async () => {
    // Wait for the router to be ready
    await h.waitForRouterReady();

    // Both tools should become bound via warmup prompt — no operator message needed
    await e2eWaitFor(() => h.bothBound(), 20000);

    const b = h.readBindings();
    assert.equal(b.claude.status, 'bound', 'claude should be bound');
    assert.equal(b.codex.status, 'bound', 'codex should be bound');
  });

  it('startup logs show positional prompt was received', () => {
    const claudeStartup = h.readStartupLog('claude');
    assert.ok(claudeStartup.length > 0, 'claude startup log should exist');
    assert.ok(claudeStartup[0].startupPrompt, 'claude should have received a startup prompt');

    const codexStartup = h.readStartupLog('codex');
    assert.ok(codexStartup.length > 0, 'codex startup log should exist');
    assert.ok(codexStartup[0].startupPrompt, 'codex should have received a startup prompt');
  });

  it('@relay does not forward warmup READY response', async () => {
    // Give watchers time to settle
    await e2eSleep(2000);

    // Try to relay claude's output to codex — the warmup response should be
    // invisible (reader was seeked to EOF), so there should be nothing to relay
    await h.sendToRouter('@relay claude>codex warmup check');

    // Wait a beat for any relay to happen
    await e2eSleep(2000);

    // The codex inbox should NOT contain the warmup response text
    const codexInbox = h.readInbox('codex');
    assert.ok(
      !codexInbox.includes('Startup warmup'),
      'codex inbox should not contain warmup prompt text'
    );
    assert.ok(
      !codexInbox.includes('READY'),
      'codex inbox should not contain warmup READY response'
    );
  });

  it('real messages relay normally after warmup', async () => {
    const token = `REAL_${Date.now()}`;

    // Send a real message to claude
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);

    // Give the session watcher time to pick up the response
    await e2eSleep(2000);

    // Relay claude's response to codex
    await h.sendToRouter(`@relay claude>codex post-warmup relay`);

    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes('claude says') || inbox.includes(token);
    }, 15000);

    const codexInbox = h.readInbox('codex');
    assert.ok(
      codexInbox.includes('claude says') || codexInbox.includes(token),
      'codex should receive relayed real response after warmup'
    );
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createE2eHarness, e2eWaitFor, e2eSleep } from '../test-support/e2e-harness.mjs';

/**
 * E2e tests proving:
 *   1. Auto-relay is off by default — explicit @codex in Claude output does NOT relay
 *   2. After /watch, inline @codex does NOT relay (strict detection)
 *   3. After /watch, line-start @codex DOES relay
 */
describe('e2e: watch-mode gated auto-relay', { timeout: 60000 }, () => {
  const h = createE2eHarness('watchrelay');

  before(async () => {
    h.setup();
    await h.launchDuet();
    await h.waitForBinding();
    await h.waitForRouterReady();
  });

  after(() => h.cleanup());

  it('startup does not auto-relay even with explicit @codex in output', async () => {
    // Without /watch, even a line-start @codex in Claude's response should not relay
    const token = `NOWATCH_MENTION_CODEX_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);

    // Wait for Claude to process and write its response
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);
    // Give the router time to NOT relay (it shouldn't, but let's wait to be sure)
    await e2eSleep(3000);

    // Codex should NOT have received anything
    const codexInbox = h.readInbox('codex');
    assert.ok(!codexInbox.includes(token),
      'codex should NOT receive relay without /watch enabled');
  });

  it('after /watch, inline @codex does NOT relay', async () => {
    // Enable watch mode
    await h.sendToRouter('/watch');
    await e2eSleep(1000);

    // INLINE_MENTION_CODEX triggers Claude response with inline @codex
    const token = `INLINE_MENTION_CODEX_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);

    // Wait for Claude to process
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);
    // Give the router time to NOT relay
    await e2eSleep(3000);

    // Codex should NOT have received the inline mention
    const codexInbox = h.readInbox('codex');
    assert.ok(!codexInbox.includes(token),
      'codex should NOT receive relay from inline @codex mention');
  });

  it('after /watch, line-start @codex DOES relay', async () => {
    // MENTION_CODEX triggers Claude response with @codex at line start
    const token = `MENTION_CODEX_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);

    // Wait for codex to receive the relay
    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes(token);
    }, 20000);

    assert.ok(h.readInbox('codex').includes(token),
      'codex should receive relay from line-start @codex mention');
  });

  it('/stop disables auto-relay', async () => {
    await h.sendToRouter('/stop');
    await e2eSleep(500);

    const token = `AFTERSTOP_MENTION_CODEX_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);
    await e2eSleep(3000);

    const codexInbox = h.readInbox('codex');
    assert.ok(!codexInbox.includes(token),
      'codex should NOT receive relay after /stop');
  });
});

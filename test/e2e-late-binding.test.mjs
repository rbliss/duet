import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createE2eHarness, e2eWaitFor, e2eSleep } from '../test-support/e2e-harness.mjs';

describe('e2e: late-binding activation', { timeout: 60000 }, () => {
  const h = createE2eHarness('latebind', {
    FAKE_CLAUDE_BIND_DELAY_MS: '3000',
    FAKE_CODEX_BIND_DELAY_MS: '3000',
  });

  before(async () => {
    h.setup();
    await h.launchDuet();
  });

  after(() => h.cleanup());

  it('starts with pending bindings', () => {
    assert.ok(h.runDir, 'run dir should exist');
    const b = h.readBindings();
    assert.ok(b, 'bindings.json should exist');
    assert.ok(b.claude, 'claude binding entry should exist');
    assert.ok(b.codex, 'codex binding entry should exist');
  });

  it('transitions to bound after delay', async () => {
    await h.waitForBinding(25000);
    const b = h.readBindings();
    assert.equal(b.claude.status, 'bound', 'claude should be bound');
    assert.equal(b.codex.status, 'bound', 'codex should be bound');
  });

  it('session-driven relay works after late binding', async () => {
    const token = `LATEBIND_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);

    await e2eSleep(1000);

    await h.sendToRouter(`@relay claude>codex verify late binding`);
    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes('claude says') || inbox.includes(token);
    }, 15000);

    const codexInbox = h.readInbox('codex');
    assert.ok(codexInbox.includes('claude says') || codexInbox.includes(token),
      'codex should receive session-driven relay after late binding');
  });
});

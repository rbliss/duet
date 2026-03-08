import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

import { createE2eHarness, e2eWaitFor, e2eSleep } from '../test-support/e2e-harness.mjs';

describe('e2e: large multiline relay', { timeout: 60000 }, () => {
  const h = createE2eHarness('large');

  before(async () => {
    h.setup();
    await h.launchDuet();
    await h.waitForBinding();
  });

  after(() => h.cleanup());

  it('relays large multiline response from claude to codex intact', async () => {
    const token = `LARGE_RESPONSE_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);

    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);
    await e2eSleep(1500);

    await h.sendToRouter(`@relay claude>codex check the large response`);

    // Wait for END sentinel (not BEGIN — last line has no trailing newline
    // in the paste, so it only arrives after pasteToPane sends Enter 500ms later)
    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes('END_LARGE_RESPONSE');
    }, 15000);

    const bindings = h.readBindings();
    const claudeLog = readFileSync(bindings.claude.path, 'utf8');
    assert.ok(claudeLog.includes('BEGIN_LARGE_RESPONSE'),
      'claude session log should contain start sentinel');
    assert.ok(claudeLog.includes('END_LARGE_RESPONSE'),
      'claude session log should contain end sentinel');

    const codexInbox = h.readInbox('codex');
    assert.ok(codexInbox.includes('BEGIN_LARGE_RESPONSE'),
      'codex inbox should contain start sentinel from relayed response');
    assert.ok(codexInbox.includes('END_LARGE_RESPONSE'),
      'codex inbox should contain end sentinel from relayed response');
    assert.ok(codexInbox.includes('Line 50:'),
      'codex inbox should contain deep interior line (Line 50) proving complete delivery');
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createE2eHarness, e2eWaitFor } from '../test-support/e2e-harness.mjs';

describe('e2e: /send-debug', { timeout: 60000 }, () => {
  const h = createE2eHarness('debug');

  before(async () => {
    h.setup();
    await h.launchDuet();
    await h.waitForBinding();
  });

  after(() => h.cleanup());

  it('sends debug snapshot to codex with recognizable content', async () => {
    await h.sendToRouter('/send-debug codex investigate relay');

    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes('DUET DEBUG SNAPSHOT');
    }, 15000);

    const codexInbox = h.readInbox('codex');

    assert.ok(codexInbox.includes('DUET DEBUG SNAPSHOT'),
      'codex inbox should contain debug snapshot header');

    assert.ok(codexInbox.includes('[claude]'),
      'debug snapshot should contain claude tool section');
    assert.ok(codexInbox.includes('[codex]'),
      'debug snapshot should contain codex tool section');

    const rj = h.readRunJson();
    assert.ok(codexInbox.includes(rj.run_id),
      'debug snapshot should contain the run ID');

    if (rj.claude?.session_id) {
      assert.ok(codexInbox.includes(rj.claude.session_id),
        'debug snapshot should contain claude session ID');
    }

    assert.ok(codexInbox.includes('investigate relay'),
      'debug snapshot should contain the operator note');

    assert.ok(codexInbox.includes('debug snapshot'),
      'debug snapshot should contain instruction header');
  });
});

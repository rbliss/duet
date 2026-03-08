import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

import { createE2eHarness, e2eWaitFor, e2eSleep } from '../test-support/e2e-harness.mjs';

describe('e2e: headless duet with fake agents', { timeout: 60000 }, () => {
  const h = createE2eHarness('basic');

  before(async () => {
    h.setup();
    await h.launchDuet();
    await h.waitForBinding();
  });

  after(() => h.cleanup());

  it('launches headlessly and both agents bind', () => {
    assert.ok(h.runDir, 'run dir should exist');
    assert.ok(h.tmuxSession, 'tmux session should exist');
    const b = h.readBindings();
    assert.equal(b.claude.status, 'bound');
    assert.equal(b.codex.status, 'bound');
  });

  it('codex binding has payload.id different from filename', () => {
    const b = h.readBindings();
    assert.ok(b.codex.path, 'codex should have a binding path');
    assert.ok(b.codex.session_id, 'codex should have a session_id');
    const filename = b.codex.path.split('/').pop().replace('.jsonl', '');
    assert.notEqual(filename, b.codex.session_id,
      'codex filename should differ from payload.id');
  });

  it('manual relay: @claude delivers to fake claude', async () => {
    const token = `MANUAL_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 8000);
    assert.ok(h.readInbox('claude').includes(token));
  });

  it('manual relay: @relay claude>codex delivers structured response', async () => {
    const token = `RELAY_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 8000);

    await e2eSleep(1000);

    await h.sendToRouter(`@relay claude>codex check this`);

    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes('claude says') || inbox.includes(token);
    }, 10000);
    const codexInbox = h.readInbox('codex');
    assert.ok(codexInbox.includes('claude says') || codexInbox.includes(token),
      'codex should receive relayed claude response');
  });

  it('watch mode: auto-relays @codex mention from claude to codex', async () => {
    await h.sendToRouter('/watch');
    await e2eSleep(1000);

    const token = `MENTION_CODEX_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);

    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes(token);
    }, 20000);

    const codexInbox = h.readInbox('codex');
    assert.ok(codexInbox.includes(token),
      'codex should receive auto-relayed message containing the mention token');

    await h.sendToRouter('/stop');
  });

  it('watch mode: auto-relays @claude mention from codex to claude (new JSONL formats)', async () => {
    await h.sendToRouter('/watch');
    await e2eSleep(1000);

    // MENTION_CLAUDE triggers fake-codex to respond using Codex CLI ≥0.105 formats:
    //   event_msg/agent_message + response_item (not just task_complete)
    // task_complete gets a generic message without @claude, so the router must
    // parse the new formats to detect the mention.
    const token = `MENTION_CLAUDE_${Date.now()}`;
    await h.sendToRouter(`@codex ${token}`);

    await e2eWaitFor(() => {
      const inbox = h.readInbox('claude');
      return inbox.includes(token);
    }, 20000);

    const claudeInbox = h.readInbox('claude');
    assert.ok(claudeInbox.includes(token),
      'claude should receive auto-relayed message from codex (new JSONL format)');

    await h.sendToRouter('/stop');
  });
});

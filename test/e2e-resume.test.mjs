import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';

import { createE2eHarness, e2eWaitFor, e2eSleep } from '../test-support/e2e-harness.mjs';
import { TEST_TMUX_SOCKET, tmuxEnv } from '../test-support/tmux.mjs';

const PROJECT_ROOT = dirname(import.meta.dirname);

describe('e2e: resume run', { timeout: 90000 }, () => {
  const h = createE2eHarness('resume');
  let originalRunId, originalClaudeSid, originalCodexSid;

  before(async () => {
    h.setup();

    // Phase 1: launch and interact
    await h.launchDuet();
    await h.waitForBinding();

    const rj = h.readRunJson();
    originalRunId = rj.run_id;
    originalClaudeSid = rj.claude.session_id;
    originalCodexSid = h.readBindings().codex.session_id;

    const token = `PRE_RESUME_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 8000);
    await e2eSleep(1000);

    // Phase 2: stop the run
    try {
      execSync(
        `tmux -S ${TEST_TMUX_SOCKET} kill-session -t "${h.tmuxSession}" 2>/dev/null`,
        { env: tmuxEnv, stdio: 'ignore' }
      );
    } catch {}

    const runJsonPath = join(h.runDir, 'run.json');
    const data = JSON.parse(readFileSync(runJsonPath, 'utf8'));
    data.status = 'stopped';
    data.updated_at = new Date().toISOString();
    const bindings = h.readBindings();
    if (bindings.claude?.path) data.claude.binding_path = bindings.claude.path;
    if (bindings.codex?.path) data.codex.binding_path = bindings.codex.path;
    if (originalCodexSid) data.codex.session_id = originalCodexSid;
    writeFileSync(runJsonPath, JSON.stringify(data, null, 2));

    await e2eSleep(500);

    try { rmSync(join(h.inboxDir, 'claude-inbox.log')); } catch {}
    try { rmSync(join(h.inboxDir, 'codex-inbox.log')); } catch {}
    h.clearStartupLogs();

    // Phase 3: resume
    h.tmuxSession = null;
    const duetScript = join(PROJECT_ROOT, 'duet.sh');
    try {
      execSync(
        `bash "${duetScript}" resume "${originalRunId}"`,
        { encoding: 'utf8', env: h.buildEnv(), timeout: 10000 }
      );
    } catch {}

    await e2eWaitFor(() => {
      const rj2 = h.readRunJson();
      if (rj2 && rj2.status === 'active' && rj2.tmux_session) {
        h.tmuxSession = rj2.tmux_session;
        return true;
      }
      return false;
    }, 5000);

    await h.waitForBinding(25000);
  });

  after(() => h.cleanup());

  it('preserves run identity across resume', () => {
    const rj = h.readRunJson();
    assert.equal(rj.run_id, originalRunId, 'run ID should persist');
    assert.equal(rj.mode, 'resumed', 'mode should be resumed');
    assert.equal(rj.status, 'active', 'status should be active');
  });

  it('reuses stored Claude session ID', () => {
    const rj = h.readRunJson();
    assert.equal(rj.claude.session_id, originalClaudeSid,
      'claude session ID should be reused on resume');
  });

  it('fake claude launched in resume mode with stored session ID', async () => {
    await e2eWaitFor(() => h.readStartupLog('claude').length > 0, 10000);
    const entries = h.readStartupLog('claude');
    const last = entries[entries.length - 1];
    assert.equal(last.launchMode, 'resume', 'claude should be launched with --resume');
    assert.equal(last.sessionId, originalClaudeSid, 'claude should resume with stored session ID');
  });

  it('fake codex launched in resume mode with stored session ID', async () => {
    await e2eWaitFor(() => h.readStartupLog('codex').length > 0, 10000);
    const entries = h.readStartupLog('codex');
    const last = entries[entries.length - 1];
    assert.equal(last.launchMode, 'resume', 'codex should be launched with resume subcommand');
    assert.equal(last.resumeId, originalCodexSid, 'codex should resume with stored session ID');
  });

  it('relay works on the resumed run', async () => {
    const token = `RESUMED_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);
    assert.ok(h.readInbox('claude').includes(token),
      'claude should receive message on resumed run');
  });

  it('prior transcript is not replayed into inbox', () => {
    const inbox = h.readInbox('claude');
    assert.ok(!inbox.includes('PRE_RESUME_'),
      'pre-resume messages should not appear in post-resume inbox');
  });
});

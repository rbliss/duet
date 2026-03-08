import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { createE2eHarness, e2eWaitFor } from '../test-support/e2e-harness.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DUET_SH = join(PROJECT_ROOT, 'duet.sh');

// ─── CLI smoke ──────────────────────────────────────────────────────────────

describe('dist: CLI smoke', () => {
  before(() => {
    // Ensure dist is built
    assert.ok(existsSync(join(PROJECT_ROOT, 'dist/cli/duet.mjs')),
      'dist/cli/duet.mjs must exist — run npm run build first');
  });

  it('duet list works via dist path', () => {
    const tempBase = `/tmp/duet-dist-cli-${process.pid}`;
    mkdirSync(tempBase, { recursive: true });
    try {
      const output = execSync(`bash "${DUET_SH}" list`, {
        encoding: 'utf8',
        env: {
          ...process.env,
          DUET_USE_DIST: '1',
          DUET_BASE: tempBase,
          HOME: tempBase,
          PATH: process.env.PATH,
        },
        timeout: 10000,
      });
      assert.ok(output.includes('DUET RUNS') || output.includes('no runs found'),
        `expected header or no-runs output, got: ${output.slice(0, 200)}`);
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it('dist reconciler runs and exits 0', () => {
    const tempBase = `/tmp/duet-dist-reconciler-${process.pid}`;
    const stateDir = join(tempBase, 'state');
    mkdirSync(stateDir, { recursive: true });
    try {
      execSync(`node "${join(PROJECT_ROOT, 'dist/bindings/reconciler.mjs')}"`, {
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_SESSION_ID: 'test-session-id',
          CLAUDE_PROJECTS: join(tempBase, 'projects'),
          CODEX_SESSIONS: join(tempBase, 'codex-sessions'),
          STATE_DIR: stateDir,
          WORKDIR: tempBase,
          BIND_TIMEOUT: '1',
          HOME: tempBase,
        },
        timeout: 10000,
      });
      // Reconciler should have written bindings.json
      assert.ok(existsSync(join(stateDir, 'bindings.json')),
        'reconciler should write bindings.json');
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });
});

// ─── Headless launch smoke ──────────────────────────────────────────────────

describe('dist: headless launch', { timeout: 60000 }, () => {
  const h = createE2eHarness('dist-smoke', { DUET_USE_DIST: '1' });

  before(async () => {
    // Ensure dist is built
    assert.ok(existsSync(join(PROJECT_ROOT, 'dist/cli/duet.mjs')),
      'dist must be built');
    h.setup();
    await h.launchDuet();
    await h.waitForBinding();
  });

  after(() => h.cleanup());

  it('launches via dist and both agents bind', () => {
    assert.ok(h.runDir, 'run dir should exist');
    assert.ok(h.tmuxSession, 'tmux session should exist');
    const b = h.readBindings();
    assert.equal(b.claude.status, 'bound');
    assert.equal(b.codex.status, 'bound');
  });

  it('manual relay works via dist router', async () => {
    const token = `DIST_RELAY_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 8000);
    assert.ok(h.readInbox('claude').includes(token),
      'claude should receive message via dist router');
  });
});

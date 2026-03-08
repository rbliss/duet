import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { createE2eHarness, e2eWaitFor } from '../test-support/e2e-harness.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DUET_SH = join(PROJECT_ROOT, 'duet.sh');

// ─── CLI smoke ──────────────────────────────────────────────────────────────

describe('dist: CLI smoke', () => {
  before(() => {
    // Ensure dist is built
    assert.ok(existsSync(join(PROJECT_ROOT, 'dist/cli/duet.js')),
      'dist/cli/duet.js must exist — run npm run build first');
  });

  it('duet list works via dist path (default mode)', () => {
    const tempBase = `/tmp/duet-dist-cli-${process.pid}`;
    mkdirSync(tempBase, { recursive: true });
    try {
      const output = execSync(`bash "${DUET_SH}" list`, {
        encoding: 'utf8',
        env: {
          ...process.env,
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

  it('duet list works via explicit source mode', () => {
    const tempBase = `/tmp/duet-dist-cli-src-${process.pid}`;
    mkdirSync(tempBase, { recursive: true });
    try {
      const output = execSync(`bash "${DUET_SH}" list`, {
        encoding: 'utf8',
        env: {
          ...process.env,
          DUET_USE_SOURCE: '1',
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

  it('duet.sh fails clearly when dist is missing', () => {
    const tempBase = `/tmp/duet-dist-missing-${process.pid}`;
    const fakeDir = join(tempBase, 'fakerepo');
    mkdirSync(fakeDir, { recursive: true });
    // Create a duet.sh that points at a dir with no dist/
    const shimContent = readFileSync(DUET_SH, 'utf8').replace(
      /DIR=.*/, `DIR="${fakeDir}"`
    );
    const shimPath = join(tempBase, 'duet-test.sh');
    writeFileSync(shimPath, shimContent, { mode: 0o755 });
    try {
      execSync(`bash "${shimPath}" list`, {
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH },
        timeout: 5000,
      });
      assert.fail('should have exited with error');
    } catch (err) {
      assert.ok(err.stderr.includes('npm run build'),
        `expected build hint in stderr, got: ${err.stderr}`);
      assert.ok(err.status !== 0, 'should exit non-zero');
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it('package bin entry resolves to a valid executable', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.bin && pkg.bin.duet, 'package.json should have bin.duet');
    const binPath = join(PROJECT_ROOT, pkg.bin.duet);
    assert.ok(existsSync(binPath), `bin entry ${pkg.bin.duet} should exist after build`);
    const head = readFileSync(binPath, 'utf8').slice(0, 30);
    assert.ok(head.startsWith('#!/usr/bin/env node'), 'bin entry should have node shebang');
  });

  it('package bin entry works as CLI', () => {
    const tempBase = `/tmp/duet-bin-cli-${process.pid}`;
    mkdirSync(tempBase, { recursive: true });
    try {
      const binPath = join(PROJECT_ROOT, 'dist/cli/duet.js');
      const output = execSync(`node "${binPath}" list`, {
        encoding: 'utf8',
        env: {
          ...process.env,
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

  it('clean build then dist list works', () => {
    // Verify the build output we're testing against exists (it was built before tests)
    assert.ok(existsSync(join(PROJECT_ROOT, 'dist/cli/duet.js')), 'dist should be built');
    assert.ok(existsSync(join(PROJECT_ROOT, 'dist/router/controller.js')), 'router should be built');
    assert.ok(existsSync(join(PROJECT_ROOT, 'dist/bindings/reconciler.js')), 'reconciler should be built');

    const tempBase = `/tmp/duet-clean-smoke-${process.pid}`;
    mkdirSync(tempBase, { recursive: true });
    try {
      const output = execSync(`node "${join(PROJECT_ROOT, 'dist/cli/duet.js')}" list`, {
        encoding: 'utf8',
        env: {
          ...process.env,
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
      execSync(`node "${join(PROJECT_ROOT, 'dist/bindings/reconciler.js')}"`, {
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
  const h = createE2eHarness('dist-smoke', { DUET_USE_SOURCE: '' });

  before(async () => {
    // Ensure dist is built
    assert.ok(existsSync(join(PROJECT_ROOT, 'dist/cli/duet.js')),
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

  it('watch mode: codex→claude relay works via dist (new JSONL formats)', async () => {
    const { e2eSleep } = await import('../test-support/e2e-harness.mjs');
    await h.sendToRouter('/watch');
    await e2eSleep(1000);

    // MENTION_CLAUDE triggers fake-codex's new-format response path
    const token = `DIST_MENTION_CLAUDE_${Date.now()}`;
    await h.sendToRouter(`@codex ${token}`);

    await e2eWaitFor(() => {
      const inbox = h.readInbox('claude');
      return inbox.includes(token);
    }, 20000);

    assert.ok(h.readInbox('claude').includes(token),
      'claude should receive codex→claude relay via dist router (new JSONL format)');

    await h.sendToRouter('/stop');
  });
});

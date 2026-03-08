import { exec, execSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { pasteToPane, capturePane } from '../src/transport/tmux-client.js';
import { sanitizedEnv } from './env.mjs';
import { TEST_TMUX_SOCKET, tmuxEnv } from './tmux.mjs';

export function e2eSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function e2eWaitFor(fn, timeoutMs = 15000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await e2eSleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function e2eExecAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', env: tmuxEnv }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

// Find router pane by title instead of assuming position
export async function findRouterPane(session) {
  const { stdout } = await e2eExecAsync(
    `tmux -S ${TEST_TMUX_SOCKET} list-panes -t "${session}" -F "#{pane_id} #{pane_title}" 2>/dev/null`
  );
  for (const line of stdout.trim().split('\n')) {
    const [id, ...rest] = line.split(' ');
    if (rest.join(' ') === 'Duet Router') return id;
  }
  // Fallback: last pane
  const panes = stdout.trim().split('\n');
  return panes[panes.length - 1].split(' ')[0];
}

// Resolve project root (where duet.sh lives)
const PROJECT_ROOT = dirname(import.meta.dirname);

// Create an isolated e2e environment and return helpers
export function createE2eHarness(tag, extraEnv = {}) {
  const testId = `e2e-${tag}-${process.pid}`;
  const tempBase = `/tmp/duet-${testId}`;
  const fakeHome = join(tempBase, 'home');
  const fakeBin = join(tempBase, 'bin');
  const workDir = join(tempBase, 'workspace');
  const inboxDir = join(tempBase, 'inbox');
  const duetBase = join(fakeHome, '.local', 'state', 'duet');

  const h = {
    tempBase, fakeHome, fakeBin, workDir, inboxDir, duetBase,
    tmuxSession: null,
    runDir: null,
    runId: null,

    findRunDir() {
      const runsDir = join(duetBase, 'runs');
      try {
        for (const d of readdirSync(runsDir)) {
          const rj = join(runsDir, d, 'run.json');
          if (existsSync(rj)) return join(runsDir, d);
        }
      } catch {}
      return null;
    },

    findRunDirById(id) {
      const rj = join(duetBase, 'runs', id, 'run.json');
      return existsSync(rj) ? join(duetBase, 'runs', id) : null;
    },

    readRunJson() {
      if (!h.runDir) return null;
      try { return JSON.parse(readFileSync(join(h.runDir, 'run.json'), 'utf8')); } catch { return null; }
    },

    readBindings() {
      if (!h.runDir) return null;
      try { return JSON.parse(readFileSync(join(h.runDir, 'bindings.json'), 'utf8')); } catch { return null; }
    },

    bothBound() {
      const b = h.readBindings();
      return b && b.claude?.status === 'bound' && b.codex?.status === 'bound' ? b : null;
    },

    readInbox(tool) {
      try { return readFileSync(join(inboxDir, `${tool}-inbox.log`), 'utf8'); } catch { return ''; }
    },

    readStartupLog(tool) {
      try {
        return readFileSync(join(inboxDir, `${tool}-startup.log`), 'utf8')
          .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      } catch { return []; }
    },

    clearStartupLogs() {
      try { rmSync(join(inboxDir, 'claude-startup.log')); } catch {}
      try { rmSync(join(inboxDir, 'codex-startup.log')); } catch {}
    },

    async waitForRouterReady(timeoutMs = 10000) {
      await e2eWaitFor(async () => {
        const pane = await findRouterPane(h.tmuxSession);
        const output = await capturePane(pane, 20);
        return output.includes('duet>');
      }, timeoutMs);
    },

    async sendToRouter(text) {
      const routerPane = await findRouterPane(h.tmuxSession);
      await pasteToPane(routerPane, text);
    },

    buildEnv() {
      return sanitizedEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        HOME: fakeHome,
        DUET_BASE: duetBase,
        DUET_NO_ATTACH: '1',
        DUET_TMUX_SOCKET: TEST_TMUX_SOCKET,
        DUET_INBOX_DIR: inboxDir,
        TMUX: '',
        BIND_TIMEOUT: '10',
        COLUMNS: '120',
        LINES: '40',
        DUET_USE_SOURCE: '1',  // dev tests use source mode by default
        ...extraEnv,
      });
    },

    async launchDuet(args = '') {
      const duetScript = join(PROJECT_ROOT, 'duet.sh');
      const cmd = `bash "${duetScript}" ${args || `"${workDir}"`}`;
      try {
        execSync(cmd, { encoding: 'utf8', env: h.buildEnv(), timeout: 10000 });
      } catch {}

      await e2eWaitFor(() => {
        h.runDir = h.findRunDir();
        return h.runDir;
      }, 5000);

      const rj = h.readRunJson();
      h.tmuxSession = rj.tmux_session;
      h.runId = rj.run_id;
    },

    async waitForBinding(timeoutMs = 20000) {
      await e2eWaitFor(() => h.bothBound(), timeoutMs, 500);
    },

    dumpDiagnostics() {
      console.log('--- E2E DIAGNOSTICS ---');
      try { console.log('bindings.json:', JSON.stringify(h.readBindings(), null, 2)); } catch {}
      try { console.log('run.json:', JSON.stringify(h.readRunJson(), null, 2)); } catch {}
      try { console.log('claude inbox:', h.readInbox('claude').slice(-500)); } catch {}
      try { console.log('codex inbox:', h.readInbox('codex').slice(-500)); } catch {}
      console.log('--- END DIAGNOSTICS ---');
    },

    setup() {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      mkdirSync(inboxDir, { recursive: true });
      mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true });
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });

      const nodeExe = process.execPath;
      const supportDir = join(PROJECT_ROOT, 'test-support');
      writeFileSync(join(fakeBin, 'claude'),
        `#!/bin/sh\nexec "${nodeExe}" "${supportDir}/fake-claude.mjs" "$@"\n`, { mode: 0o755 });
      writeFileSync(join(fakeBin, 'codex'),
        `#!/bin/sh\nexec "${nodeExe}" "${supportDir}/fake-codex.mjs" "$@"\n`, { mode: 0o755 });
    },

    cleanup() {
      if (h.tmuxSession) {
        try { execSync(`tmux -S ${TEST_TMUX_SOCKET} kill-session -t "${h.tmuxSession}" 2>/dev/null`, { env: tmuxEnv, stdio: 'ignore' }); } catch {}
      }
      rmSync(tempBase, { recursive: true, force: true });
    },
  };

  return h;
}

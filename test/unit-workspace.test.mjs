import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import {
  cwdHash,
  nowIso,
  readRunField,
  writeRunJson,
  findActiveRun,
  updateWorkspaceIndex,
  resolveRunId,
  buildToolPrompt,
  listRuns,
  destroyRun,
} from '../src/runtime/workspace.mjs';

// ─── cwdHash ─────────────────────────────────────────────────────────────────

describe('cwdHash', () => {
  it('produces same hash as shell md5sum', () => {
    const testPath = '/home/user/project';
    const shellHash = execSync(`echo -n "${testPath}" | md5sum | cut -d' ' -f1`, { encoding: 'utf8' }).trim();
    assert.equal(cwdHash(testPath), shellHash);
  });

  it('different paths produce different hashes', () => {
    assert.notEqual(cwdHash('/a'), cwdHash('/b'));
  });
});

// ─── nowIso ──────────────────────────────────────────────────────────────────

describe('nowIso', () => {
  it('returns ISO timestamp without milliseconds', () => {
    const result = nowIso();
    assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// ─── readRunField ────────────────────────────────────────────────────────────

describe('readRunField', () => {
  const testDir = '/tmp/duet-test-readfield-' + process.pid;
  const runJson = join(testDir, 'run.json');

  before(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(runJson, JSON.stringify({
      run_id: 'test-123',
      status: 'active',
      claude: { session_id: 'claude-sid', binding_path: null },
      codex: { session_id: null },
      codex_home: '/path/to/home',
    }));
  });

  after(() => rmSync(testDir, { recursive: true, force: true }));

  it('reads top-level string field', () => {
    assert.equal(readRunField(runJson, 'status'), 'active');
  });

  it('reads dotted key', () => {
    assert.equal(readRunField(runJson, 'claude.session_id'), 'claude-sid');
  });

  it('returns empty string for null values', () => {
    assert.equal(readRunField(runJson, 'claude.binding_path'), '');
    assert.equal(readRunField(runJson, 'codex.session_id'), '');
  });

  it('returns empty string for missing keys', () => {
    assert.equal(readRunField(runJson, 'nonexistent'), '');
    assert.equal(readRunField(runJson, 'claude.nonexistent'), '');
  });

  it('returns empty string for dict values', () => {
    assert.equal(readRunField(runJson, 'claude'), '');
  });

  it('returns empty string for missing file', () => {
    assert.equal(readRunField('/tmp/nonexistent.json', 'status'), '');
  });
});

// ─── writeRunJson ────────────────────────────────────────────────────────────

describe('writeRunJson', () => {
  const testDir = '/tmp/duet-test-writerj-' + process.pid;
  const runJson = join(testDir, 'run.json');

  before(() => mkdirSync(testDir, { recursive: true }));
  after(() => rmSync(testDir, { recursive: true, force: true }));

  it('creates file if it does not exist', () => {
    try { rmSync(runJson); } catch {}
    writeRunJson(runJson, { run_id: 'abc', status: 'active' });
    const data = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(data.run_id, 'abc');
    assert.equal(data.status, 'active');
  });

  it('merges into existing file', () => {
    writeRunJson(runJson, { status: 'stopped', updated_at: '2026-01-01' });
    const data = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(data.run_id, 'abc');
    assert.equal(data.status, 'stopped');
    assert.equal(data.updated_at, '2026-01-01');
  });

  it('handles dotted keys', () => {
    writeRunJson(runJson, { 'claude.session_id': 'sid-123' });
    const data = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(data.claude.session_id, 'sid-123');
  });

  it('converts empty string values to null', () => {
    writeRunJson(runJson, { 'codex.session_id': '' });
    const data = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(data.codex.session_id, null);
  });
});

// ─── findActiveRun ───────────────────────────────────────────────────────────

describe('findActiveRun', () => {
  const testDir = '/tmp/duet-test-findactive-' + process.pid;
  const runsDir = join(testDir, 'runs');
  const wsDir = join(testDir, 'workspaces');
  const cwd = '/home/test/project';

  before(() => {
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });
  after(() => rmSync(testDir, { recursive: true, force: true }));

  it('returns null when no workspace index exists', () => {
    assert.equal(findActiveRun(cwd, runsDir, wsDir), null);
  });

  it('returns run ID when active run exists', () => {
    const runId = 'active-run-001';
    mkdirSync(join(runsDir, runId), { recursive: true });
    writeRunJson(join(runsDir, runId, 'run.json'), { run_id: runId, status: 'active' });
    updateWorkspaceIndex(cwd, runId, 'true', wsDir);

    assert.equal(findActiveRun(cwd, runsDir, wsDir), runId);
  });

  it('returns null when run is stopped', () => {
    const runId = 'stopped-run-001';
    mkdirSync(join(runsDir, runId), { recursive: true });
    writeRunJson(join(runsDir, runId, 'run.json'), { run_id: runId, status: 'stopped' });
    updateWorkspaceIndex(cwd, runId, 'true', wsDir);

    assert.equal(findActiveRun(cwd, runsDir, wsDir), null);
  });
});

// ─── updateWorkspaceIndex ────────────────────────────────────────────────────

describe('updateWorkspaceIndex', () => {
  const testDir = '/tmp/duet-test-wsindex-' + process.pid;
  const wsDir = join(testDir, 'workspaces');
  const cwd = '/home/test/ws';

  before(() => mkdirSync(testDir, { recursive: true }));
  after(() => rmSync(testDir, { recursive: true, force: true }));

  it('creates workspace index with active run', () => {
    updateWorkspaceIndex(cwd, 'run-1', 'true', wsDir);
    const hash = cwdHash(cwd);
    const data = JSON.parse(readFileSync(join(wsDir, `${hash}.json`), 'utf8'));
    assert.equal(data.active, 'run-1');
    assert.ok(data.runs.includes('run-1'));
    assert.equal(data.cwd, cwd);
  });

  it('adds second run without changing active', () => {
    updateWorkspaceIndex(cwd, 'run-2', false, wsDir);
    const hash = cwdHash(cwd);
    const data = JSON.parse(readFileSync(join(wsDir, `${hash}.json`), 'utf8'));
    assert.equal(data.active, 'run-1');
    assert.ok(data.runs.includes('run-2'));
  });

  it('clears active when requested', () => {
    updateWorkspaceIndex(cwd, 'run-1', 'clear', wsDir);
    const hash = cwdHash(cwd);
    const data = JSON.parse(readFileSync(join(wsDir, `${hash}.json`), 'utf8'));
    assert.equal(data.active, null);
  });

  it('does not clear active for wrong run id', () => {
    updateWorkspaceIndex(cwd, 'run-2', 'true', wsDir);
    updateWorkspaceIndex(cwd, 'run-1', 'clear', wsDir); // run-1 is not active
    const hash = cwdHash(cwd);
    const data = JSON.parse(readFileSync(join(wsDir, `${hash}.json`), 'utf8'));
    assert.equal(data.active, 'run-2');
  });
});

// ─── resolveRunId ────────────────────────────────────────────────────────────

describe('resolveRunId', () => {
  const testDir = '/tmp/duet-test-resolve-' + process.pid;
  const runsDir = join(testDir, 'runs');

  before(() => {
    mkdirSync(runsDir, { recursive: true });
    for (const id of ['aaaaaaaa-1111', 'aaaaaaaa-2222', 'bbbbbbbb-3333']) {
      mkdirSync(join(runsDir, id), { recursive: true });
      writeRunJson(join(runsDir, id, 'run.json'), {
        run_id: id,
        updated_at: id === 'bbbbbbbb-3333' ? '2026-03-08T10:00:00Z' : '2026-03-07T01:00:00Z',
      });
    }
  });
  after(() => rmSync(testDir, { recursive: true, force: true }));

  it('resolves exact match', () => {
    const result = resolveRunId('aaaaaaaa-1111', runsDir);
    assert.equal(result.runId, 'aaaaaaaa-1111');
    assert.equal(result.error, null);
  });

  it('resolves "last" to most recently updated', () => {
    const result = resolveRunId('last', runsDir);
    assert.equal(result.runId, 'bbbbbbbb-3333');
  });

  it('resolves unique prefix', () => {
    const result = resolveRunId('bbbb', runsDir);
    assert.equal(result.runId, 'bbbbbbbb-3333');
  });

  it('errors on ambiguous prefix', () => {
    const result = resolveRunId('aaaa', runsDir);
    assert.equal(result.runId, '');
    assert.ok(result.error.includes('ambiguous prefix'));
    assert.ok(result.error.includes('2 runs'));
  });

  it('returns empty for no match', () => {
    const result = resolveRunId('zzzz', runsDir);
    assert.equal(result.runId, '');
    assert.equal(result.error, null);
  });
});

// ─── buildToolPrompt ─────────────────────────────────────────────────────────

describe('buildToolPrompt', () => {
  const testDir = '/tmp/duet-test-prompt-' + process.pid;
  const workdir = join(testDir, 'project');
  const outputDir = join(testDir, 'runtime');
  const duetMdPath = '/home/claude/duet/DUET.md';

  before(() => {
    mkdirSync(workdir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
  });
  after(() => rmSync(testDir, { recursive: true, force: true }));

  it('produces plain DUET.md when no role file exists', () => {
    const output = join(outputDir, 'plain.md');
    buildToolPrompt('claude', workdir, output, duetMdPath);
    const result = readFileSync(output, 'utf8');
    const duetMd = readFileSync(duetMdPath, 'utf8');
    assert.equal(result, duetMd);
  });

  it('appends CLAUDE_ROLE.md when present', () => {
    const roleContent = 'You are the lead architect.';
    writeFileSync(join(workdir, 'CLAUDE_ROLE.md'), roleContent);
    const output = join(outputDir, 'claude-role.md');
    buildToolPrompt('claude', workdir, output, duetMdPath);
    const result = readFileSync(output, 'utf8');
    assert.ok(result.includes('## Project-specific Claude role'));
    assert.ok(result.includes('CLAUDE_ROLE.md'));
    assert.ok(result.includes(roleContent));
    assert.ok(result.includes('Duet: Multi-Agent Collaboration'));
    rmSync(join(workdir, 'CLAUDE_ROLE.md'));
  });

  it('appends CODEX_ROLE.md when present', () => {
    const roleContent = 'You are the testing specialist.';
    writeFileSync(join(workdir, 'CODEX_ROLE.md'), roleContent);
    const output = join(outputDir, 'codex-role.md');
    buildToolPrompt('codex', workdir, output, duetMdPath);
    const result = readFileSync(output, 'utf8');
    assert.ok(result.includes('## Project-specific Codex role'));
    assert.ok(result.includes('CODEX_ROLE.md'));
    assert.ok(result.includes(roleContent));
    rmSync(join(workdir, 'CODEX_ROLE.md'));
  });
});

// ─── listRuns ────────────────────────────────────────────────────────────────

describe('listRuns', () => {
  const testDir = '/tmp/duet-test-listruns-' + process.pid;
  const runsDir = join(testDir, 'runs');

  before(() => mkdirSync(runsDir, { recursive: true }));
  after(() => rmSync(testDir, { recursive: true, force: true }));

  function createRun(id, overrides = {}) {
    const runDir = join(runsDir, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      run_id: id,
      cwd: '/home/test/project',
      status: 'stopped',
      mode: 'new',
      updated_at: '2026-03-07T01:00:00Z',
      tmux_session: `duet-${id.slice(0, 8)}`,
      claude: { session_id: 'claude-sid-001' },
      codex: { session_id: 'codex-sid-001' },
      ...overrides,
    }, null, 2));
  }

  it('shows "(no runs found)" for empty directory', () => {
    const output = listRuns(join(testDir, 'empty'), 'duet.sh');
    assert.ok(output.includes('(no runs found)'));
  });

  it('shows active runs before stopped runs', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });
    createRun('aaaaaaaa-0000-0000-0000-000000000001', {
      status: 'stopped', updated_at: '2026-03-07T03:00:00Z',
    });
    createRun('bbbbbbbb-0000-0000-0000-000000000002', {
      status: 'active', updated_at: '2026-03-07T01:00:00Z',
    });

    const output = listRuns(runsDir, 'duet.sh');
    const activeIdx = output.indexOf('active');
    const stoppedIdx = output.indexOf('stopped');
    assert.ok(activeIdx < stoppedIdx, 'active should appear before stopped');
  });

  it('shows resume hint for stopped runs only', () => {
    const output = listRuns(runsDir, 'duet.sh');
    assert.ok(output.includes('resume:  duet.sh resume aaaaaaaa'));
    assert.ok(!output.includes('resume:  duet.sh resume bbbbbbbb'));
  });

  it('shows shortened session IDs', () => {
    const output = listRuns(runsDir, 'duet.sh');
    assert.ok(output.includes('claude-s\u2026'));
  });

  it('shows "missing" for empty session IDs', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });
    createRun('cccccccc-0000-0000-0000-000000000003', {
      status: 'active',
      claude: { session_id: '' },
      codex: {},
    });
    const output = listRuns(runsDir, 'duet.sh');
    assert.ok(output.includes('claude:  missing'));
    assert.ok(output.includes('codex: missing'));
  });
});

// ─── destroyRun ──────────────────────────────────────────────────────────────

describe('destroyRun', () => {
  const testDir = '/tmp/duet-test-destroy-' + process.pid;
  const runsDir = join(testDir, 'runs');
  const wsDir = join(testDir, 'workspaces');

  before(() => {
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
  });
  after(() => rmSync(testDir, { recursive: true, force: true }));

  it('removes run directory and clears workspace index', () => {
    const runId = 'destroy-test-001';
    const cwd = '/home/test/destroy';
    mkdirSync(join(runsDir, runId), { recursive: true });
    writeRunJson(join(runsDir, runId, 'run.json'), {
      run_id: runId,
      cwd,
      tmux_session: '',
    });
    updateWorkspaceIndex(cwd, runId, 'true', wsDir);

    destroyRun(runId, runsDir, wsDir, null);

    assert.ok(!existsSync(join(runsDir, runId)), 'run dir should be removed');
    const hash = cwdHash(cwd);
    const idx = JSON.parse(readFileSync(join(wsDir, `${hash}.json`), 'utf8'));
    assert.equal(idx.active, null, 'workspace active should be cleared');
  });
});

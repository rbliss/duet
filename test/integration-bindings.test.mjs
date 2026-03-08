import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';

import { sessionState, resolveSessionPath, setStateDir, setDuetMode, setRunDir, getClaudeLastResponse, getCodexLastResponse, updateRunJson } from '../router.mjs';
import { sanitizedEnv } from '../test-support/env.mjs';

// ─── Integration Tests: end-to-end session binding (bindings.json manifest) ──

describe('end-to-end session binding', () => {
  const stateDir = '/tmp/duet-test-binding-' + process.pid;
  const sessionDir = '/tmp/duet-test-sessions-e2e-' + process.pid;
  const claudeLog = join(sessionDir, 'test-claude.jsonl');
  const codexLog = join(sessionDir, 'test-codex.jsonl');

  let origClaude;
  let origCodex;

  before(() => {
    origClaude = { ...sessionState.claude };
    origCodex = { ...sessionState.codex };
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
  });

  after(() => {
    setStateDir(null);
    Object.assign(sessionState.claude, origClaude);
    Object.assign(sessionState.codex, origCodex);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  function resetSessionState() {
    setStateDir(stateDir);
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
  }

  function writeBindings(claude, codex) {
    const manifest = { claude, codex };
    writeFileSync(join(stateDir, 'bindings.json'), JSON.stringify(manifest, null, 2));
  }

  it('resolves claude binding from bindings.json manifest', () => {
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Hello from Claude' }] } });
    writeFileSync(claudeLog, msg + '\n');

    writeBindings(
      { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'unbound', confirmedAt: null }
    );

    resetSessionState();

    const resolved = resolveSessionPath('claude');
    assert.equal(resolved, claudeLog);
    assert.equal(sessionState.claude.resolved, true);
    assert.equal(sessionState.claude.relayMode, 'session');
    assert.equal(sessionState.claude.bindingLevel, 'process');
    assert.equal(getClaudeLastResponse(), 'Hello from Claude');
  });

  it('resolves codex binding from bindings.json manifest', () => {
    const msg = JSON.stringify({ payload: { type: 'task_complete', last_agent_message: 'Hello from Codex' } });
    writeFileSync(codexLog, msg + '\n');

    writeBindings(
      { path: null, level: null, status: 'unbound', confirmedAt: null },
      { path: codexLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() }
    );

    resetSessionState();

    const resolved = resolveSessionPath('codex');
    assert.equal(resolved, codexLog);
    assert.equal(sessionState.codex.resolved, true);
    assert.equal(sessionState.codex.relayMode, 'session');
    assert.equal(sessionState.codex.bindingLevel, 'process');
    assert.equal(getCodexLastResponse(), 'Hello from Codex');
  });

  it('returns null and sets pane mode when no state dir', () => {
    resetSessionState();
    setStateDir(null);

    const resolved = resolveSessionPath('claude');
    assert.equal(resolved, null);
    assert.equal(sessionState.claude.relayMode, 'pane');
    assert.equal(getClaudeLastResponse(), null);
  });

  it('returns null and stays pending when bindings.json missing', () => {
    resetSessionState();
    try { rmSync(join(stateDir, 'bindings.json')); } catch {}

    const resolved = resolveSessionPath('claude');
    assert.equal(resolved, null);
    assert.equal(sessionState.claude.relayMode, 'pending');
  });

  it('picks up late binding when bindings.json appears after first call', () => {
    resetSessionState();
    try { rmSync(join(stateDir, 'bindings.json')); } catch {}

    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pending');

    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Late binding' }] } });
    writeFileSync(claudeLog, msg + '\n');
    writeBindings(
      { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'unbound', confirmedAt: null }
    );

    assert.equal(resolveSessionPath('claude'), claudeLog);
    assert.equal(sessionState.claude.relayMode, 'session');
    assert.equal(getClaudeLastResponse(), 'Late binding');
  });

  it('caches resolved path and does not re-read manifest', () => {
    resetSessionState();
    writeBindings(
      { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'unbound', confirmedAt: null }
    );

    resolveSessionPath('claude');
    assert.equal(sessionState.claude.resolved, true);

    writeBindings(
      { path: '/nonexistent/path.jsonl', level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'unbound', confirmedAt: null }
    );
    assert.equal(resolveSessionPath('claude'), claudeLog);
  });

  it('stays pending when manifest says pending', () => {
    resetSessionState();
    writeBindings(
      { path: null, level: null, status: 'pending', confirmedAt: null },
      { path: null, level: null, status: 'pending', confirmedAt: null }
    );

    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pending');
    assert.equal(sessionState.claude.resolved, false);
  });

  it('degrades to pane when manifest says degraded', () => {
    resetSessionState();
    writeBindings(
      { path: null, level: null, status: 'degraded', confirmedAt: null },
      { path: null, level: null, status: 'degraded', confirmedAt: null }
    );

    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pane');
    assert.equal(sessionState.claude.resolved, true);
  });

  it('re-reads manifest when status changes from pending to bound', () => {
    resetSessionState();
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Late arrival' }] } });
    writeFileSync(claudeLog, msg + '\n');

    writeBindings(
      { path: null, level: null, status: 'pending', confirmedAt: null },
      { path: null, level: null, status: 'pending', confirmedAt: null }
    );
    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pending');

    writeBindings(
      { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'pending', confirmedAt: null }
    );

    assert.equal(resolveSessionPath('claude'), claudeLog);
    assert.equal(sessionState.claude.relayMode, 'session');
    assert.equal(getClaudeLastResponse(), 'Late arrival');
  });

  it('relayMode stays session after transient fallback in getCleanResponse', () => {
    resetSessionState();
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Real response' }] } });
    writeFileSync(claudeLog, msg + '\n');
    writeBindings(
      { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'unbound', confirmedAt: null }
    );

    resolveSessionPath('claude');
    assert.equal(sessionState.claude.relayMode, 'session');

    getClaudeLastResponse();
    sessionState.claude.lastResponse = null;

    assert.equal(sessionState.claude.relayMode, 'session');
  });
});

// ─── Integration Tests: binding lifecycle (pending → bound/degraded) ─────────

describe('binding lifecycle', () => {
  const lifecycleDir = '/tmp/duet-test-lifecycle-' + process.pid;
  const stateDir2 = join(lifecycleDir, 'state');
  const sessionDir2 = join(lifecycleDir, 'sessions');
  const claudeLog2 = join(sessionDir2, 'lifecycle-claude.jsonl');

  let origClaude2;

  before(() => {
    mkdirSync(stateDir2, { recursive: true });
    mkdirSync(sessionDir2, { recursive: true });
    origClaude2 = { ...sessionState.claude };
  });

  after(() => {
    setStateDir(null);
    Object.assign(sessionState.claude, origClaude2);
    rmSync(lifecycleDir, { recursive: true, force: true });
  });

  it('loadBindings re-reads manifest while tools are pending', () => {
    setStateDir(stateDir2);
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };

    writeFileSync(join(stateDir2, 'bindings.json'), JSON.stringify({
      claude: { path: null, level: null, status: 'pending', confirmedAt: null },
      codex: { path: null, level: null, status: 'pending', confirmedAt: null },
    }));

    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pending');

    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
    writeFileSync(claudeLog2, msg + '\n');
    writeFileSync(join(stateDir2, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog2, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      codex: { path: null, level: null, status: 'pending', confirmedAt: null },
    }));

    assert.equal(resolveSessionPath('claude'), claudeLog2);
    assert.equal(sessionState.claude.relayMode, 'session');
  });

  it('stops re-reading manifest once all tools are final', () => {
    setStateDir(stateDir2);
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };

    writeFileSync(join(stateDir2, 'bindings.json'), JSON.stringify({
      claude: { path: null, level: null, status: 'degraded', confirmedAt: null },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null },
    }));

    resolveSessionPath('claude');
    resolveSessionPath('codex');
    assert.equal(sessionState.claude.relayMode, 'pane');
    assert.equal(sessionState.codex.relayMode, 'pane');
    assert.equal(sessionState.claude.resolved, true);
    assert.equal(sessionState.codex.resolved, true);

    writeFileSync(join(stateDir2, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog2, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null },
    }));
    assert.equal(resolveSessionPath('claude'), null);
  });
});

// ─── Integration Tests: launcher binding contract (bind-sessions.sh) ─────────

describe('launcher binding contract', () => {
  const testDir = '/tmp/duet-test-launcher-' + process.pid;
  const stateDir = join(testDir, 'state');
  const claudeProjects = join(testDir, 'claude-projects');
  const codexSessions = join(testDir, 'codex-sessions');
  const globalCodexSessions = join(testDir, 'global-codex-sessions');

  before(() => {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    mkdirSync(codexSessions, { recursive: true });
    mkdirSync(globalCodexSessions, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runBind(env) {
    const fullEnv = sanitizedEnv({
      STATE_DIR: stateDir,
      CLAUDE_PROJECTS: claudeProjects,
      CODEX_SESSIONS: codexSessions,
      GLOBAL_CODEX_SESSIONS: globalCodexSessions,
      WORKDIR: '/test/workdir',
      BIND_TIMEOUT: '2',
      DUET_USE_SOURCE: '1',
      ...env,
    });
    try {
      execSync('bash /home/claude/duet/bind-sessions.sh', { env: fullEnv, timeout: 10000 });
    } catch {}
  }

  function cleanState() {
    try { rmSync(join(stateDir, 'bindings.json')); } catch {}
    try { execSync(`rm -rf ${claudeProjects}/* ${codexSessions}/* ${globalCodexSessions}/*`); } catch {}
  }

  it('binds claude when UUID-named log exists', () => {
    cleanState();
    const uuid = 'test-uuid-' + Date.now();
    const claudeFile = join(claudeProjects, `${uuid}.jsonl`);
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] } });
    writeFileSync(claudeFile, msg + '\n');

    runBind({ CLAUDE_SESSION_ID: uuid });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.claude.status, 'bound');
    assert.equal(bindings.claude.path, claudeFile);
    assert.equal(bindings.claude.level, 'process');
  });

  it('binds codex when session file appears in isolated store', () => {
    cleanState();
    const codexFile = join(codexSessions, 'test-session.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'test-id', cwd: '/test' } });
    writeFileSync(codexFile, meta + '\n');

    runBind({ CLAUDE_SESSION_ID: 'nonexistent-uuid' });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.path, codexFile);
    assert.equal(bindings.codex.level, 'process');
  });

  it('degrades tools when no files appear before deadline', () => {
    cleanState();

    runBind({ CLAUDE_SESSION_ID: 'nonexistent-uuid' });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.claude.status, 'degraded');
    assert.equal(bindings.claude.path, null);
    assert.equal(bindings.codex.status, 'degraded');
    assert.equal(bindings.codex.path, null);
  });

  it('binds both tools when both files exist', () => {
    cleanState();
    const uuid = 'both-uuid-' + Date.now();

    const claudeFile = join(claudeProjects, `${uuid}.jsonl`);
    writeFileSync(claudeFile, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'c' }] } }) + '\n');

    const codexFile = join(codexSessions, 'both-session.jsonl');
    writeFileSync(codexFile, JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/test' } }) + '\n');

    runBind({ CLAUDE_SESSION_ID: uuid });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.claude.status, 'bound');
    assert.equal(bindings.claude.path, claudeFile);
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.path, codexFile);
  });

  it('codex isolation means only file in dir is selected (no ambiguity)', () => {
    cleanState();
    const codexFile = join(codexSessions, 'only-one.jsonl');
    writeFileSync(codexFile, JSON.stringify({ type: 'session_meta', payload: { id: 'unique', cwd: '/any' } }) + '\n');

    runBind({ CLAUDE_SESSION_ID: 'nonexistent' });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.path, codexFile);
  });

  it('falls back to global codex sessions with cwd match when overlay is empty', () => {
    cleanState();
    const globalFile = join(globalCodexSessions, 'fallback-session.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'fb-id', cwd: '/test/workdir' } });
    const child = spawn('bash', ['-c', `sleep 1; echo '${meta}' > '${globalFile}'`], { detached: true, stdio: 'ignore' });
    child.unref();

    runBind({ CLAUDE_SESSION_ID: 'nonexistent' });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.path, globalFile);
    assert.equal(bindings.codex.level, 'workspace');
  });

  it('fallback ignores global codex sessions with wrong cwd', () => {
    cleanState();
    const globalFile = join(globalCodexSessions, 'wrong-cwd.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'wrong', cwd: '/other/dir' } });
    const child = spawn('bash', ['-c', `sleep 1; echo '${meta}' > '${globalFile}'`], { detached: true, stdio: 'ignore' });
    child.unref();

    runBind({ CLAUDE_SESSION_ID: 'nonexistent' });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.codex.status, 'degraded');
  });

  it('prefers isolated store over global fallback', () => {
    cleanState();
    const isolatedFile = join(codexSessions, 'isolated.jsonl');
    writeFileSync(isolatedFile, JSON.stringify({ type: 'session_meta', payload: { id: 'iso', cwd: '/test/workdir' } }) + '\n');

    const globalFile = join(globalCodexSessions, 'global.jsonl');
    writeFileSync(globalFile, JSON.stringify({ type: 'session_meta', payload: { id: 'glob', cwd: '/test/workdir' } }) + '\n');

    runBind({ CLAUDE_SESSION_ID: 'nonexistent' });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.path, isolatedFile);
    assert.equal(bindings.codex.level, 'process');
  });

  it('discovers nested codex session file in isolated store', () => {
    cleanState();
    const nestedDir = join(codexSessions, '2026', '03', '08');
    mkdirSync(nestedDir, { recursive: true });
    const nestedFile = join(nestedDir, 'nested-session.jsonl');
    writeFileSync(nestedFile, JSON.stringify({ type: 'session_meta', payload: { id: 'nested-iso', cwd: '/test' } }) + '\n');

    runBind({ CLAUDE_SESSION_ID: 'nonexistent' });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.path, nestedFile);
    assert.equal(bindings.codex.level, 'process');
    assert.equal(bindings.codex.session_id, 'nested-iso');
  });

  it('discovers nested codex session file in global fallback with cwd match', () => {
    cleanState();
    const nestedDir = join(globalCodexSessions, '2026', '03', '08');
    mkdirSync(nestedDir, { recursive: true });
    const nestedFile = join(nestedDir, 'nested-global.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'nested-glob', cwd: '/test/workdir' } });
    const child = spawn('bash', ['-c', `sleep 1; echo '${meta}' > '${nestedFile}'`], { detached: true, stdio: 'ignore' });
    child.unref();

    runBind({ CLAUDE_SESSION_ID: 'nonexistent' });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.path, nestedFile);
    assert.equal(bindings.codex.level, 'workspace');
    assert.equal(bindings.codex.session_id, 'nested-glob');
  });
});

// ─── Resume: EOF-seek on resumed session binding ─────────────────────────────

describe('EOF-seek on resume', () => {
  const testDir = '/tmp/duet-test-resume-eof-' + process.pid;
  const stateDir = join(testDir, 'state');
  const sessionDir = join(testDir, 'sessions');
  const claudeLog = join(sessionDir, 'resume-claude.jsonl');

  let origClaude, origCodex;

  before(() => {
    origClaude = { ...sessionState.claude };
    origCodex = { ...sessionState.codex };
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
  });

  after(() => {
    setStateDir(null);
    setDuetMode('new');
    setRunDir(null);
    Object.assign(sessionState.claude, origClaude);
    Object.assign(sessionState.codex, origCodex);
    rmSync(testDir, { recursive: true, force: true });
  });

  function resetForResume() {
    setStateDir(stateDir);
    setDuetMode('resumed');
    setRunDir(stateDir);
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
  }

  it('seeks reader to EOF when mode is resumed', () => {
    const oldMsg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Old history' }] } });
    writeFileSync(claudeLog, oldMsg + '\n');
    const fileSize = readFileSync(claudeLog).length;

    writeFileSync(join(stateDir, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null },
    }));

    resetForResume();

    const resolved = resolveSessionPath('claude');
    assert.equal(resolved, claudeLog);
    assert.equal(sessionState.claude.offset, fileSize);

    assert.equal(getClaudeLastResponse(), null);
  });

  it('picks up new content appended after EOF-seek', () => {
    const newMsg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'New after resume' }] } });
    appendFileSync(claudeLog, newMsg + '\n');

    assert.equal(getClaudeLastResponse(), 'New after resume');
  });

  it('does NOT seek to EOF when mode is new', () => {
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Should be visible' }] } });
    writeFileSync(claudeLog, msg + '\n');

    writeFileSync(join(stateDir, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null },
    }));

    setDuetMode('new');
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };

    resolveSessionPath('claude');
    assert.equal(sessionState.claude.offset, 0);
    assert.equal(getClaudeLastResponse(), 'Should be visible');
  });
});

// ─── Resume: binding propagation to run.json ─────────────────────────────────

describe('binding propagation to run.json', () => {
  const testDir = '/tmp/duet-test-propagation-' + process.pid;
  const stateDir = join(testDir, 'state');
  const sessionDir = join(testDir, 'sessions');
  const claudeLog = join(sessionDir, 'prop-claude.jsonl');
  const runJson = join(stateDir, 'run.json');

  let origClaude, origCodex;

  before(() => {
    origClaude = { ...sessionState.claude };
    origCodex = { ...sessionState.codex };
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
  });

  after(() => {
    setStateDir(null);
    setDuetMode('new');
    setRunDir(null);
    Object.assign(sessionState.claude, origClaude);
    Object.assign(sessionState.codex, origCodex);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes binding path and session_id to run.json on resolution', () => {
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] } });
    writeFileSync(claudeLog, msg + '\n');
    writeFileSync(join(stateDir, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString(), session_id: 'claude-uuid-123' },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null },
    }));

    writeFileSync(runJson, JSON.stringify({ run_id: 'test-run', status: 'active' }));

    setStateDir(stateDir);
    setDuetMode('new');
    setRunDir(stateDir);
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };

    resolveSessionPath('claude');

    const data = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(data.claude.binding_path, claudeLog);
    assert.equal(data.claude.session_id, 'claude-uuid-123');
    assert.ok(data.updated_at);
  });
});

// ─── Resume: binder resume fast-path ─────────────────────────────────────────

describe('binder resume fast-path', () => {
  const testDir = '/tmp/duet-test-binder-resume-' + process.pid;
  const stateDir = join(testDir, 'state');
  const claudeProjects = join(testDir, 'claude-projects');
  const codexSessions = join(testDir, 'codex-sessions');
  const globalCodexSessions = join(testDir, 'global-codex-sessions');

  before(() => {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    mkdirSync(codexSessions, { recursive: true });
    mkdirSync(globalCodexSessions, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runBind(env) {
    const fullEnv = sanitizedEnv({
      STATE_DIR: stateDir,
      CLAUDE_PROJECTS: claudeProjects,
      CODEX_SESSIONS: codexSessions,
      GLOBAL_CODEX_SESSIONS: globalCodexSessions,
      WORKDIR: '/test/workdir',
      BIND_TIMEOUT: '2',
      DUET_USE_SOURCE: '1',
      ...env,
    });
    try {
      execSync('bash /home/claude/duet/bind-sessions.sh', { env: fullEnv, timeout: 10000 });
    } catch {}
  }

  function cleanState() {
    try { rmSync(join(stateDir, 'bindings.json')); } catch {}
    try { execSync(`rm -rf ${claudeProjects}/* ${codexSessions}/* ${globalCodexSessions}/*`); } catch {}
  }

  it('immediately binds when RESUME_CLAUDE_PATH points to existing file', () => {
    cleanState();
    const claudeFile = join(claudeProjects, 'resume-test.jsonl');
    writeFileSync(claudeFile, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n');

    runBind({
      CLAUDE_SESSION_ID: 'resume-test',
      RESUME_CLAUDE_PATH: claudeFile,
    });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.claude.status, 'bound');
    assert.equal(bindings.claude.path, claudeFile);
    assert.equal(bindings.claude.session_id, 'resume-test');
  });

  it('immediately binds when RESUME_CODEX_PATH points to existing file', () => {
    cleanState();
    const codexFile = join(codexSessions, 'resume-codex.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session-123', cwd: '/test' } });
    writeFileSync(codexFile, meta + '\n');

    runBind({
      CLAUDE_SESSION_ID: 'nonexistent',
      RESUME_CODEX_PATH: codexFile,
    });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.path, codexFile);
    assert.equal(bindings.codex.session_id, 'codex-session-123');
  });

  it('extracts codex session_id from binding manifest', () => {
    cleanState();
    const codexFile = join(codexSessions, 'session-id-test.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'my-codex-id', cwd: '/test' } });
    writeFileSync(codexFile, meta + '\n');

    runBind({ CLAUDE_SESSION_ID: 'nonexistent' });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.codex.session_id, 'my-codex-id');
  });

  it('skips polling when both resume paths are valid', () => {
    cleanState();
    const claudeFile = join(claudeProjects, 'both-resume.jsonl');
    writeFileSync(claudeFile, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'c' }] } }) + '\n');

    const codexFile = join(codexSessions, 'both-resume-codex.jsonl');
    writeFileSync(codexFile, JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/test' } }) + '\n');

    const start = Date.now();
    runBind({
      CLAUDE_SESSION_ID: 'both-resume',
      RESUME_CLAUDE_PATH: claudeFile,
      RESUME_CODEX_PATH: codexFile,
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 1000, `Expected fast completion, took ${elapsed}ms`);

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.claude.status, 'bound');
    assert.equal(bindings.codex.status, 'bound');
  });

  it('falls through to normal discovery when resume path is invalid', () => {
    cleanState();
    const uuid = 'fallthrough-' + Date.now();
    const claudeFile = join(claudeProjects, `${uuid}.jsonl`);
    writeFileSync(claudeFile, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'found' }] } }) + '\n');

    runBind({
      CLAUDE_SESSION_ID: uuid,
      RESUME_CLAUDE_PATH: '/tmp/nonexistent-path.jsonl',
    });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.claude.status, 'bound');
    assert.equal(bindings.claude.path, claudeFile);
  });
});

// ─── Resume: fast-path session ID validation ─────────────────────────────────

describe('resume fast-path session ID validation', () => {
  const testDir = '/tmp/duet-test-fastpath-validate-' + process.pid;
  const stateDir = join(testDir, 'state');
  const claudeProjects = join(testDir, 'claude-projects');
  const codexSessions = join(testDir, 'codex-sessions');
  const globalCodexSessions = join(testDir, 'global-codex-sessions');

  before(() => {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(claudeProjects, { recursive: true });
    mkdirSync(codexSessions, { recursive: true });
    mkdirSync(globalCodexSessions, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runBind(env) {
    const fullEnv = sanitizedEnv({
      STATE_DIR: stateDir,
      CLAUDE_PROJECTS: claudeProjects,
      CODEX_SESSIONS: codexSessions,
      GLOBAL_CODEX_SESSIONS: globalCodexSessions,
      WORKDIR: '/test/workdir',
      BIND_TIMEOUT: '2',
      DUET_USE_SOURCE: '1',
      ...env,
    });
    try {
      execSync('bash /home/claude/duet/bind-sessions.sh', { env: fullEnv, timeout: 10000 });
    } catch {}
  }

  function cleanState() {
    try { rmSync(join(stateDir, 'bindings.json')); } catch {}
    try { execSync(`rm -rf ${claudeProjects}/* ${codexSessions}/* ${globalCodexSessions}/*`); } catch {}
  }

  it('rejects RESUME_CLAUDE_PATH when filename does not match CLAUDE_SESSION_ID', () => {
    cleanState();
    const wrongFile = join(claudeProjects, 'wrong-session-id.jsonl');
    writeFileSync(wrongFile, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'wrong' }] } }) + '\n');

    runBind({
      CLAUDE_SESSION_ID: 'expected-session-id',
      RESUME_CLAUDE_PATH: wrongFile,
    });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.claude.status, 'degraded');
  });

  it('accepts RESUME_CLAUDE_PATH when filename matches CLAUDE_SESSION_ID', () => {
    cleanState();
    const correctFile = join(claudeProjects, 'correct-id.jsonl');
    writeFileSync(correctFile, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'right' }] } }) + '\n');

    runBind({
      CLAUDE_SESSION_ID: 'correct-id',
      RESUME_CLAUDE_PATH: correctFile,
    });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.claude.status, 'bound');
    assert.equal(bindings.claude.path, correctFile);
  });

  it('rejects RESUME_CODEX_PATH when extracted ID does not match RESUME_CODEX_SESSION_ID', () => {
    cleanState();
    const codexFile = join(codexSessions, 'wrong-codex.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'actual-codex-id', cwd: '/test' } });
    writeFileSync(codexFile, meta + '\n');

    runBind({
      CLAUDE_SESSION_ID: 'nonexistent',
      RESUME_CODEX_PATH: codexFile,
      RESUME_CODEX_SESSION_ID: 'expected-codex-id',
    });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.session_id, 'actual-codex-id');
  });

  it('accepts RESUME_CODEX_PATH when no RESUME_CODEX_SESSION_ID is set', () => {
    cleanState();
    const codexFile = join(codexSessions, 'no-expected-id.jsonl');
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'some-id', cwd: '/test' } });
    writeFileSync(codexFile, meta + '\n');

    const start = Date.now();
    runBind({
      CLAUDE_SESSION_ID: 'nonexistent',
      RESUME_CODEX_PATH: codexFile,
    });
    const elapsed = Date.now() - start;

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.session_id, 'some-id');
  });
});

// ─── Resume: updateRunJson ───────────────────────────────────────────────────

describe('updateRunJson', () => {
  const runDir = '/tmp/duet-test-runjson-' + process.pid;
  const runJson = join(runDir, 'run.json');

  before(() => {
    mkdirSync(runDir, { recursive: true });
  });

  after(() => {
    setRunDir(null);
    rmSync(runDir, { recursive: true, force: true });
  });

  it('creates run.json if it does not exist', () => {
    try { rmSync(runJson); } catch {}
    setRunDir(runDir);
    updateRunJson({ status: 'active', cwd: '/test' });
    const data = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(data.status, 'active');
    assert.equal(data.cwd, '/test');
  });

  it('merges into existing run.json', () => {
    writeFileSync(runJson, JSON.stringify({ run_id: 'abc', status: 'active' }));
    setRunDir(runDir);
    updateRunJson({ status: 'stopped', updated_at: '2026-01-01' });
    const data = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(data.run_id, 'abc');
    assert.equal(data.status, 'stopped');
    assert.equal(data.updated_at, '2026-01-01');
  });

  it('handles dotted keys for nested updates', () => {
    writeFileSync(runJson, JSON.stringify({ run_id: 'abc', claude: { session_id: 'old' } }));
    setRunDir(runDir);
    updateRunJson({ 'claude.binding_path': '/path/to/file.jsonl' });
    const data = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(data.claude.session_id, 'old');
    assert.equal(data.claude.binding_path, '/path/to/file.jsonl');
  });

  it('does nothing when run dir is null', () => {
    setRunDir(null);
    updateRunJson({ status: 'should-not-write' });
  });
});

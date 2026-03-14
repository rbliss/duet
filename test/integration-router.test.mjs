import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { parseInput, sessionState, handleNewOutput, lastAutoRelayTime, findRebindCandidate, rebindTool, stopFileWatchers, extractCodexSessionId, watcherFailed, setStateDir, setRunDir, collectDebugSnapshot, renderDebugReport, getRouterState } from '../router.mjs';

// Read all router source files (equivalent to the old monolithic router.mjs)
function readRouterSource() {
  return [
    readFileSync('/home/claude/duet/src/router/commands.ts', 'utf8'),
    readFileSync('/home/claude/duet/src/router/state.ts', 'utf8'),
    readFileSync('/home/claude/duet/src/router/controller.ts', 'utf8'),
  ].join('\n');
}

// ─── Per-direction relay cooldown ─────────────────────────────────────────────

describe('per-direction relay cooldown', () => {
  beforeEach(() => {
    for (const key of Object.keys(lastAutoRelayTime)) {
      delete lastAutoRelayTime[key];
    }
  });

  it('allows claude->codex followed by codex->claude within cooldown window', () => {
    const now = Date.now();
    lastAutoRelayTime['claude->codex'] = now;

    handleNewOutput('codex', '@claude Got it, looks good!');

    assert.ok(lastAutoRelayTime['claude->codex'] > 0, 'claude->codex cooldown should still be set');
  });

  it('blocks same-direction relay within cooldown window', () => {
    const now = Date.now();
    lastAutoRelayTime['claude->codex'] = now;

    handleNewOutput('claude', 'Hey @codex, second message');

    assert.equal(lastAutoRelayTime['claude->codex'], now,
      'same-direction relay should be blocked within cooldown');
  });
});

// ─── Stale binding detection and /rebind ──────────────────────────────────────

describe('stale binding detection', () => {
  it('/rebind claude parses correctly', () => {
    const result = parseInput('/rebind claude');
    assert.deepStrictEqual(result, { type: 'rebind', target: 'claude' });
  });

  it('/rebind codex parses correctly', () => {
    const result = parseInput('/rebind codex');
    assert.deepStrictEqual(result, { type: 'rebind', target: 'codex' });
  });

  it('sessionState includes activity tracking field', () => {
    assert.ok('lastSessionActivityAt' in sessionState.claude);
    assert.ok('lastSessionActivityAt' in sessionState.codex);
  });

  it('/rebind is the supported repair path for stale bindings', () => {
    const src = readRouterSource();
    assert.ok(src.includes('/rebind'));
    assert.ok(src.includes('rebindTool'));
    assert.ok(src.includes('findRebindCandidate'));
  });
});

describe('rebind candidate search', () => {
  const testDir = '/tmp/duet-test-rebind-' + process.pid;

  before(() => {
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    stopFileWatchers();
    rmSync(testDir, { recursive: true, force: true });
    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.relayMode = 'pending';
    sessionState.claude.lastSessionActivityAt = 0;
    sessionState.codex.path = null;
    sessionState.codex.resolved = false;
    sessionState.codex.relayMode = 'pending';
  });

  it('finds newer .jsonl file as rebind candidate', () => {
    const staleFile = join(testDir, 'aaaa-stale.jsonl');
    const freshFile = join(testDir, 'bbbb-fresh.jsonl');
    writeFileSync(staleFile, '{"old": true}\n');
    execSync('sleep 0.1');
    writeFileSync(freshFile, '{"new": true}\n');

    sessionState.claude.path = staleFile;
    sessionState.claude.resolved = true;

    const candidate = findRebindCandidate('claude');
    assert.equal(candidate, freshFile);
  });

  it('returns null when no other .jsonl files exist', () => {
    const onlyFile = join(testDir, 'only.jsonl');
    writeFileSync(onlyFile, '{"only": true}\n');

    for (const f of readdirSync(testDir)) {
      if (f !== 'only.jsonl') rmSync(join(testDir, f));
    }

    sessionState.claude.path = onlyFile;
    sessionState.claude.resolved = true;

    const candidate = findRebindCandidate('claude');
    assert.equal(candidate, null);
  });

  it('rebindTool updates session state and seeks to EOF', async () => {
    const newFile = join(testDir, '12345678-abcd-1234-abcd-123456789012.jsonl');
    writeFileSync(newFile, '{"line": 1}\n{"line": 2}\n');

    const staleFile = join(testDir, 'stale.jsonl');
    writeFileSync(staleFile, '{"stale": true}\n');
    sessionState.claude.path = staleFile;
    sessionState.claude.resolved = true;
    sessionState.claude.relayMode = 'pane';

    const runDir = join(testDir, 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), '{}');
    setRunDir(runDir);

    const result = await rebindTool('claude', newFile);

    assert.equal(result.newPath, newFile);
    assert.equal(result.newSid, '12345678-abcd-1234-abcd-123456789012');
    assert.equal(sessionState.claude.path, newFile);
    assert.equal(sessionState.claude.relayMode, 'session');
    const { size } = statSync(newFile);
    assert.equal(sessionState.claude.offset, size);

    const rj = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    assert.equal(rj.claude.binding_path, newFile);
    assert.equal(rj.claude.session_id, '12345678-abcd-1234-abcd-123456789012');

    setRunDir(null);
  });

  it('works for codex too', () => {
    for (const f of readdirSync(testDir)) {
      if (f.endsWith('.jsonl')) rmSync(join(testDir, f));
    }

    const staleFile = join(testDir, 'codex-stale.jsonl');
    const freshFile = join(testDir, 'codex-fresh.jsonl');
    writeFileSync(staleFile, '{"old": true}\n');
    execSync('sleep 0.1');
    writeFileSync(freshFile, '{"new": true}\n');

    sessionState.codex.path = staleFile;
    sessionState.codex.resolved = true;

    const candidate = findRebindCandidate('codex');
    assert.equal(candidate, freshFile);

    sessionState.codex.path = null;
    sessionState.codex.resolved = false;
  });
});

describe('help text includes /rebind', () => {
  it('router help text mentions /rebind', () => {
    const src = readRouterSource();
    assert.ok(src.includes('/rebind claude|codex'));
    assert.ok(src.includes('Re-discover session'));
  });
});

// ─── Fix 1: Codex rebind uses payload.id, not filename ───────────────────────

describe('codex rebind session ID extraction', () => {
  const testDir = '/tmp/duet-test-rebind-sid-' + process.pid;
  const stateDir = join(testDir, 'state');
  const runDir = join(testDir, 'run');

  before(() => {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
    setRunDir(null);
    setStateDir(null);
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0 };
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0 };
  });

  it('extractCodexSessionId reads payload.id from first JSONL line', () => {
    const file = join(testDir, 'codex-session.jsonl');
    writeFileSync(file, '{"payload":{"id":"real-codex-session-id-001","type":"session_start"}}\n{"payload":{"type":"message"}}\n');
    assert.equal(extractCodexSessionId(file), 'real-codex-session-id-001');
  });

  it('extractCodexSessionId returns null for missing payload.id', () => {
    const file = join(testDir, 'codex-noid.jsonl');
    writeFileSync(file, '{"payload":{"type":"session_start"}}\n');
    assert.equal(extractCodexSessionId(file), null);
  });

  it('extractCodexSessionId returns null for missing file', () => {
    assert.equal(extractCodexSessionId('/nonexistent/path.jsonl'), null);
  });

  it('rebindTool for codex writes payload.id to run.json, not filename', async () => {
    setRunDir(runDir);
    writeFileSync(join(runDir, 'run.json'), '{}');

    const staleFile = join(testDir, 'stale-codex.jsonl');
    const freshFile = join(testDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    writeFileSync(staleFile, '{"old":true}\n');
    writeFileSync(freshFile, '{"payload":{"id":"actual-codex-session-42","type":"session_start"}}\n');

    sessionState.codex.path = staleFile;
    sessionState.codex.resolved = true;
    sessionState.codex.relayMode = 'session';

    const { newSid } = await rebindTool('codex', freshFile);
    stopFileWatchers();

    assert.equal(newSid, 'actual-codex-session-42');
    const rj = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    assert.equal(rj.codex.session_id, 'actual-codex-session-42');

    sessionState.codex.path = null;
    sessionState.codex.resolved = false;
    setRunDir(null);
  });

  it('rebindTool for claude still uses filename UUID', async () => {
    setRunDir(runDir);
    writeFileSync(join(runDir, 'run.json'), '{}');

    const staleFile = join(testDir, 'claude-stale.jsonl');
    const freshFile = join(testDir, '12345678-aaaa-bbbb-cccc-111111111111.jsonl');
    writeFileSync(staleFile, '{"old":true}\n');
    writeFileSync(freshFile, '{"message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n');

    sessionState.claude.path = staleFile;
    sessionState.claude.resolved = true;
    sessionState.claude.relayMode = 'session';

    const { newSid } = await rebindTool('claude', freshFile);
    stopFileWatchers();

    assert.equal(newSid, '12345678-aaaa-bbbb-cccc-111111111111');
    const rj = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    assert.equal(rj.claude.session_id, '12345678-aaaa-bbbb-cccc-111111111111');

    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    setRunDir(null);
  });
});

// ─── Fix 2: Watcher failure visibility ───────────────────────────────────────

describe('watcher failure visibility', () => {
  it('watcherFailed is exported and starts empty', () => {
    assert.ok(watcherFailed instanceof Set);
  });

  it('startup reports watcher failure instead of active', () => {
    const src = readRouterSource();
    assert.ok(src.includes('watcherFailed.add(name)'), 'startPolling should track watcher failures');
    assert.ok(src.includes("watcher failed"), 'should report watcher failure');
  });

  it('/status shows inactive when watcher failed for bound tool', () => {
    const src = readRouterSource();
    const statusBlock = src.slice(src.indexOf("case 'status':"), src.indexOf("case 'status':") + 1200);
    assert.ok(statusBlock.includes('watcherFailed.has(tool)'), '/status must check watcherFailed');
  });

  it('/watch shows watcher failure when watcher failed for bound tool', () => {
    const src = readRouterSource();
    const watchBlock = src.slice(src.indexOf("case 'watch':"), src.indexOf("case 'watch':") + 1200);
    assert.ok(watchBlock.includes('watcherFailed.has(tool)'), '/watch must check watcherFailed');
    assert.ok(watchBlock.includes('watcher failed'), '/watch should show watcher failed');
  });

  it('watcher error handler adds to watcherFailed set', () => {
    const src = readRouterSource();
    const errorBlock = src.slice(src.indexOf("on('error'"), src.indexOf("on('error'") + 300);
    assert.ok(errorBlock.includes('watcherFailed.add(tool)'), 'watcher error should add to watcherFailed');
  });

  it('rebindTool clears watcherFailed on successful watcher start', () => {
    const src = readRouterSource();
    const rebindBlock = src.slice(src.indexOf('export async function rebindTool'), src.indexOf('export async function rebindTool') + 1000);
    assert.ok(rebindBlock.includes('watcherFailed.delete(tool)'), 'rebindTool should clear watcherFailed');
  });

  it('pollBindings marks tool as watcherFailed when watcher startup fails after late binding', () => {
    const src = readRouterSource();
    const pollBlock = src.slice(src.indexOf('function pollBindings()'), src.indexOf('function pollBindings()') + 800);
    assert.ok(pollBlock.includes('pendingTools.delete(name)'), 'should remove from pendingTools on binding resolution');
    assert.ok(pollBlock.includes('watcherFailed.add(name)'), 'should add to watcherFailed when watcher fails');
    assert.ok(pollBlock.includes('watcher failed'), 'should log watcher failure');
    const deleteIdx = pollBlock.indexOf('pendingTools.delete(name)');
    const watcherAddIdx = pollBlock.indexOf('watcherFailed.add(name)');
    assert.ok(deleteIdx < watcherAddIdx, 'pendingTools removal must precede watcherFailed addition');
  });
});

// ─── Fix 3: Transport delivery failure handling ──────────────────────────────

describe('transport delivery failure handling', () => {
  it('direct commands check send result and support multiline', () => {
    const src = readRouterSource();
    const claudeBlock = src.slice(src.indexOf("case 'claude':"), src.indexOf("case 'claude':") + 400);
    assert.ok(claudeBlock.includes('pasteToPane') && claudeBlock.includes('sendKeys'), '@claude should use pasteToPane for multiline and sendKeys for single-line');
    assert.ok(claudeBlock.includes('Failed to send'), '@claude should report delivery failure');
    const codexBlock = src.slice(src.indexOf("case 'codex':"), src.indexOf("case 'codex':") + 400);
    assert.ok(codexBlock.includes('pasteToPane') && codexBlock.includes('sendKeys'), '@codex should use pasteToPane for multiline and sendKeys for single-line');
    assert.ok(codexBlock.includes('Failed to send'), '@codex should report delivery failure');
  });

  it('@both checks both sendKeys results', () => {
    const src = readRouterSource();
    const bothBlock = src.slice(src.indexOf("case 'both':"), src.indexOf("case 'both':") + 600);
    assert.ok(bothBlock.includes('Promise.all'), '@both should send in parallel');
    assert.ok(bothBlock.includes('Failed to send'), '@both should report failure');
  });

  it('@both hints about /watch when auto-relay is off', () => {
    const src = readRouterSource();
    const bothBlock = src.slice(src.indexOf("case 'both':"), src.indexOf("case 'both':") + 600);
    assert.ok(bothBlock.includes('isWatching'), '@both should check watch state');
    assert.ok(bothBlock.includes('/watch'), '@both should mention /watch when auto-relay is off');
  });

  it('@relay checks pasteToPane result', () => {
    const src = readRouterSource();
    const relayBlock = src.slice(src.indexOf("case 'relay':"), src.indexOf("case 'relay':") + 1000);
    assert.ok(relayBlock.includes('await pasteToPane') && relayBlock.includes('Failed to relay'), '@relay should check delivery');
  });

  it('converse does not advance turn on failed delivery', () => {
    const src = readRouterSource();
    const converseBlock = src.slice(src.indexOf('Converse mode auto-relay'), src.indexOf('Converse mode auto-relay') + 1200);
    assert.ok(converseBlock.includes('converseState.rounds--'), 'should decrement round on failure');
    assert.ok(converseBlock.includes('turn not advanced'), 'should log turn not advanced');
    const failBlock = converseBlock.slice(converseBlock.indexOf('!delivered'), converseBlock.indexOf('!delivered') + 300);
    assert.ok(!failBlock.includes('converseState.turn = other'), 'turn must not advance on failed delivery');
  });

  it('watch-mode cooldown not recorded on failed delivery', () => {
    const src = readRouterSource();
    const mentionBlock = src.slice(src.indexOf('@mention detection'), src.indexOf('@mention detection') + 1000);
    assert.ok(mentionBlock.includes('if (delivered)'), 'cooldown should be conditional on delivery');
    assert.ok(mentionBlock.includes('delivery to ${other} failed'), 'should log failed auto-relay delivery');
  });

  it('/converse sets converseState only after successful opener delivery', () => {
    const src = readRouterSource();
    const converseStart = src.slice(src.indexOf("case 'converse':"), src.indexOf("case 'converse':") + 1200);
    assert.ok(converseStart.includes('Failed to deliver opener'), '/converse should check opener delivery');
    const pasteIdx = converseStart.indexOf('await pasteToPane');
    const stateIdx = converseStart.indexOf('setConverseState({');
    assert.ok(pasteIdx > 0 && stateIdx > 0, 'both pasteToPane and setConverseState must exist');
    assert.ok(stateIdx > pasteIdx, `setConverseState must be set after delivery (paste@${pasteIdx}, state@${stateIdx})`);
  });

  it('/converse delivers opener to codex and sets initial turn to codex', () => {
    const src = readRouterSource();
    const converseStart = src.slice(src.indexOf("case 'converse':"), src.indexOf("case 'converse':") + 1200);
    assert.ok(converseStart.includes('PANES.codex'), 'opener should be delivered to codex pane');
    assert.ok(!converseStart.includes('PANES.claude'), 'opener should not be delivered to claude pane');
    assert.ok(converseStart.includes("turn: 'codex'"), 'initial turn should be codex');
    assert.ok(converseStart.includes('@claude'), 'opener text should mention @claude');
  });
});

// ─── Phase 3-5: session-only automation, explicit binding, no pane fallback ──

describe('session-only automation', () => {
  it('router no longer uses capture-pane for automation relay', () => {
    const src = readRouterSource();
    const lines = src.split('\n');
    const callLines = lines.filter(l => {
      const trimmed = l.trim();
      return trimmed.includes('capturePane(') &&
        !trimmed.startsWith('import') && !trimmed.startsWith('export') &&
        !trimmed.startsWith('//');
    });
    for (const line of callLines) {
      assert.ok(
        line.includes('parsed.target') || line.includes('parsed.lines') || line.includes('PANES.claude') || line.includes('PANES.codex'),
        `capturePane called outside /snap or /debug: ${line.trim()}`
      );
    }
  });

  it('router source does not contain removed dead code', () => {
    const src = readRouterSource();
    assert.ok(!src.includes('getCleanResponse'), 'getCleanResponse should be removed');
    assert.ok(!src.includes('getNewContent'), 'getNewContent should be removed');
    assert.ok(!src.includes('cleanCapture'), 'cleanCapture should be removed');
  });

  it('handleNewOutput uses session response, not pane capture', () => {
    const src = readRouterSource();
    const start = src.indexOf('async function handleNewOutput');
    const handleBlock = src.slice(start, src.indexOf('// ─── Banner', start));
    assert.ok(handleBlock.includes('getSessionResponse'), 'should use getSessionResponse');
    assert.ok(!handleBlock.includes('capturePane'), 'should not use capturePane');
  });
});

describe('explicit binding enforcement', () => {
  it('/converse requires both tools to be bound', () => {
    const src = readRouterSource();
    const converseBlock = src.slice(
      src.indexOf("case 'converse':"),
      src.indexOf("case 'converse':") + 800
    );
    assert.ok(converseBlock.includes('both tools must be session-bound'),
      '/converse should check that both tools are bound');
  });

  it('@relay requires source to be bound', () => {
    const src = readRouterSource();
    const relayBlock = src.slice(
      src.indexOf("case 'relay':"),
      src.indexOf("case 'relay':") + 600
    );
    assert.ok(relayBlock.includes('not session-bound'),
      '@relay should check source binding');
  });

  it('@relay uses getSessionResponse only (no pane fallback)', () => {
    const src = readRouterSource();
    const relayBlock = src.slice(
      src.indexOf("case 'relay':"),
      src.indexOf("case 'relay':") + 600
    );
    assert.ok(relayBlock.includes('getSessionResponse'),
      '@relay should use getSessionResponse');
    assert.ok(!relayBlock.includes('capturePane'),
      '@relay should not use capturePane');
  });

  it('@relay errors when no structured response available', () => {
    const src = readRouterSource();
    const relayBlock = src.slice(
      src.indexOf("case 'relay':"),
      src.indexOf("case 'relay':") + 600
    );
    assert.ok(relayBlock.includes('No structured response available'),
      '@relay should show error when no response available');
  });
});

describe('/watch and /status messaging', () => {
  it('/watch reports per-tool binding status', () => {
    const src = readRouterSource();
    const watchBlock = src.slice(
      src.indexOf("case 'watch':"),
      src.indexOf("case 'watch':") + 1200
    );
    assert.ok(watchBlock.includes('bindingStatus'), '/watch should check binding status');
    assert.ok(watchBlock.includes('ready'), '/watch should report ready for bound');
    assert.ok(watchBlock.includes('pending'), '/watch should report pending for unbound');
    assert.ok(watchBlock.includes('unavailable'), '/watch should report unavailable for degraded');
  });

  it('/status shows binding state and monitoring/auto-relay status', () => {
    const src = readRouterSource();
    const statusBlock = src.slice(
      src.indexOf("case 'status':"),
      src.indexOf("case 'status':") + 2000
    );
    assert.ok(statusBlock.includes('bindingStatus'), '/status should show binding status');
    assert.ok(statusBlock.includes('monitoring:'), '/status should show monitoring state');
    assert.ok(statusBlock.includes('isWatching'), '/status should check auto-relay state');
  });

  it('no stale auto-downgrade remains', () => {
    const src = readRouterSource();
    assert.ok(!src.includes('downgradeToPane'), 'downgradeToPane should be removed');
    assert.ok(!src.includes('staleDowngraded'), 'staleDowngraded should be removed');
    assert.ok(!src.includes('STALE_BINDING_MS'), 'No stale binding constant should remain');
    assert.ok(!src.includes('PANE_STABLE_TICKS'), 'No pane stable ticks constant should remain');
  });

  it('capturePane is only used for diagnostics (/snap and /debug)', () => {
    const src = readRouterSource();
    const lines = src.split('\n');
    const usageLines = lines.filter(l =>
      l.includes('capturePane(') && !l.includes('import') && !l.includes('export'));
    assert.ok(usageLines.length > 0, 'capturePane should still exist for diagnostics');
    for (const line of usageLines) {
      assert.ok(
        line.includes('parsed.target') || line.includes('parsed.lines') || line.includes('PANES.claude') || line.includes('PANES.codex'),
        `capturePane used outside diagnostics: ${line.trim()}`
      );
    }
  });
});

// ─── Unit Tests: debug snapshot API ──────────────────────────────────────────

describe('collectDebugSnapshot', () => {
  it('returns a well-shaped snapshot with all required fields', () => {
    const mockSessionState = {
      claude: { path: '/tmp/claude.jsonl', resolved: true, offset: 100, lastResponse: 'hello', relayMode: 'session', bindingLevel: 'process', lastSessionActivityAt: Date.now() },
      codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0 },
    };
    const mockRouterState = {
      watching: true,
      converseState: null,
      pendingTools: ['codex'],
      watcherFailed: [],
      fileWatcherActive: { claude: true, codex: false },
    };
    const snapshot = collectDebugSnapshot({
      sessionState: mockSessionState,
      routerState: mockRouterState,
      bindings: { claude: { status: 'bound', level: 'process', path: '/tmp/claude.jsonl', session_id: 'c-id' }, codex: { status: 'pending' } },
      runJson: { run_id: 'test-123', cwd: '/tmp', status: 'running', tmux_session: 'duet-test', claude: { session_id: 'c-id', binding_path: '/tmp/claude.jsonl' }, codex: { session_id: 'x-id' } },
    });

    assert.equal(typeof snapshot.timestamp, 'string');
    assert.ok(snapshot.run);
    assert.equal(snapshot.run.run_id, 'test-123');
    assert.ok(snapshot.router);
    assert.equal(snapshot.router.watching, true);
    assert.equal(snapshot.router.converseActive, false);
    assert.deepEqual(snapshot.router.pendingTools, ['codex']);
    assert.ok(snapshot.tools.claude);
    assert.ok(snapshot.tools.codex);
    assert.equal(snapshot.tools.claude.bindingStatus, 'bound');
    assert.equal(snapshot.tools.claude.relayMode, 'session');
    assert.equal(snapshot.tools.claude.watcherActive, true);
    assert.equal(snapshot.tools.codex.bindingStatus, 'pending');
    assert.equal(snapshot.tools.codex.pending, true);
    assert.equal(snapshot.tools.claude.runJson.session_id, 'c-id');
    assert.equal(snapshot.tools.claude.runJson.binding_path, '/tmp/claude.jsonl');
    assert.equal(snapshot.tools.codex.runJson.session_id, 'x-id');
    assert.equal(snapshot.tools.claude.manifest.status, 'bound');
    assert.equal(snapshot.tools.claude.manifest.level, 'process');
    assert.equal(snapshot.tools.claude.manifest.session_id, 'c-id');
    assert.equal(snapshot.tools.codex.manifest.status, 'pending');
  });

  it('normalizes relayMode to user-facing status', () => {
    const mockSessionState = {
      claude: { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'session', bindingLevel: null, lastSessionActivityAt: 0 },
      codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
    };
    const snapshot = collectDebugSnapshot({
      sessionState: mockSessionState,
      routerState: { watching: false, converseState: null, pendingTools: [], watcherFailed: [], fileWatcherActive: { claude: false, codex: false } },
      bindings: null,
      runJson: null,
    });
    assert.equal(snapshot.tools.claude.bindingStatus, 'bound', 'session relayMode normalizes to bound');
    assert.equal(snapshot.tools.codex.bindingStatus, 'degraded', 'pane relayMode normalizes to degraded');
  });

  it('truncates long response previews', () => {
    const longResponse = 'x'.repeat(1000);
    const mockSessionState = {
      claude: { path: null, resolved: false, offset: 0, lastResponse: longResponse, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
      codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
    };
    const snapshot = collectDebugSnapshot({
      sessionState: mockSessionState,
      routerState: { watching: false, converseState: null, pendingTools: [], watcherFailed: [], fileWatcherActive: { claude: false, codex: false } },
      bindings: null,
      runJson: null,
    });
    assert.ok(snapshot.tools.claude.lastResponsePreview.length < longResponse.length);
    assert.ok(snapshot.tools.claude.lastResponsePreview.includes('more chars'));
  });

  it('includes converse state when active', () => {
    const mockSessionState = {
      claude: { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
      codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
    };
    const snapshot = collectDebugSnapshot({
      sessionState: mockSessionState,
      routerState: {
        watching: true,
        converseState: { topic: 'test topic', rounds: 3, maxRounds: 10, turn: 'codex' },
        pendingTools: [],
        watcherFailed: [],
        fileWatcherActive: { claude: false, codex: false },
      },
      bindings: null,
      runJson: null,
    });
    assert.equal(snapshot.router.converseActive, true);
    assert.equal(snapshot.router.converse.topic, 'test topic');
    assert.equal(snapshot.router.converse.round, 3);
    assert.equal(snapshot.router.converse.turn, 'codex');
  });

  it('does not include pane captures by default', () => {
    const mockSessionState = {
      claude: { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
      codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
    };
    const snapshot = collectDebugSnapshot({
      sessionState: mockSessionState,
      routerState: { watching: false, converseState: null, pendingTools: [], watcherFailed: [], fileWatcherActive: { claude: false, codex: false } },
      bindings: null,
      runJson: null,
    });
    assert.equal(snapshot.paneCaptures, null);
  });

  it('marks watcher failed status correctly', () => {
    const mockSessionState = {
      claude: { path: '/tmp/c.jsonl', resolved: true, offset: 0, lastResponse: null, relayMode: 'session', bindingLevel: 'process', lastSessionActivityAt: 0 },
      codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
    };
    const snapshot = collectDebugSnapshot({
      sessionState: mockSessionState,
      routerState: { watching: true, converseState: null, pendingTools: [], watcherFailed: ['claude'], fileWatcherActive: { claude: false, codex: false } },
      bindings: null,
      runJson: null,
    });
    assert.equal(snapshot.tools.claude.watcherFailed, true);
    assert.equal(snapshot.tools.claude.watcherActive, false);
  });
});

describe('renderDebugReport', () => {
  it('renders a bounded string with key sections and cross-file state', () => {
    const snapshot = collectDebugSnapshot({
      sessionState: {
        claude: { path: '/tmp/c.jsonl', resolved: true, offset: 42, lastResponse: 'test reply', relayMode: 'session', bindingLevel: 'process', lastSessionActivityAt: Date.now() },
        codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0 },
      },
      routerState: { watching: true, converseState: null, pendingTools: ['codex'], watcherFailed: [], fileWatcherActive: { claude: true, codex: false } },
      bindings: { claude: { status: 'bound', level: 'process', path: '/tmp/c.jsonl', session_id: 'sid-c' }, codex: { status: 'pending' } },
      runJson: { run_id: 'r-1', cwd: '/test', status: 'running', tmux_session: 'duet-1', claude: { session_id: 'sid-c', binding_path: '/tmp/c.jsonl' }, codex: {} },
    });
    const report = renderDebugReport(snapshot);

    assert.ok(report.includes('DUET DEBUG SNAPSHOT'));
    assert.ok(report.includes('r-1'));
    assert.ok(report.includes('[claude]'));
    assert.ok(report.includes('[codex]'));
    assert.ok(report.includes('watching'));
    assert.ok(report.includes('test reply'));
    assert.ok(report.includes('Pending: codex'));
    assert.ok(report.includes('run.json'), 'report should render run.json section');
    assert.ok(report.includes('bindings'), 'report should render bindings.json section');
    assert.ok(report.includes('live'), 'report should render live state section');
    assert.ok(report.includes('sid-c'), 'report should show session ID from run.json/bindings');
    assert.ok(report.includes('/tmp/c.jsonl'), 'report should show binding path');
    assert.ok(report.includes('bound'), 'report should show normalized bound status');
    assert.ok(!report.includes('status: session\n'), 'report should not show raw session as status label');
  });

  it('report does not contain raw env vars or secrets', () => {
    process.env.SECRET_KEY = 'super-secret-123';
    const snapshot = collectDebugSnapshot({
      sessionState: {
        claude: { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
        codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
      },
      routerState: { watching: false, converseState: null, pendingTools: [], watcherFailed: [], fileWatcherActive: { claude: false, codex: false } },
      bindings: null,
      runJson: null,
    });
    const report = renderDebugReport(snapshot);
    assert.ok(!report.includes('super-secret-123'), 'report must not contain env var values');
    delete process.env.SECRET_KEY;
  });

  it('report has bounded size even with full mode pane captures', () => {
    const longCapture = ('A'.repeat(200) + '\n').repeat(100);
    const snapshot = collectDebugSnapshot({
      sessionState: {
        claude: { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
        codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
      },
      routerState: { watching: false, converseState: null, pendingTools: [], watcherFailed: [], fileWatcherActive: { claude: false, codex: false } },
      bindings: null,
      runJson: null,
      paneCaptures: { claude: longCapture, codex: longCapture },
    });
    const report = renderDebugReport(snapshot);
    const captureLines = report.split('\n').filter(l => l.startsWith('  A'));
    assert.ok(captureLines.length <= 60, `expected at most 60 capture lines, got ${captureLines.length}`);
  });

  it('shows watcher failed as unhealthy in report', () => {
    const snapshot = collectDebugSnapshot({
      sessionState: {
        claude: { path: '/tmp/c.jsonl', resolved: true, offset: 0, lastResponse: null, relayMode: 'session', bindingLevel: 'process', lastSessionActivityAt: 0 },
        codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
      },
      routerState: { watching: true, converseState: null, pendingTools: [], watcherFailed: ['claude'], fileWatcherActive: { claude: false, codex: false } },
      bindings: null,
      runJson: null,
    });
    const report = renderDebugReport(snapshot);
    assert.ok(report.includes('watcher FAILED'), 'bound + watcher failed must look unhealthy');
    assert.ok(report.includes('watcher FAILED'), 'must indicate watcher failed');
  });

  it('renders degraded status instead of pane', () => {
    const snapshot = collectDebugSnapshot({
      sessionState: {
        claude: { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
        codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pane', bindingLevel: null, lastSessionActivityAt: 0 },
      },
      routerState: { watching: false, converseState: null, pendingTools: [], watcherFailed: [], fileWatcherActive: { claude: false, codex: false } },
      bindings: { claude: { status: 'degraded' }, codex: { status: 'degraded' } },
      runJson: null,
    });
    const report = renderDebugReport(snapshot);
    assert.ok(report.includes('degraded'), 'report should show degraded, not pane');
    assert.ok(!report.includes('status: pane'), 'report must not show raw pane label');
  });
});

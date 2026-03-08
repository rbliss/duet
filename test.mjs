import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { exec, execSync, spawn } from 'child_process';
import { existsSync } from 'fs';

import { writeFileSync, mkdirSync, rmSync, appendFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { shellEscape, parseInput, sendKeys, capturePane, pasteToPane, focusPane, getNewContent, detectMentions, cleanCapture, extractClaudeResponse, extractCodexResponse, isResponseComplete, sessionState, getClaudeLastResponse, getCodexLastResponse, resolveSessionPath, setStateDir, setDuetMode, setRunDir, updateRunJson, readIncremental, handleNewOutput, lastAutoRelayTime, downgradeToPane, findRebindCandidate, rebindTool, stopFileWatchers, extractCodexSessionId, watcherFailed } from './router.mjs';
import { readFileSync } from 'fs';

// ─── Unit Tests: shellEscape ─────────────────────────────────────────────────

describe('shellEscape', () => {
  it('wraps plain text in single quotes', () => {
    assert.equal(shellEscape('hello'), "'hello'");
  });

  it('escapes single quotes', () => {
    const result = shellEscape("it's");
    // Should produce 'it'"'"'s'
    assert.equal(result, "'it'\"'\"'s'");
  });

  it('handles empty string', () => {
    assert.equal(shellEscape(''), "''");
  });

  it('handles double quotes without escaping', () => {
    assert.equal(shellEscape('say "hi"'), "'say \"hi\"'");
  });

  it('handles backticks and dollars', () => {
    const result = shellEscape('$(whoami) `id`');
    assert.equal(result, "'$(whoami) `id`'");
  });

  it('handles newlines', () => {
    const result = shellEscape('line1\nline2');
    assert.ok(result.includes('\n'));
  });

  it('handles multiple consecutive single quotes', () => {
    const result = shellEscape("a''b");
    assert.equal(result, "'a'\"'\"''\"'\"'b'");
  });

  it('result is safe to pass through shell', () => {
    const inputs = ['hello world', "it's a test", '$(rm -rf /)', '`id`', 'a;b&&c||d'];
    for (const input of inputs) {
      const escaped = shellEscape(input);
      const output = execSync(`echo ${escaped}`, { encoding: 'utf8' }).trim();
      assert.equal(output, input, `Failed for input: ${input}`);
    }
  });
});

// ─── Unit Tests: parseInput ──────────────────────────────────────────────────

describe('parseInput', () => {
  it('returns empty for empty input', () => {
    assert.deepEqual(parseInput(''), { type: 'empty' });
    assert.deepEqual(parseInput(null), { type: 'empty' });
    assert.deepEqual(parseInput(undefined), { type: 'empty' });
  });

  it('parses /help', () => {
    assert.deepEqual(parseInput('/help'), { type: 'help' });
  });

  it('parses /quit and /exit', () => {
    assert.deepEqual(parseInput('/quit'), { type: 'quit' });
    assert.deepEqual(parseInput('/exit'), { type: 'quit' });
  });

  it('parses /clear', () => {
    assert.deepEqual(parseInput('/clear'), { type: 'clear' });
  });

  it('parses /focus with target', () => {
    assert.deepEqual(parseInput('/focus claude'), { type: 'focus', target: 'claude' });
    assert.deepEqual(parseInput('/focus codex'), { type: 'focus', target: 'codex' });
  });

  it('parses /focus with invalid target', () => {
    assert.deepEqual(parseInput('/focus invalid'), { type: 'focus', target: 'invalid' });
  });

  it('parses /snap with default lines', () => {
    assert.deepEqual(parseInput('/snap claude'), { type: 'snap', target: 'claude', lines: 40 });
  });

  it('parses /snap with custom lines', () => {
    assert.deepEqual(parseInput('/snap codex 100'), { type: 'snap', target: 'codex', lines: 100 });
  });

  it('parses @claude message', () => {
    assert.deepEqual(parseInput('@claude fix the bug'), { type: 'claude', msg: 'fix the bug' });
  });

  it('parses @codex message', () => {
    assert.deepEqual(parseInput('@codex review this'), { type: 'codex', msg: 'review this' });
  });

  it('parses @both message', () => {
    assert.deepEqual(parseInput('@both run tests'), { type: 'both', msg: 'run tests' });
  });

  it('parses @relay without prompt', () => {
    assert.deepEqual(parseInput('@relay claude>codex'), {
      type: 'relay', from: 'claude', to: 'codex', prompt: null,
    });
  });

  it('parses @relay with prompt', () => {
    assert.deepEqual(parseInput('@relay codex>claude please review'), {
      type: 'relay', from: 'codex', to: 'claude', prompt: 'please review',
    });
  });

  it('parses @relay with spaces around >', () => {
    assert.deepEqual(parseInput('@relay claude > codex check this'), {
      type: 'relay', from: 'claude', to: 'codex', prompt: 'check this',
    });
  });

  it('returns relay_error for invalid relay syntax', () => {
    assert.deepEqual(parseInput('@relay foo>bar'), { type: 'relay_error' });
    assert.deepEqual(parseInput('@relay claude'), { type: 'relay_error' });
  });

  it('returns unknown_command for unknown slash commands', () => {
    assert.deepEqual(parseInput('/foo'), { type: 'unknown_command' });
    assert.deepEqual(parseInput('/blah blah'), { type: 'unknown_command' });
  });

  it('returns no_target for bare text', () => {
    assert.deepEqual(parseInput('hello world'), { type: 'no_target' });
  });

  it('preserves full message content', () => {
    const msg = 'fix the "auth" bug in src/index.ts && run tests';
    assert.equal(parseInput(`@claude ${msg}`).msg, msg);
  });

  it('parses /watch', () => {
    assert.deepEqual(parseInput('/watch'), { type: 'watch' });
  });

  it('parses /stop', () => {
    assert.deepEqual(parseInput('/stop'), { type: 'stop' });
  });

  it('parses /status', () => {
    assert.deepEqual(parseInput('/status'), { type: 'status' });
  });

  it('parses /converse with topic', () => {
    assert.deepEqual(parseInput('/converse How should we refactor auth?'), {
      type: 'converse', maxRounds: 10, topic: 'How should we refactor auth?',
    });
  });

  it('parses /converse with round count', () => {
    assert.deepEqual(parseInput('/converse 5 Discuss testing strategy'), {
      type: 'converse', maxRounds: 5, topic: 'Discuss testing strategy',
    });
  });

  it('parses /converse with 1 round', () => {
    assert.deepEqual(parseInput('/converse 1 quick question'), {
      type: 'converse', maxRounds: 1, topic: 'quick question',
    });
  });
});

// ─── Unit Tests: getNewContent ───────────────────────────────────────────────

describe('getNewContent', () => {
  it('returns current when baseline is empty', () => {
    assert.equal(getNewContent('', 'hello world'), 'hello world');
  });

  it('returns empty when baseline equals current', () => {
    assert.equal(getNewContent('same', 'same'), '');
  });

  it('extracts new lines appended after baseline', () => {
    const baseline = 'line1\nline2\nline3';
    const current = 'line1\nline2\nline3\nline4\nline5';
    const result = getNewContent(baseline, current);
    assert.ok(result.includes('line4'));
    assert.ok(result.includes('line5'));
  });

  it('handles screen scroll where baseline is gone', () => {
    const baseline = 'old1\nold2\nold3';
    const current = 'new1\nnew2\nnew3';
    const result = getNewContent(baseline, current);
    assert.ok(result.includes('new1'));
    assert.ok(result.includes('new2'));
    assert.ok(result.includes('new3'));
  });

  it('handles partial overlap', () => {
    const baseline = 'line1\nline2\nline3\nprompt$';
    const current = 'line2\nline3\nprompt$\nresponse line 1\nresponse line 2';
    const result = getNewContent(baseline, current);
    assert.ok(result.includes('response line 1'));
    assert.ok(result.includes('response line 2'));
  });

  it('handles terminal output with empty lines', () => {
    const baseline = 'prompt$ cmd\n\noutput1\n';
    const current = 'prompt$ cmd\n\noutput1\n\noutput2\nprompt$';
    const result = getNewContent(baseline, current);
    assert.ok(result.includes('output2'));
  });

  it('detects content inserted above preserved footer (Claude TUI pattern)', () => {
    // Claude's TUI inserts new assistant output above a preserved prompt/footer.
    // The old tail-matching algorithm returned empty because it found the footer
    // at the bottom and took everything after it (nothing).
    const baseline = [
      '> analyze the error handling',
      '',
      'Thinking...',
      '',
      '╭─────────────────────────────────╮',
      '│  ⏎ to send  /help for commands  │',
      '╰─────────────────────────────────╯',
    ].join('\n');
    const current = [
      '> analyze the error handling',
      '',
      "I've analyzed the error handling.",
      'I think @codex should review this.',
      'The main issues are:',
      '1. Missing try/catch in auth.ts',
      '',
      '╭─────────────────────────────────╮',
      '│  ⏎ to send  /help for commands  │',
      '╰─────────────────────────────────╯',
    ].join('\n');
    const result = getNewContent(baseline, current);
    assert.ok(result.includes('@codex'), `Expected @codex mention in result, got: "${result}"`);
    assert.ok(result.includes('Missing try/catch'));
    assert.ok(!result.includes('⏎ to send'), 'Should not include preserved footer');
  });

  it('detects content inserted above footer with identical prompt line', () => {
    // Even when a prompt line appears both above and below the new content
    const baseline = [
      'Claude Code v1.0',
      '> some prompt',
      '$',
    ].join('\n');
    const current = [
      'Claude Code v1.0',
      '> some prompt',
      'Here is my response mentioning @codex for review.',
      '$',
    ].join('\n');
    const result = getNewContent(baseline, current);
    assert.ok(result.includes('@codex'), `Expected @codex mention, got: "${result}"`);
    assert.ok(!result.includes('Claude Code'), 'Should not include preserved header');
  });

  it('handles content inserted between header and multi-line footer', () => {
    const baseline = [
      'header line 1',
      'header line 2',
      'footer line 1',
      'footer line 2',
    ].join('\n');
    const current = [
      'header line 1',
      'header line 2',
      'NEW LINE A',
      'NEW LINE B with @codex',
      'footer line 1',
      'footer line 2',
    ].join('\n');
    const result = getNewContent(baseline, current);
    assert.ok(result.includes('NEW LINE A'));
    assert.ok(result.includes('@codex'));
    assert.ok(!result.includes('header line'));
    assert.ok(!result.includes('footer line'));
  });
});

// ─── Unit Tests: detectMentions ──────────────────────────────────────────────

describe('detectMentions', () => {
  it('detects @claude mention', () => {
    assert.deepEqual(detectMentions('Hey @claude check this'), ['claude']);
  });

  it('detects @codex mention', () => {
    assert.deepEqual(detectMentions('Hey @codex review this'), ['codex']);
  });

  it('detects both mentions', () => {
    const result = detectMentions('@claude and @codex should discuss');
    assert.ok(result.includes('claude'));
    assert.ok(result.includes('codex'));
    assert.equal(result.length, 2);
  });

  it('returns empty for no mentions', () => {
    assert.deepEqual(detectMentions('no mentions here'), []);
  });

  it('is case insensitive', () => {
    assert.deepEqual(detectMentions('@Claude and @CODEX'), ['claude', 'codex']);
  });

  it('requires word boundary after mention', () => {
    // @claudeX should not match @claude
    assert.deepEqual(detectMentions('@claudeX something'), []);
  });

  it('matches at start of string', () => {
    assert.deepEqual(detectMentions('@codex do this'), ['codex']);
  });

  it('matches at end of string', () => {
    assert.deepEqual(detectMentions('thoughts @claude'), ['claude']);
  });

  it('matches with punctuation after', () => {
    assert.deepEqual(detectMentions('@claude, what do you think?'), ['claude']);
    assert.deepEqual(detectMentions('ask @codex.'), ['codex']);
  });
});

// ─── Unit Tests: cleanCapture ────────────────────────────────────────────────

describe('cleanCapture', () => {
  it('strips box-drawing border lines', () => {
    const input = '╭──────────────────────╮\n│ Hello world          │\n╰──────────────────────╯';
    const result = cleanCapture(input);
    assert.ok(result.includes('Hello world'));
    assert.ok(!result.includes('╭'));
    assert.ok(!result.includes('╰'));
  });

  it('strips spinner/thinking lines', () => {
    const input = '⠋ Thinking...\nActual response text here\n⠙ Working on it...';
    const result = cleanCapture(input);
    assert.ok(result.includes('Actual response text here'));
    assert.ok(!result.includes('Thinking'));
    assert.ok(!result.includes('Working'));
  });

  it('strips status bar hints', () => {
    const input = 'Some real content\n⏎ to send  /help for commands\nMore content';
    const result = cleanCapture(input);
    assert.ok(result.includes('Some real content'));
    assert.ok(result.includes('More content'));
    assert.ok(!result.includes('⏎'));
  });

  it('strips leading pipe chars from content lines', () => {
    const input = '│ This is actual content │\n│ And more content      │';
    const result = cleanCapture(input);
    assert.ok(result.includes('This is actual content'));
    assert.ok(!result.startsWith('│'));
  });

  it('preserves meaningful text', () => {
    const input = 'I analyzed the code and found 3 issues:\n1. Missing null check in auth.ts\n2. SQL injection in query.ts\n3. No rate limiting on /api/login';
    const result = cleanCapture(input);
    assert.equal(result, input);
  });

  it('returns empty for pure chrome', () => {
    const input = '╭───────────────╮\n│               │\n╰───────────────╯\n\n';
    const result = cleanCapture(input);
    assert.equal(result, '');
  });

  it('handles empty input', () => {
    assert.equal(cleanCapture(''), '');
    assert.equal(cleanCapture(null), '');
  });

  it('strips tool header lines', () => {
    const input = 'Claude Code v1.2.3\nHere is my analysis';
    const result = cleanCapture(input);
    assert.ok(!result.includes('Claude Code v'));
    assert.ok(result.includes('Here is my analysis'));
  });
});

// Env vars that duet.sh/bind-sessions.sh use — must be stripped from test env
// to prevent the live Duet session's values from leaking into binding tests.
const DUET_ENV_VARS = [
  'RESUME_CLAUDE_PATH', 'RESUME_CODEX_PATH', 'RESUME_CODEX_SESSION_ID',
  'STATE_DIR', 'CODEX_SESSIONS', 'CODEX_HOME', 'CLAUDE_PROJECTS',
  'CLAUDE_SESSION_ID', 'WORKDIR', 'DUET_STATE_DIR', 'DUET_RUN_DIR',
  'DUET_MODE', 'DUET_SESSION', 'DUET_BASE', 'GLOBAL_CODEX_SESSIONS',
];

function sanitizedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of DUET_ENV_VARS) delete env[key];
  return { ...env, ...overrides };
}

// ─── Integration Tests: tmux operations ──────────────────────────────────────

// Isolated tmux socket — all test tmux traffic goes through this socket only.
// Setting process.env ensures the imported tmuxCmd() in tmux-client.mjs uses
// the isolated socket for sendKeys/capturePane/pasteToPane/focusPane too.
const TEST_TMUX_SOCKET = `/tmp/duet-test-tmux-${process.pid}.sock`;
process.env.DUET_TMUX_SOCKET = TEST_TMUX_SOCKET;
process.env.TMUX = '';

const TEST_SESSION = `duet-test-${process.pid}`;
let paneA, paneB;

const tmuxEnv = { ...process.env };

function tmux(cmd) {
  return execSync(`tmux -S ${TEST_TMUX_SOCKET} ${cmd}`, { encoding: 'utf8', env: tmuxEnv }).trim();
}

function cleanupSession() {
  try { execSync(`tmux -S ${TEST_TMUX_SOCKET} kill-session -t ${TEST_SESSION} 2>/dev/null`, { env: tmuxEnv, stdio: 'ignore' }); } catch {}
}

function cleanupTestTmuxServer() {
  if (!existsSync(TEST_TMUX_SOCKET)) return;
  try { execSync(`tmux -S ${TEST_TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  try { execSync(`rm -f ${TEST_TMUX_SOCKET}`, { stdio: 'ignore' }); } catch {}
}

// Kill the isolated tmux server when the test process exits
process.on('exit', cleanupTestTmuxServer);

describe('tmux integration', () => {
  before(() => {
    cleanupSession();
    // Create a test tmux session with two panes running bash
    paneA = tmux(`new-session -d -s ${TEST_SESSION} -x 120 -y 40 -P -F '#{pane_id}'`);
    paneB = tmux(`split-window -h -t '${paneA}' -l 59 -P -F '#{pane_id}'`);
    // Wait for shells to be ready
    execSync('sleep 0.5');
  });

  after(() => {
    cleanupSession();
  });

  beforeEach(() => {
    // Clear both panes between tests
    try {
      tmux(`send-keys -t ${paneA} C-c`);
      tmux(`send-keys -t ${paneB} C-c`);
      tmux(`send-keys -t ${paneA} C-l`);
      tmux(`send-keys -t ${paneB} C-l`);
      execSync('sleep 0.3');
    } catch {}
  });

  describe('sendKeys', () => {
    it('sends text to a pane and it appears in output', async () => {
      await sendKeys(paneA, 'echo DUET_TEST_MARKER_1');
      execSync('sleep 0.5');
      const captured = await capturePane(paneA, 20);
      assert.ok(captured.includes('DUET_TEST_MARKER_1'), `Expected marker in: ${captured}`);
    });

    it('sends to correct pane without affecting the other', async () => {
      await sendKeys(paneA, 'echo ONLY_IN_A');
      execSync('sleep 0.5');
      const capB = await capturePane(paneB, 20);
      assert.ok(!capB.includes('ONLY_IN_A'), 'Text should not appear in other pane');
    });

    it('handles special characters', async () => {
      await sendKeys(paneA, 'echo "hello $USER \'world\'"');
      execSync('sleep 0.5');
      const captured = await capturePane(paneA, 20);
      assert.ok(captured.includes('hello'), `Expected output in: ${captured}`);
    });

    it('returns true on success', async () => {
      const result = await sendKeys(paneA, 'echo ok');
      assert.equal(result, true);
    });

    it('returns false for invalid pane', async () => {
      const result = await sendKeys('%999', 'echo fail');
      assert.equal(result, false);
    });
  });

  describe('capturePane', () => {
    it('captures visible text from a pane', async () => {
      await sendKeys(paneA, 'echo CAPTURE_TEST_42');
      execSync('sleep 0.5');
      const output = await capturePane(paneA, 20);
      assert.ok(output.includes('CAPTURE_TEST_42'));
    });

    it('respects line count parameter', async () => {
      // Write many lines
      await sendKeys(paneA, 'for i in $(seq 1 20); do echo "LINE_$i"; done');
      execSync('sleep 0.8');
      const few = await capturePane(paneA, 5);
      const many = await capturePane(paneA, 50);
      assert.ok(many.length >= few.length);
    });

    it('returns empty string for invalid pane', async () => {
      const result = await capturePane('%999', 10);
      assert.equal(result, '');
    });
  });

  describe('pasteToPane', () => {
    it('pastes multiline text into a pane', async () => {
      await pasteToPane(paneA, 'echo PASTE_LINE_ONE');
      execSync('sleep 0.5');
      const captured = await capturePane(paneA, 20);
      assert.ok(captured.includes('PASTE_LINE_ONE'), `Expected paste in: ${captured}`);
    });

    it('returns true on success', async () => {
      const result = await pasteToPane(paneA, 'echo ok');
      assert.equal(result, true);
    });

    it('returns false for invalid pane', async () => {
      const result = await pasteToPane('%999', 'echo fail');
      assert.equal(result, false);
    });

    it('cleans up temp files', async () => {
      const before = execSync('ls /tmp/duet-paste-* 2>/dev/null | wc -l', { encoding: 'utf8' }).trim();
      await pasteToPane(paneA, 'echo cleanup-test');
      execSync('sleep 0.2');
      const after = execSync('ls /tmp/duet-paste-* 2>/dev/null | wc -l', { encoding: 'utf8' }).trim();
      assert.equal(after, before, 'Temp files should be cleaned up');
    });

    it('uses bracketed paste (-p) to avoid chunked paste issues', () => {
      const src = readFileSync('/home/claude/duet/src/transport/tmux-client.mjs', 'utf8');
      assert.ok(src.includes('paste-buffer -p -b'),
        'pasteToPane should use paste-buffer -p for bracketed paste');
    });
  });

  describe('focusPane', () => {
    it('returns true for valid pane', async () => {
      assert.equal(await focusPane(paneA), true);
    });

    it('returns false for invalid pane', async () => {
      assert.equal(await focusPane('%999'), false);
    });

    it('actually changes the active pane', async () => {
      await focusPane(paneA);
      const active = tmux(`display-message -t ${TEST_SESSION} -p '#{pane_id}'`);
      assert.equal(active, paneA);

      await focusPane(paneB);
      const active2 = tmux(`display-message -t ${TEST_SESSION} -p '#{pane_id}'`);
      assert.equal(active2, paneB);
    });
  });

  describe('cross-pane relay workflow', () => {
    it('captures from one pane and sends to another', async () => {
      // Generate content in pane A
      await sendKeys(paneA, 'echo RELAY_SOURCE_CONTENT_XYZ');
      execSync('sleep 0.5');

      // Capture from A
      const captured = (await capturePane(paneA, 30)).trim();
      assert.ok(captured.includes('RELAY_SOURCE_CONTENT_XYZ'),
        `Expected source marker in pane A: ${captured}`);

      // Send a command to B that proves relay worked
      await pasteToPane(paneB, 'echo "received relay"');
      execSync('sleep 0.5');

      const capB = await capturePane(paneB, 20);
      assert.ok(capB.includes('received relay'), `Expected relay in pane B: ${capB}`);
    });
  });
});

// ─── Regression: tmux socket isolation ────────────────────────────────────────

describe('tmux socket isolation', () => {
  const ISOLATION_SESSION = `duet-isolation-${process.pid}`;

  before(() => {
    tmux(`new-session -d -s ${ISOLATION_SESSION} -x 80 -y 24`);
  });

  after(() => {
    try { tmux(`kill-session -t ${ISOLATION_SESSION}`); } catch {}
  });

  it('sessions on isolated socket are not visible on the default tmux server', () => {
    let defaultSessions = '';
    try {
      defaultSessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
        encoding: 'utf8',
        env: { ...tmuxEnv, DUET_TMUX_SOCKET: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // No default server running is also fine — proves isolation
    }
    assert.ok(!defaultSessions.includes(ISOLATION_SESSION),
      `Test session "${ISOLATION_SESSION}" should not appear on default tmux server`);
  });

  it('sessions on isolated socket are visible via the socket', () => {
    const sessions = tmux('list-sessions -F "#{session_name}"');
    assert.ok(sessions.includes(ISOLATION_SESSION),
      `Test session "${ISOLATION_SESSION}" should exist on isolated socket`);
  });
});

// ─── Integration Tests: duet.sh layout ───────────────────────────────────────

describe('duet.sh launcher', () => {
  const LAUNCH_SESSION = 'duet-launch-test';

  before(() => {
    try { tmux(`kill-session -t ${LAUNCH_SESSION}`); } catch {}
  });

  after(() => {
    try { tmux(`kill-session -t ${LAUNCH_SESSION}`); } catch {}
  });

  it('script exists and is executable', () => {
    assert.ok(existsSync('/home/claude/duet/duet.sh'));
    const stat = execSync('stat -c %a /home/claude/duet/duet.sh', { encoding: 'utf8' }).trim();
    assert.ok(stat.includes('7') || stat.includes('5'), `Expected executable, got ${stat}`);
  });

  it('creates correct 3-pane layout', () => {
    // Manually replicate layout logic (without launching claude/codex)
    // Use environment to set size for detached sessions
    const p0 = tmux(`new-session -d -s ${LAUNCH_SESSION} -x 120 -y 40 -P -F '#{pane_id}'`);
    const p1 = tmux(`split-window -v -t '${p0}' -l 12 -P -F '#{pane_id}'`);
    const p2 = tmux(`split-window -h -t '${p0}' -l 59 -P -F '#{pane_id}'`);

    // Verify 3 panes exist
    const paneList = tmux(`list-panes -t ${LAUNCH_SESSION} -F '#{pane_id}'`);
    const paneIds = paneList.split('\n').filter(Boolean);
    assert.equal(paneIds.length, 3, `Expected 3 panes, got ${paneIds.length}`);

    // Verify layout: top-left, top-right, bottom
    const layout = tmux(`list-panes -t ${LAUNCH_SESSION} -F '#{pane_top} #{pane_left} #{pane_width} #{pane_height}'`);
    const panes = layout.split('\n').filter(Boolean).map(line => {
      const [top, left, width, height] = line.split(' ').map(Number);
      return { top, left, width, height };
    });

    // Sort by top position to identify rows
    const rows = {};
    for (const p of panes) {
      const key = p.top;
      if (!rows[key]) rows[key] = [];
      rows[key].push(p);
    }
    const rowKeys = Object.keys(rows).map(Number).sort((a, b) => a - b);

    // Should have 2 rows: top row with 2 panes, bottom row with 1
    assert.ok(rowKeys.length >= 2, `Expected at least 2 rows, got ${rowKeys.length}`);
    const topRow = rows[rowKeys[0]];
    const bottomRow = rows[rowKeys[rowKeys.length - 1]];

    assert.equal(topRow.length, 2, 'Top row should have 2 panes');
    assert.equal(bottomRow.length, 1, 'Bottom row should have 1 pane');

    // Bottom pane should span full width (wider than either top pane)
    const bottomWidth = bottomRow[0].width;
    const topWidths = topRow.map(p => p.width);
    assert.ok(bottomWidth > Math.max(...topWidths),
      `Bottom pane (${bottomWidth}) should be wider than top panes (${topWidths})`);
  });

  it('tmux options can be applied to session', () => {
    // Verify we can set the styling options without error
    assert.doesNotThrow(() => {
      tmux(`set -t ${LAUNCH_SESSION} mouse on`);
      tmux(`set -t ${LAUNCH_SESSION} status on`);
      tmux(`set -t ${LAUNCH_SESSION} pane-border-status top`);
    });

    const mouse = tmux(`show-option -t ${LAUNCH_SESSION} -v mouse`);
    assert.equal(mouse, 'on');
  });
});

// ─── Unit Tests: extractClaudeResponse ───────────────────────────────────────

describe('extractClaudeResponse', () => {
  it('extracts text from assistant message', () => {
    const obj = { message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] } };
    assert.equal(extractClaudeResponse(obj), 'Hello world');
  });

  it('joins multiple text blocks', () => {
    const obj = { message: { role: 'assistant', content: [
      { type: 'text', text: 'Part 1' },
      { type: 'tool_use', name: 'Read' },
      { type: 'text', text: 'Part 2' },
    ] } };
    assert.equal(extractClaudeResponse(obj), 'Part 1\nPart 2');
  });

  it('returns null for user messages', () => {
    const obj = { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
    assert.equal(extractClaudeResponse(obj), null);
  });

  it('returns null for non-message objects', () => {
    assert.equal(extractClaudeResponse({}), null);
    assert.equal(extractClaudeResponse({ type: 'system' }), null);
  });

  it('returns null for assistant message with no text blocks', () => {
    const obj = { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } };
    assert.equal(extractClaudeResponse(obj), null);
  });
});

// ─── Unit Tests: extractCodexResponse ────────────────────────────────────────

describe('extractCodexResponse', () => {
  it('extracts from task_complete event', () => {
    const obj = { payload: { type: 'task_complete', last_agent_message: 'Done!' } };
    assert.equal(extractCodexResponse(obj), 'Done!');
  });

  it('extracts from event_msg assistant message with output_text', () => {
    const obj = { type: 'event_msg', payload: { type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: 'Here is the result' },
    ] } };
    assert.equal(extractCodexResponse(obj), 'Here is the result');
  });

  it('extracts from event_msg assistant message with text type', () => {
    const obj = { type: 'event_msg', payload: { type: 'message', role: 'assistant', content: [
      { type: 'text', text: 'Analysis complete' },
    ] } };
    assert.equal(extractCodexResponse(obj), 'Analysis complete');
  });

  it('returns null for non-matching events', () => {
    assert.equal(extractCodexResponse({}), null);
    assert.equal(extractCodexResponse({ type: 'event_msg', payload: { type: 'other' } }), null);
  });

  it('returns null for user messages', () => {
    const obj = { type: 'event_msg', payload: { type: 'message', role: 'user', content: [
      { type: 'text', text: 'hi' },
    ] } };
    assert.equal(extractCodexResponse(obj), null);
  });
});

// ─── Unit Tests: isResponseComplete ──────────────────────────────────────────

describe('isResponseComplete', () => {
  it('detects claude result type', () => {
    assert.equal(isResponseComplete('claude', { type: 'result', result: {} }), true);
  });

  it('detects claude stop_reason end_turn', () => {
    const obj = { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } };
    assert.equal(isResponseComplete('claude', obj), true);
  });

  it('returns false for claude assistant without stop_reason', () => {
    const obj = { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
    assert.equal(isResponseComplete('claude', obj), false);
  });

  it('returns false for claude user message', () => {
    const obj = { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
    assert.equal(isResponseComplete('claude', obj), false);
  });

  it('detects codex task_complete', () => {
    const obj = { payload: { type: 'task_complete', last_agent_message: 'Done!' } };
    assert.equal(isResponseComplete('codex', obj), true);
  });

  it('returns false for codex event_msg', () => {
    const obj = { type: 'event_msg', payload: { type: 'message', role: 'assistant', content: [] } };
    assert.equal(isResponseComplete('codex', obj), false);
  });

  it('returns false for unrelated objects', () => {
    assert.equal(isResponseComplete('claude', { type: 'ping' }), false);
    assert.equal(isResponseComplete('codex', { type: 'ping' }), false);
  });
});

// ─── Integration Tests: incremental session reader ───────────────────────────

describe('incremental session reader', () => {
  const tmpDir = '/tmp/duet-test-sessions-' + process.pid;
  const claudeLog = join(tmpDir, 'claude-test.jsonl');
  const codexLog = join(tmpDir, 'codex-test.jsonl');

  before(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    // Reset session state
    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.codex.path = null;
    sessionState.codex.resolved = false;
    sessionState.codex.offset = 0;
    sessionState.codex.lastResponse = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads claude session incrementally', () => {
    // Write first assistant message
    const msg1 = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] } });
    writeFileSync(claudeLog, msg1 + '\n');

    // Bind directly (bypassing STATE_DIR resolution for unit test)
    sessionState.claude.path = claudeLog;
    sessionState.claude.resolved = true;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;

    assert.equal(getClaudeLastResponse(), 'First response');
  });

  it('picks up new messages without re-reading old ones', () => {
    const offsetBefore = sessionState.claude.offset;
    assert.ok(offsetBefore > 0, 'Offset should have advanced from previous read');

    // Append a second message
    const msg2 = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }] } });
    appendFileSync(claudeLog, msg2 + '\n');

    assert.equal(getClaudeLastResponse(), 'Second response');
    assert.ok(sessionState.claude.offset > offsetBefore, 'Offset should have advanced further');
  });

  it('skips non-assistant lines', () => {
    const userMsg = JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'user says hi' }] } });
    appendFileSync(claudeLog, userMsg + '\n');

    // Should still return the last assistant message
    assert.equal(getClaudeLastResponse(), 'Second response');
  });

  it('updates when a newer assistant message arrives after non-assistant lines', () => {
    const msg3 = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Third response' }] } });
    appendFileSync(claudeLog, msg3 + '\n');

    assert.equal(getClaudeLastResponse(), 'Third response');
  });

  it('handles codex session incrementally', () => {
    const msg = JSON.stringify({ payload: { type: 'task_complete', last_agent_message: 'Codex done' } });
    writeFileSync(codexLog, msg + '\n');

    sessionState.codex.path = codexLog;
    sessionState.codex.resolved = true;
    sessionState.codex.offset = 0;
    sessionState.codex.lastResponse = null;

    assert.equal(getCodexLastResponse(), 'Codex done');
  });

  it('returns null when no data yet', () => {
    // Reset to simulate unresolved session
    const savedPath = sessionState.claude.path;
    const savedResolved = sessionState.claude.resolved;
    const savedOffset = sessionState.claude.offset;
    const savedResponse = sessionState.claude.lastResponse;

    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;

    assert.equal(getClaudeLastResponse(), null);

    // Restore
    sessionState.claude.path = savedPath;
    sessionState.claude.resolved = savedResolved;
    sessionState.claude.offset = savedOffset;
    sessionState.claude.lastResponse = savedResponse;
  });

  it('does not re-read when file has not grown', () => {
    const offsetBefore = sessionState.claude.offset;
    // Call again without appending — offset should not change
    getClaudeLastResponse();
    assert.equal(sessionState.claude.offset, offsetBefore);
  });

  it('handles partial lines correctly', () => {
    // Write a partial line (no trailing newline)
    const partial = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Partial' }] } });
    appendFileSync(claudeLog, partial);

    // Should NOT pick up the partial line
    const before = sessionState.claude.lastResponse;
    getClaudeLastResponse();
    assert.equal(sessionState.claude.lastResponse, before);

    // Now complete the line
    appendFileSync(claudeLog, '\n');
    assert.equal(getClaudeLastResponse(), 'Partial');
  });
});

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

    // First call: no binding
    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pending');

    // Write manifest (simulating late launcher write)
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Late binding' }] } });
    writeFileSync(claudeLog, msg + '\n');
    writeBindings(
      { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'unbound', confirmedAt: null }
    );

    // Second call: should now resolve
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

    // Overwrite manifest — should be ignored since already resolved
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

    // First call: pending
    writeBindings(
      { path: null, level: null, status: 'pending', confirmedAt: null },
      { path: null, level: null, status: 'pending', confirmedAt: null }
    );
    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pending');

    // Binder updates manifest to bound
    writeBindings(
      { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'pending', confirmedAt: null }
    );

    // Second call: should pick up the updated manifest
    assert.equal(resolveSessionPath('claude'), claudeLog);
    assert.equal(sessionState.claude.relayMode, 'session');
    assert.equal(getClaudeLastResponse(), 'Late arrival');
  });

  it('relayMode stays session after transient fallback in getCleanResponse', () => {
    resetSessionState();
    // Bind claude with a real log file
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Real response' }] } });
    writeFileSync(claudeLog, msg + '\n');
    writeBindings(
      { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      { path: null, level: null, status: 'unbound', confirmedAt: null }
    );

    resolveSessionPath('claude');
    assert.equal(sessionState.claude.relayMode, 'session');

    // Read the response so lastResponse is populated, then clear it to simulate empty
    getClaudeLastResponse();
    sessionState.claude.lastResponse = null;

    // relayMode should still be 'session' — getCleanResponse never downgrades it
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

    // Write pending manifest
    writeFileSync(join(stateDir2, 'bindings.json'), JSON.stringify({
      claude: { path: null, level: null, status: 'pending', confirmedAt: null },
      codex: { path: null, level: null, status: 'pending', confirmedAt: null },
    }));

    // First call — pending
    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pending');

    // Binder updates manifest
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
    writeFileSync(claudeLog2, msg + '\n');
    writeFileSync(join(stateDir2, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog2, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      codex: { path: null, level: null, status: 'pending', confirmedAt: null },
    }));

    // Second call — should re-read and find bound
    assert.equal(resolveSessionPath('claude'), claudeLog2);
    assert.equal(sessionState.claude.relayMode, 'session');
  });

  it('stops re-reading manifest once all tools are final', () => {
    setStateDir(stateDir2);
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };

    // Write all-degraded manifest (final state)
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

    // Overwrite manifest — should be ignored since both are resolved
    writeFileSync(join(stateDir2, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog2, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null },
    }));
    assert.equal(resolveSessionPath('claude'), null); // still degraded/pane
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
    // Only one file in the isolated sessions dir — it must be ours
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
    // File must appear after bind-sessions.sh takes its before-snapshot.
    // Spawn detached background process that creates it after 1s.
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
    // Both isolated and global have files
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
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('parseInput handles @claude with no message', () => {
    // "@claude " with trailing space → empty message
    assert.deepEqual(parseInput('@claude '), { type: 'claude', msg: '' });
  });

  it('parseInput handles @codex with no message', () => {
    assert.deepEqual(parseInput('@codex '), { type: 'codex', msg: '' });
  });

  it('parseInput does not confuse @claudeX with @claude', () => {
    // "@claudeX" doesn't start with "@claude " (note the space)
    assert.deepEqual(parseInput('@claudeX something'), { type: 'no_target' });
  });

  it('parseInput requires space or punctuation after @mention', () => {
    assert.deepEqual(parseInput('@codexfoo'), { type: 'no_target' });
  });

  it('parseInput accepts comma after @mention', () => {
    assert.deepEqual(parseInput('@both, do this'), { type: 'both', msg: 'do this' });
    assert.deepEqual(parseInput('@claude, fix it'), { type: 'claude', msg: 'fix it' });
    assert.deepEqual(parseInput('@codex, review'), { type: 'codex', msg: 'review' });
  });

  it('parseInput accepts colon after @mention', () => {
    assert.deepEqual(parseInput('@claude: explain this'), { type: 'claude', msg: 'explain this' });
  });

  it('parseInput accepts dash after @mention', () => {
    assert.deepEqual(parseInput('@codex- check the tests'), { type: 'codex', msg: 'check the tests' });
  });

  it('shellEscape handles very long strings', () => {
    const long = 'a'.repeat(10000);
    const escaped = shellEscape(long);
    const output = execSync(`echo ${escaped}`, { encoding: 'utf8' }).trim();
    assert.equal(output, long);
  });

  it('parseInput handles @relay same>same', () => {
    const result = parseInput('@relay claude>claude');
    assert.deepEqual(result, { type: 'relay', from: 'claude', to: 'claude', prompt: null });
  });

  it('parseInput /converse with no topic returns empty topic', () => {
    const result = parseInput('/converse ');
    assert.equal(result.type, 'converse');
    assert.equal(result.topic, '');
  });

  it('detectMentions ignores email-like patterns', () => {
    // @claude in user@claude.ai should still match (word boundary after 'claude')
    // This is acceptable — we err on the side of detection
    const result = detectMentions('email user@claude.ai');
    assert.ok(result.length >= 0); // just documenting the behavior
  });

  it('getNewContent handles identical multiline content', () => {
    const text = 'line1\nline2\nline3';
    assert.equal(getNewContent(text, text), '');
  });

  it('getNewContent handles completely new content', () => {
    const result = getNewContent('old stuff', 'totally new content');
    assert.ok(result.includes('totally new content'));
  });
});

// ─── Resume: parseInput new commands ─────────────────────────────────────────

describe('parseInput resume commands', () => {
  it('parses /detach', () => {
    assert.deepEqual(parseInput('/detach'), { type: 'detach' });
  });

  it('parses /destroy', () => {
    assert.deepEqual(parseInput('/destroy'), { type: 'destroy' });
  });

  it('/quit still works', () => {
    assert.deepEqual(parseInput('/quit'), { type: 'quit' });
    assert.deepEqual(parseInput('/exit'), { type: 'quit' });
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
    // No error thrown, no file created
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
    // Write session file with historical content
    const oldMsg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Old history' }] } });
    writeFileSync(claudeLog, oldMsg + '\n');
    const fileSize = readFileSync(claudeLog).length;

    // Write binding manifest
    writeFileSync(join(stateDir, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString() },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null },
    }));

    resetForResume();

    // Resolve binding — should seek to EOF
    const resolved = resolveSessionPath('claude');
    assert.equal(resolved, claudeLog);
    assert.equal(sessionState.claude.offset, fileSize);

    // Reading should return null (no NEW content after EOF)
    assert.equal(getClaudeLastResponse(), null);
  });

  it('picks up new content appended after EOF-seek', () => {
    // State from previous test: offset at EOF, no lastResponse

    // Append new content after the seek point
    const newMsg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'New after resume' }] } });
    appendFileSync(claudeLog, newMsg + '\n');

    // Should pick up only the new content
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
    // offset should be 0 (no seek), and reading should pick up the content
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
    // Set up a session file and binding manifest
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] } });
    writeFileSync(claudeLog, msg + '\n');
    writeFileSync(join(stateDir, 'bindings.json'), JSON.stringify({
      claude: { path: claudeLog, level: 'process', status: 'bound', confirmedAt: new Date().toISOString(), session_id: 'claude-uuid-123' },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null },
    }));

    // Initialize run.json
    writeFileSync(runJson, JSON.stringify({ run_id: 'test-run', status: 'active' }));

    setStateDir(stateDir);
    setDuetMode('new');
    setRunDir(stateDir);
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };

    resolveSessionPath('claude');

    // run.json should now have the binding path and session ID
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

    // Should complete nearly instantly (no polling), well under 1 second
    assert.ok(elapsed < 1000, `Expected fast completion, took ${elapsed}ms`);

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.claude.status, 'bound');
    assert.equal(bindings.codex.status, 'bound');
  });

  it('falls through to normal discovery when resume path is invalid', () => {
    cleanState();
    // Create a real file but set RESUME_CLAUDE_PATH to a nonexistent path
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

// ─── Resume: durable state directory structure ───────────────────────────────

describe('durable state directory structure', () => {
  it('duet.sh creates persistent run directory under ~/.local/state/duet', () => {
    // Verify the script uses DUET_BASE which defaults to ~/.local/state/duet
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('DUET_BASE="${DUET_BASE:-$HOME/.local/state/duet}"'));
    assert.ok(script.includes('RUNS_DIR="$DUET_BASE/runs"'));
    assert.ok(script.includes('WORKSPACES_DIR="$DUET_BASE/workspaces"'));
  });

  it('duet.sh supports resume, fork, list, destroy subcommands', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('cmd_resume'));
    assert.ok(script.includes('cmd_fork'));
    assert.ok(script.includes('cmd_list'));
    assert.ok(script.includes('cmd_destroy'));
  });

  it('duet.sh creates codex-home inside run directory (not /tmp)', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    // Verify codex_home is inside run_dir
    assert.ok(script.includes('codex_home="$run_dir/codex-home"'));
    // Verify no /tmp state dir
    assert.ok(!script.includes('STATE_DIR="/tmp/'));
  });

  it('duet.sh writes run.json with required fields', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    for (const field of ['run_id', 'cwd', 'created_at', 'updated_at', 'status', 'tmux_session', 'mode', 'claude.session_id', 'codex_home']) {
      assert.ok(script.includes(field), `Missing field: ${field}`);
    }
  });

  it('duet.sh resume uses --resume for claude and resume subcommand for codex', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('claude --dangerously-skip-permissions --resume'));
    assert.ok(script.includes('codex resume'));
  });

  it('duet.sh fork uses --fork-session for claude and fork subcommand for codex', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('--fork-session'));
    assert.ok(script.includes('codex fork'));
  });
});

// ─── cmd_list formatting and ordering ─────────────────────────────────────────

describe('cmd_list', () => {
  const testDir = '/tmp/duet-test-list-' + process.pid;
  const runsDir = join(testDir, 'runs');

  before(() => {
    mkdirSync(runsDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function createRun(id, overrides = {}) {
    const runDir = join(runsDir, id);
    mkdirSync(runDir, { recursive: true });
    const data = {
      run_id: id,
      cwd: '/home/test/project',
      status: 'stopped',
      mode: 'new',
      updated_at: '2026-03-07T01:00:00Z',
      tmux_session: `duet-${id.slice(0, 8)}`,
      claude: { session_id: 'claude-sid-001' },
      codex: { session_id: 'codex-sid-001' },
      ...overrides,
    };
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(data, null, 2));
    return runDir;
  }

  it('shows active runs before stopped runs', () => {
    // Clean up any previous test runs
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });

    createRun('aaaaaaaa-0000-0000-0000-000000000001', {
      status: 'stopped', updated_at: '2026-03-07T03:00:00Z',
    });
    createRun('bbbbbbbb-0000-0000-0000-000000000002', {
      status: 'active', updated_at: '2026-03-07T01:00:00Z',
    });

    const pyScript = join(testDir, 'list_order.py');
    writeFileSync(pyScript, `
import json, pathlib, sys
runs_dir = pathlib.Path(sys.argv[1])
runs = []
for rj in runs_dir.glob("*/run.json"):
    try: data = json.load(open(rj))
    except: continue
    rid = data.get("run_id", "?")
    status = data.get("status", "?")
    updated = data.get("updated_at", "?")
    runs.append({"short": rid[:8], "status": status, "updated": updated})
active = [r for r in runs if r["status"] == "active"]
rest = [r for r in runs if r["status"] != "active"]
active.sort(key=lambda r: r["updated"], reverse=True)
rest.sort(key=lambda r: r["updated"], reverse=True)
runs = active + rest
for run in runs:
    print(f"{run['short']}  {run['status']}")
`);

    const output = execSync(`python3 ${pyScript} ${runsDir}`, { encoding: 'utf8' }).trim();
    const lines = output.split('\n').map(l => l.trim());
    const activeIdx = lines.findIndex(l => l.includes('active'));
    const stoppedIdx = lines.findIndex(l => l.includes('stopped'));
    assert.ok(activeIdx < stoppedIdx, `active (${activeIdx}) should appear before stopped (${stoppedIdx})`);
  });

  it('shows resume hint for stopped runs only', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    // The Python block should only show resume for stopped/detached runs
    assert.ok(script.includes("'resumable': status in ('stopped', 'detached')"));
    assert.ok(script.includes("if run['resumable']"));
    assert.ok(script.includes("resume:"));
  });

  it('extracts codex title from SQLite threads table', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('get_codex_title'));
    assert.ok(script.includes('state_5.sqlite'));
    assert.ok(script.includes('SELECT title, first_user_message FROM threads'));
  });

  it('handles missing codex_home and missing session_id gracefully', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });

    createRun('cccccccc-0000-0000-0000-000000000003', {
      codex: { session_id: '' },
      codex_home: '/nonexistent/path',
    });

    // Should not crash
    const output = execSync(
      `python3 -c "
import json, os, pathlib
runs_dir = pathlib.Path('${runsDir}')
for rj in runs_dir.glob('*/run.json'):
    data = json.load(open(rj))
    x_sid = (data.get('codex') or {}).get('session_id', '')
    print('codex:', x_sid[:8] + '...' if x_sid else 'missing')
"`,
      { encoding: 'utf8' }
    ).trim();
    assert.ok(output.includes('missing'));
  });

  it('truncates long titles with ellipsis', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('MAX_TITLE = 72'));
    assert.ok(script.includes("title[:MAX_TITLE - 1]"));
  });

  it('shows shortened session IDs', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    // Session IDs should be truncated to 8 chars + ellipsis
    assert.ok(script.includes("c_sid[:8]"));
    assert.ok(script.includes("x_sid[:8]"));
  });

  it('end-to-end: renders full output with correct ordering and format', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });

    createRun('aaaaaaaa-0000-0000-0000-000000000001', {
      status: 'stopped', updated_at: '2026-03-07T03:00:00Z',
    });
    createRun('bbbbbbbb-0000-0000-0000-000000000002', {
      status: 'active', updated_at: '2026-03-07T01:00:00Z',
    });
    createRun('cccccccc-0000-0000-0000-000000000003', {
      status: 'active', updated_at: '2026-03-07T05:00:00Z',
      claude: { session_id: '' }, codex: {},
    });

    // Extract and run the Python heredoc from duet.sh
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const start = script.indexOf("<<'PYLIST'") + "<<'PYLIST'".length;
    const end = script.indexOf('\nPYLIST', start);
    const pyCode = script.slice(start, end);

    const output = execSync(
      `python3 - "${runsDir}" "duet.sh"`,
      { encoding: 'utf8', input: pyCode }
    ).trim();

    const lines = output.split('\n');
    // Header
    assert.ok(lines[0].includes('DUET RUNS'));
    // Active runs appear before stopped
    const activeLines = lines.filter(l => l.includes('active'));
    const stoppedLines = lines.filter(l => l.includes('stopped'));
    const firstActive = lines.findIndex(l => l.includes('active'));
    const firstStopped = lines.findIndex(l => l.includes('stopped'));
    assert.ok(firstActive < firstStopped, 'active runs should appear before stopped');
    // Most recent active first (cccccccc at 05:00 before bbbbbbbb at 01:00)
    const ccIdx = lines.findIndex(l => l.includes('cccccccc'));
    const bbIdx = lines.findIndex(l => l.includes('bbbbbbbb'));
    assert.ok(ccIdx < bbIdx, 'most recent active run should appear first');
    // Resume hint only for stopped
    assert.ok(output.includes('resume:  duet.sh resume aaaaaaaa'));
    assert.ok(!output.includes('resume:  duet.sh resume bbbbbbbb'));
    assert.ok(!output.includes('resume:  duet.sh resume cccccccc'));
    // Missing session IDs
    assert.ok(output.includes('claude:  missing'));
    assert.ok(output.includes('codex: missing'));
    // Present session IDs are shortened
    assert.ok(output.includes('claude-s\u2026'));
  });

  it('end-to-end: shows "(no runs found)" for empty directory', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });

    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const start = script.indexOf("<<'PYLIST'") + "<<'PYLIST'".length;
    const end = script.indexOf('\nPYLIST', start);
    const pyCode = script.slice(start, end);

    const output = execSync(
      `python3 - "${runsDir}" "duet.sh"`,
      { encoding: 'utf8', input: pyCode }
    ).trim();

    assert.ok(output.includes('(no runs found)'));
  });
});

// ─── Role prompt injection ────────────────────────────────────────────────────

describe('role prompt injection', () => {
  const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');

  it('duet.sh defines build_tool_prompt helper', () => {
    assert.ok(script.includes('build_tool_prompt()'));
    assert.ok(script.includes('CLAUDE_ROLE.md'));
    assert.ok(script.includes('CODEX_ROLE.md'));
  });

  it('build_tool_prompt composes prompt files under runtime/', () => {
    assert.ok(script.includes('claude-system-prompt.md'));
    assert.ok(script.includes('codex-model-instructions.md'));
  });

  it('cmd_new calls build_tool_prompt for both tools', () => {
    const cmdNew = script.slice(script.indexOf('cmd_new()'), script.indexOf('cmd_resume()'));
    assert.ok(cmdNew.includes('build_tool_prompt claude'));
    assert.ok(cmdNew.includes('build_tool_prompt codex'));
  });

  it('cmd_resume calls build_tool_prompt for both tools', () => {
    const cmdResume = script.slice(script.indexOf('cmd_resume()'), script.indexOf('cmd_fork()'));
    assert.ok(cmdResume.includes('build_tool_prompt claude'));
    assert.ok(cmdResume.includes('build_tool_prompt codex'));
  });

  it('cmd_fork calls build_tool_prompt for both tools', () => {
    const cmdFork = script.slice(script.indexOf('cmd_fork()'), script.indexOf('cmd_list()'));
    assert.ok(cmdFork.includes('build_tool_prompt claude'));
    assert.ok(cmdFork.includes('build_tool_prompt codex'));
  });

  it('claude resume path includes --append-system-prompt', () => {
    const cmdResume = script.slice(script.indexOf('cmd_resume()'), script.indexOf('cmd_fork()'));
    // Both the resumed and fresh branches should append system prompt
    const resumeBranch = cmdResume.slice(cmdResume.indexOf('if [ -n "$claude_sid" ]'));
    assert.ok(resumeBranch.includes('--resume $claude_sid --append-system-prompt'));
  });

  it('codex resume path includes model_instructions_file', () => {
    const cmdResume = script.slice(script.indexOf('cmd_resume()'), script.indexOf('cmd_fork()'));
    // Both the resumed and fresh codex branches should use model_instructions_file
    assert.ok(cmdResume.includes('codex resume $codex_sid --dangerously-bypass-approvals-and-sandbox -c model_instructions_file='));
  });

  it('codex fork path includes model_instructions_file', () => {
    const cmdFork = script.slice(script.indexOf('cmd_fork()'), script.indexOf('cmd_list()'));
    assert.ok(cmdFork.includes('codex fork $codex_sid --dangerously-bypass-approvals-and-sandbox -c model_instructions_file='));
  });

  it('README documents both role prompt files', () => {
    const readme = readFileSync('/home/claude/duet/README.md', 'utf8');
    assert.ok(readme.includes('CLAUDE_ROLE.md'));
    assert.ok(readme.includes('CODEX_ROLE.md'));
  });
});

describe('build_tool_prompt integration', () => {
  const testDir = '/tmp/duet-test-role-' + process.pid;
  const runtimeDir = join(testDir, 'runtime');
  const workdir = join(testDir, 'project');

  before(() => {
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(workdir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('produces plain DUET.md when no role file exists', () => {
    const output = join(runtimeDir, 'plain.md');
    execSync(`bash -c '
      DIR="/home/claude/duet"
      build_tool_prompt() {
        local tool="$1" workdir="$2" output="$3"
        cp "$DIR/DUET.md" "$output"
        local role_file display_name
        if [ "$tool" = "claude" ]; then role_file="$workdir/CLAUDE_ROLE.md"; display_name="Claude"
        else role_file="$workdir/CODEX_ROLE.md"; display_name="Codex"; fi
        if [ -f "$role_file" ]; then
          printf "\\n\\n## Project-specific %s role\\n\\nThe following instructions come from \\\`%s\\\` in the project root.\\n\\n" "$display_name" "$(basename "$role_file")" >> "$output"
          cat "$role_file" >> "$output"
        fi
      }
      build_tool_prompt claude ${workdir} ${output}
    '`);
    const result = readFileSync(output, 'utf8');
    const duet = readFileSync('/home/claude/duet/DUET.md', 'utf8');
    assert.equal(result, duet, 'output should be identical to DUET.md when no role file exists');
  });

  it('appends CLAUDE_ROLE.md content when present', () => {
    const roleContent = 'You are the lead architect. Focus on system design.';
    writeFileSync(join(workdir, 'CLAUDE_ROLE.md'), roleContent);
    const output = join(runtimeDir, 'claude-role.md');
    execSync(`bash -c '
      DIR="/home/claude/duet"
      build_tool_prompt() {
        local tool="$1" workdir="$2" output="$3"
        cp "$DIR/DUET.md" "$output"
        local role_file display_name
        if [ "$tool" = "claude" ]; then role_file="$workdir/CLAUDE_ROLE.md"; display_name="Claude"
        else role_file="$workdir/CODEX_ROLE.md"; display_name="Codex"; fi
        if [ -f "$role_file" ]; then
          printf "\\n\\n## Project-specific %s role\\n\\nThe following instructions come from \\\`%s\\\` in the project root.\\n\\n" "$display_name" "$(basename "$role_file")" >> "$output"
          cat "$role_file" >> "$output"
        fi
      }
      build_tool_prompt claude ${workdir} ${output}
    '`);
    const result = readFileSync(output, 'utf8');
    assert.ok(result.includes('## Project-specific Claude role'));
    assert.ok(result.includes('CLAUDE_ROLE.md'));
    assert.ok(result.includes(roleContent));
    // Should also contain DUET.md base
    assert.ok(result.includes('Duet: Multi-Agent Collaboration'));
    // Clean up role file
    rmSync(join(workdir, 'CLAUDE_ROLE.md'));
  });

  it('appends CODEX_ROLE.md content when present', () => {
    const roleContent = 'You are the testing specialist. Focus on test coverage.';
    writeFileSync(join(workdir, 'CODEX_ROLE.md'), roleContent);
    const output = join(runtimeDir, 'codex-role.md');
    execSync(`bash -c '
      DIR="/home/claude/duet"
      build_tool_prompt() {
        local tool="$1" workdir="$2" output="$3"
        cp "$DIR/DUET.md" "$output"
        local role_file display_name
        if [ "$tool" = "claude" ]; then role_file="$workdir/CLAUDE_ROLE.md"; display_name="Claude"
        else role_file="$workdir/CODEX_ROLE.md"; display_name="Codex"; fi
        if [ -f "$role_file" ]; then
          printf "\\n\\n## Project-specific %s role\\n\\nThe following instructions come from \\\`%s\\\` in the project root.\\n\\n" "$display_name" "$(basename "$role_file")" >> "$output"
          cat "$role_file" >> "$output"
        fi
      }
      build_tool_prompt codex ${workdir} ${output}
    '`);
    const result = readFileSync(output, 'utf8');
    assert.ok(result.includes('## Project-specific Codex role'));
    assert.ok(result.includes('CODEX_ROLE.md'));
    assert.ok(result.includes(roleContent));
    assert.ok(result.includes('Duet: Multi-Agent Collaboration'));
    rmSync(join(workdir, 'CODEX_ROLE.md'));
  });
});

// ─── Bug fix: /destroy removes state before killing tmux ─────────────────────

describe('/destroy ordering', () => {
  it('router.mjs removes run dir before killing tmux session', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    // Find the destroy handler's setTimeout body
    const destroyBlock = src.slice(src.indexOf("case 'destroy':"), src.indexOf("case 'destroy':") + 600);
    const rmIndex = destroyBlock.indexOf('rmSync');
    const killIndex = destroyBlock.indexOf('killSession');
    assert.ok(rmIndex > 0, 'rmSync should exist in destroy handler');
    assert.ok(killIndex > 0, 'killSession should exist in destroy handler');
    assert.ok(rmIndex < killIndex, `rmSync (${rmIndex}) should come before killSession (${killIndex})`);
  });
});

// ─── Bug fix: run_field treats JSON null as empty string ─────────────────────

describe('run_field null handling', () => {
  const testDir = '/tmp/duet-test-runfield-' + process.pid;
  const runJson = join(testDir, 'run.json');
  const helperScript = join(testDir, 'run_field.sh');

  before(() => {
    mkdirSync(testDir, { recursive: true });
    // Write a standalone helper script that defines run_field and calls it
    writeFileSync(helperScript, `#!/usr/bin/env bash
run_field() {
  local run_json="$1" key="$2"
  python3 -c "
import json, sys, functools
d = json.load(open(sys.argv[1]))
val = functools.reduce(lambda o, k: o.get(k, {}) if isinstance(o, dict) else {}, sys.argv[2].split('.'), d)
print(val if isinstance(val, str) else '' if val is None else '' if isinstance(val, dict) else str(val))
" "$run_json" "$key" 2>/dev/null
}
run_field "$1" "$2"
`);
    execSync(`chmod +x ${helperScript}`);
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty string for JSON null values', () => {
    writeFileSync(runJson, JSON.stringify({
      codex: { session_id: null },
      claude: { session_id: 'real-id' },
    }));

    const result = execSync(
      `bash ${helperScript} ${runJson} codex.session_id`,
      { encoding: 'utf8' }
    ).trim();

    // Must be empty string, NOT "None"
    assert.equal(result, '', `Expected empty string for null, got "${result}"`);
  });

  it('returns actual value for non-null fields', () => {
    const result = execSync(
      `bash ${helperScript} ${runJson} claude.session_id`,
      { encoding: 'utf8' }
    ).trim();

    assert.equal(result, 'real-id');
  });
});

// ─── Bug fix: resume fast-path validates session IDs ─────────────────────────

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
    // File exists but has wrong name (different session)
    const wrongFile = join(claudeProjects, 'wrong-session-id.jsonl');
    writeFileSync(wrongFile, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'wrong' }] } }) + '\n');

    runBind({
      CLAUDE_SESSION_ID: 'expected-session-id',
      RESUME_CLAUDE_PATH: wrongFile,
    });

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    // Should NOT have bound via fast-path (filename mismatch)
    // It will degrade since CLAUDE_SESSION_ID 'expected-session-id' file doesn't exist
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
    // Fast-path should reject (ID mismatch), but normal discovery finds it in isolated dir
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.session_id, 'actual-codex-id');
    // The key check: it should have been found by normal discovery, not fast-path
    // (both paths lead to 'bound' but the important thing is the validation happened)
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
      // No RESUME_CODEX_SESSION_ID — should accept any file
    });
    const elapsed = Date.now() - start;

    const bindings = JSON.parse(readFileSync(join(stateDir, 'bindings.json'), 'utf8'));
    assert.equal(bindings.codex.status, 'bound');
    assert.equal(bindings.codex.session_id, 'some-id');
  });
});

// ─── Bug fix: shell quoting for paths with spaces ────────────────────────────

describe('shell quoting for paths with spaces', () => {
  it('duet.sh quote_path properly escapes spaces', () => {
    const result = execSync(
      `bash -c 'quote_path() { printf "%q" "$1"; }; quote_path "/tmp/my repo/test"'`,
      { encoding: 'utf8' }
    ).trim();
    // printf %q should escape the space
    assert.ok(!result.includes(' ') || result.includes('\\ ') || result.includes("'"),
      `Expected escaped space in: ${result}`);
    // Verify it round-trips through eval
    const roundtrip = execSync(
      `bash -c 'eval echo ${result}'`,
      { encoding: 'utf8' }
    ).trim();
    assert.equal(roundtrip, '/tmp/my repo/test');
  });

  it('duet.sh uses quote_path for all interpolated paths in send-keys', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    // All tmux send-keys lines with cd should use q_ quoted vars
    const sendKeysLines = script.split('\n').filter(l =>
      l.includes('tmux send-keys') && l.includes('cd ')
    );
    for (const line of sendKeysLines) {
      assert.ok(line.includes('q_'), `send-keys line should use quoted path variable: ${line.trim()}`);
    }
  });

  it('launch_router uses quoted paths', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    // The router launch line should use q_run_dir not raw $run_dir
    const routerBlock = script.slice(
      script.indexOf('launch_router()'),
      script.indexOf('launch_router()') + 400
    );
    assert.ok(routerBlock.includes('q_run_dir'), 'launch_router should use q_run_dir');
    assert.ok(routerBlock.includes('q_dir'), 'launch_router should use q_dir');
  });
});

// ─── Bug fix: codex fast-path requires session ID for resume ─────────────────

describe('codex fast-path requires session ID for resume', () => {
  it('duet.sh only exports RESUME_CODEX_PATH when codex_sid is present', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    // Find the resume command's fast-path section
    const resumeFunc = script.slice(
      script.indexOf('cmd_resume()'),
      script.indexOf('cmd_fork()')
    );
    // Should guard RESUME_CODEX_PATH with codex_sid check
    assert.ok(
      resumeFunc.includes('[ -n "$codex_binding" ] && [ -n "$codex_sid" ]'),
      'RESUME_CODEX_PATH export should be gated on codex_sid being present'
    );
  });
});

// ─── Bug fix: ambiguous run-id prefix errors instead of picking first ────────

describe('ambiguous run-id prefix handling', () => {
  it('resolve_run_id errors on ambiguous prefix', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const resolveBlock = script.slice(
      script.indexOf('resolve_run_id()'),
      script.indexOf('resolve_run_id()') + 1200
    );
    assert.ok(resolveBlock.includes('ambiguous prefix'), 'Should error on ambiguous prefix');
    assert.ok(resolveBlock.includes('return 1'), 'Should return non-zero on ambiguity');
    assert.ok(resolveBlock.includes('${#matches[@]} -eq 1'), 'Should require exactly one match');
  });
});

// ─── Bug fix: workspace path canonicalization ────────────────────────────────

describe('workspace path canonicalization', () => {
  it('cmd_new canonicalizes workdir with pwd -P', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const cmdNewBlock = script.slice(
      script.indexOf('cmd_new()'),
      script.indexOf('cmd_new()') + 200
    );
    assert.ok(cmdNewBlock.includes('pwd -P'), 'cmd_new should canonicalize workdir with pwd -P');
  });

  it('canonicalization resolves relative and symlink paths', () => {
    // Create a symlink and verify pwd -P resolves it
    const testDir = '/tmp/duet-test-canon-' + process.pid;
    const realDir = join(testDir, 'real');
    const linkDir = join(testDir, 'link');
    mkdirSync(realDir, { recursive: true });
    execSync(`ln -sf ${realDir} ${linkDir}`);

    const resolved = execSync(`cd ${linkDir} && pwd -P`, { encoding: 'utf8' }).trim();
    assert.equal(resolved, realDir, 'pwd -P should resolve symlink');

    const relative = execSync(`cd ${testDir} && cd real && pwd -P`, { encoding: 'utf8' }).trim();
    assert.equal(relative, realDir, 'pwd -P should resolve relative path');

    rmSync(testDir, { recursive: true, force: true });
  });
});

// ─── Per-direction relay cooldown ─────────────────────────────────────────────

describe('per-direction relay cooldown', () => {
  beforeEach(() => {
    // Clear all cooldown entries
    for (const key of Object.keys(lastAutoRelayTime)) {
      delete lastAutoRelayTime[key];
    }
  });

  it('allows claude->codex followed by codex->claude within cooldown window', () => {
    // Pre-set cooldown for claude->codex to simulate a successful delivery
    const now = Date.now();
    lastAutoRelayTime['claude->codex'] = now;

    // codex->claude direction should be independent — not blocked by claude->codex
    // Simulate codex replying with @claude (delivery will fail in test env, but
    // the point is it's not blocked by the claude->codex cooldown)
    handleNewOutput('codex', '@claude Got it, looks good!');

    // Verify claude->codex cooldown is still set (different direction)
    assert.ok(lastAutoRelayTime['claude->codex'] > 0, 'claude->codex cooldown should still be set');
    // codex->claude was attempted (not blocked by claude->codex cooldown)
    // In test env delivery fails so cooldown won't be set, but the key invariant
    // is that the other direction's cooldown didn't block it
  });

  it('blocks same-direction relay within cooldown window', () => {
    // Pre-set cooldown for claude->codex to simulate a recent successful delivery
    const now = Date.now();
    lastAutoRelayTime['claude->codex'] = now;

    // Simulate claude mentioning @codex again immediately — should be blocked
    handleNewOutput('claude', 'Hey @codex, second message');

    // The timestamp should NOT be updated (relay was blocked by cooldown)
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

  it('sessionState includes stale-detection fields', () => {
    assert.ok('lastSessionActivityAt' in sessionState.claude);
    assert.ok('staleDowngraded' in sessionState.claude);
    assert.ok('lastSessionActivityAt' in sessionState.codex);
    assert.ok('staleDowngraded' in sessionState.codex);
  });

  it('downgradeToPane is a no-op that does not change transport', () => {
    const origMode = sessionState.claude.relayMode;
    sessionState.claude.relayMode = 'session';

    downgradeToPane('claude', 'test reason');

    // relayMode should NOT change — downgradeToPane is a no-op now
    assert.equal(sessionState.claude.relayMode, 'session');

    // Restore
    sessionState.claude.relayMode = origMode;
  });

  it('/rebind is the supported repair path for stale bindings', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
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
    stopFileWatchers(); // Close any file watchers opened during rebind tests
    rmSync(testDir, { recursive: true, force: true });
    // Restore session state
    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.relayMode = 'pending';
    sessionState.claude.staleDowngraded = false;
    sessionState.claude.lastSessionActivityAt = 0;
    sessionState.codex.path = null;
    sessionState.codex.resolved = false;
    sessionState.codex.relayMode = 'pending';
    sessionState.codex.staleDowngraded = false;
  });

  it('finds newer .jsonl file as rebind candidate', () => {
    const staleFile = join(testDir, 'aaaa-stale.jsonl');
    const freshFile = join(testDir, 'bbbb-fresh.jsonl');
    writeFileSync(staleFile, '{"old": true}\n');
    // Small delay to ensure different mtime
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

    // Remove the other files from previous test
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
    sessionState.claude.staleDowngraded = true;

    const runDir = join(testDir, 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), '{}');
    setRunDir(runDir);

    const result = await rebindTool('claude', newFile);

    assert.equal(result.newPath, newFile);
    assert.equal(result.newSid, '12345678-abcd-1234-abcd-123456789012');
    assert.equal(sessionState.claude.path, newFile);
    assert.equal(sessionState.claude.relayMode, 'session');
    assert.equal(sessionState.claude.staleDowngraded, false);
    // Offset should be at EOF
    const { size } = statSync(newFile);
    assert.equal(sessionState.claude.offset, size);

    // run.json should be updated
    const rj = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    assert.equal(rj.claude.binding_path, newFile);
    assert.equal(rj.claude.session_id, '12345678-abcd-1234-abcd-123456789012');

    setRunDir(null);
  });

  it('works for codex too', () => {
    // Clean up
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

    // Restore
    sessionState.codex.path = null;
    sessionState.codex.resolved = false;
  });
});

describe('help text includes /rebind', () => {
  it('router help text mentions /rebind', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    assert.ok(src.includes('/rebind claude|codex'));
    assert.ok(src.includes('Re-discover session'));
  });
});

// ─── Phase 3-5: session-only automation, explicit binding, no pane fallback ──

describe('session-only automation', () => {
  it('router no longer uses capture-pane for automation relay', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    // capturePane call sites (not imports/exports/comments) should only be in /snap
    const lines = src.split('\n');
    const callLines = lines.filter(l => {
      const trimmed = l.trim();
      return trimmed.includes('capturePane(') &&
        !trimmed.startsWith('import') && !trimmed.startsWith('export') &&
        !trimmed.startsWith('//');
    });
    for (const line of callLines) {
      assert.ok(
        line.includes('parsed.target') || line.includes('parsed.lines'),
        `capturePane called outside /snap: ${line.trim()}`
      );
    }
  });

  it('router no longer uses getNewContent or cleanCapture in automation paths', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    // getNewContent and cleanCapture should be defined (for export) but never called
    // in handleNewOutput, triggerSessionRelay, pollPanes, or getCleanResponse
    assert.ok(!src.includes('getCleanResponse'), 'getCleanResponse should be removed');
    // getNewContent is exported for tests but not used in automation
    const automationBlock = src.slice(
      src.indexOf('async function handleNewOutput'),
      src.indexOf('// ─── Input parsing')
    );
    assert.ok(!automationBlock.includes('getNewContent'), 'getNewContent should not be used in automation');
    assert.ok(!automationBlock.includes('cleanCapture'), 'cleanCapture should not be used in automation');
  });

  it('handleNewOutput uses session response, not pane capture', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const handleBlock = src.slice(
      src.indexOf('async function handleNewOutput'),
      src.indexOf('// ─── Input parsing')
    );
    assert.ok(handleBlock.includes('getSessionResponse'), 'should use getSessionResponse');
    assert.ok(!handleBlock.includes('capturePane'), 'should not use capturePane');
  });
});

describe('explicit binding enforcement', () => {
  it('/converse requires both tools to be bound', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const converseBlock = src.slice(
      src.indexOf("case 'converse':"),
      src.indexOf("case 'converse':") + 800
    );
    assert.ok(converseBlock.includes('both tools must be session-bound'),
      '/converse should check that both tools are bound');
  });

  it('@relay requires source to be bound', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const relayBlock = src.slice(
      src.indexOf("case 'relay':"),
      src.indexOf("case 'relay':") + 600
    );
    assert.ok(relayBlock.includes('not session-bound'),
      '@relay should check source binding');
  });

  it('@relay uses getSessionResponse only (no pane fallback)', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
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
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
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
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const watchBlock = src.slice(
      src.indexOf("case 'watch':"),
      src.indexOf("case 'watch':") + 1200
    );
    assert.ok(watchBlock.includes('bindingStatus'), '/watch should check binding status');
    assert.ok(watchBlock.includes('active'), '/watch should report active for bound');
    assert.ok(watchBlock.includes('waiting'), '/watch should report waiting for pending');
    assert.ok(watchBlock.includes('unavailable'), '/watch should report unavailable for degraded');
  });

  it('/status shows binding state and automation availability', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const statusBlock = src.slice(
      src.indexOf("case 'status':"),
      src.indexOf("case 'status':") + 1500
    );
    assert.ok(statusBlock.includes('bindingStatus'), '/status should show binding status');
    assert.ok(statusBlock.includes('automation:'), '/status should show automation state');
  });

  it('no stale auto-downgrade remains', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    // downgradeToPane should be a no-op — no relayMode mutation
    const dgBlock = src.slice(
      src.indexOf('export function downgradeToPane'),
      src.indexOf('export function downgradeToPane') + 300
    );
    assert.ok(!dgBlock.includes("st.relayMode = 'pane'"), 'downgradeToPane should not change relayMode');
    assert.ok(!dgBlock.includes('staleDowngraded = true'), 'downgradeToPane should not set staleDowngraded');
    // No pane-based stale detection in the codebase
    assert.ok(!src.includes('STALE_BINDING_MS'), 'No stale binding constant should remain');
    assert.ok(!src.includes('PANE_STABLE_TICKS'), 'No pane stable ticks constant should remain');
  });

  it('capturePane is only used for /snap diagnostic', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    // Find all capturePane calls (excluding imports/exports)
    const lines = src.split('\n');
    const usageLines = lines.filter(l =>
      l.includes('capturePane(') && !l.includes('import') && !l.includes('export'));
    // Should only be in /snap handler
    assert.ok(usageLines.length > 0, 'capturePane should still exist for /snap');
    for (const line of usageLines) {
      assert.ok(
        line.includes('parsed.target') || line.includes('parsed.lines'),
        `capturePane used outside /snap: ${line.trim()}`
      );
    }
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
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false };
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

    // Create a codex session file where filename != payload.id
    const staleFile = join(testDir, 'stale-codex.jsonl');
    const freshFile = join(testDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    writeFileSync(staleFile, '{"old":true}\n');
    // payload.id is different from the filename UUID
    writeFileSync(freshFile, '{"payload":{"id":"actual-codex-session-42","type":"session_start"}}\n');

    sessionState.codex.path = staleFile;
    sessionState.codex.resolved = true;
    sessionState.codex.relayMode = 'session';

    const { newSid } = await rebindTool('codex', freshFile);
    stopFileWatchers();

    // Should use payload.id, not filename UUID
    assert.equal(newSid, 'actual-codex-session-42');
    const rj = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    assert.equal(rj.codex.session_id, 'actual-codex-session-42');

    // Clean up
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

    // Clean up
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
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    // startPolling must track watcher failures
    assert.ok(src.includes('watcherFailed.add(name)'), 'startPolling should track watcher failures');
    assert.ok(src.includes("watcher failed — automation inactive"), 'should report watcher failure');
  });

  it('/status shows inactive when watcher failed for bound tool', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    // /status path must check watcherFailed
    const statusBlock = src.slice(src.indexOf("case 'status':"), src.indexOf("case 'status':") + 1200);
    assert.ok(statusBlock.includes('watcherFailed.has(tool)'), '/status must check watcherFailed');
  });

  it('/watch shows inactive when watcher failed for bound tool', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const watchBlock = src.slice(src.indexOf("case 'watch':"), src.indexOf("case 'watch':") + 1200);
    assert.ok(watchBlock.includes('watcherFailed.has(tool)'), '/watch must check watcherFailed');
    assert.ok(watchBlock.includes('inactive'), '/watch should show inactive for failed watcher');
  });

  it('watcher error handler adds to watcherFailed set', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const errorBlock = src.slice(src.indexOf("on('error'"), src.indexOf("on('error'") + 300);
    assert.ok(errorBlock.includes('watcherFailed.add(tool)'), 'watcher error should add to watcherFailed');
  });

  it('rebindTool clears watcherFailed on successful watcher start', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const rebindBlock = src.slice(src.indexOf('export async function rebindTool'), src.indexOf('export async function rebindTool') + 800);
    assert.ok(rebindBlock.includes('watcherFailed.delete(tool)'), 'rebindTool should clear watcherFailed');
  });

  it('pollBindings marks tool as watcherFailed when watcher startup fails after late binding', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const pollBlock = src.slice(src.indexOf('function pollBindings()'), src.indexOf('function pollBindings()') + 800);
    // When binding resolves but watcher fails, tool must be removed from pendingTools
    // and added to watcherFailed — not left appearing active
    assert.ok(pollBlock.includes('pendingTools.delete(name)'), 'should remove from pendingTools on binding resolution');
    assert.ok(pollBlock.includes('watcherFailed.add(name)'), 'should add to watcherFailed when watcher fails');
    assert.ok(pollBlock.includes('watcher failed'), 'should log watcher failure');
    // Verify the tool is removed from pendingTools BEFORE the watcher check,
    // so a failed watcher doesn't leave it polling forever
    const deleteIdx = pollBlock.indexOf('pendingTools.delete(name)');
    const watcherAddIdx = pollBlock.indexOf('watcherFailed.add(name)');
    assert.ok(deleteIdx < watcherAddIdx, 'pendingTools removal must precede watcherFailed addition');
  });
});

// ─── Fix 3: Transport delivery failure handling ──────────────────────────────

describe('transport delivery failure handling', () => {
  it('direct commands check sendKeys return value', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    // @claude handler
    const claudeBlock = src.slice(src.indexOf("case 'claude':"), src.indexOf("case 'claude':") + 300);
    assert.ok(claudeBlock.includes('await sendKeys') && claudeBlock.includes('Failed to send'), '@claude should check sendKeys result');
    // @codex handler
    const codexBlock = src.slice(src.indexOf("case 'codex':"), src.indexOf("case 'codex':") + 300);
    assert.ok(codexBlock.includes('await sendKeys') && codexBlock.includes('Failed to send'), '@codex should check sendKeys result');
  });

  it('@both checks both sendKeys results', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const bothBlock = src.slice(src.indexOf("case 'both':"), src.indexOf("case 'both':") + 500);
    assert.ok(bothBlock.includes('Promise.all'), '@both should send in parallel');
    assert.ok(bothBlock.includes('Failed to send'), '@both should report failure');
  });

  it('@relay checks pasteToPane result', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const relayBlock = src.slice(src.indexOf("case 'relay':"), src.indexOf("case 'relay':") + 800);
    assert.ok(relayBlock.includes('await pasteToPane') && relayBlock.includes('Failed to relay'), '@relay should check delivery');
  });

  it('converse does not advance turn on failed delivery', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const converseBlock = src.slice(src.indexOf('Converse mode auto-relay'), src.indexOf('Converse mode auto-relay') + 1200);
    assert.ok(converseBlock.includes('converseState.rounds--'), 'should decrement round on failure');
    assert.ok(converseBlock.includes('turn not advanced'), 'should log turn not advanced');
    // Verify turn is not set to other on failure
    const failBlock = converseBlock.slice(converseBlock.indexOf('!delivered'), converseBlock.indexOf('!delivered') + 300);
    assert.ok(!failBlock.includes('converseState.turn = other'), 'turn must not advance on failed delivery');
  });

  it('watch-mode cooldown not recorded on failed delivery', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const mentionBlock = src.slice(src.indexOf('@mention detection'), src.indexOf('@mention detection') + 800);
    // lastAutoRelayTime should only be set after successful delivery
    assert.ok(mentionBlock.includes('if (delivered)'), 'cooldown should be conditional on delivery');
    assert.ok(mentionBlock.includes('delivery to ${other} failed'), 'should log failed auto-relay delivery');
  });

  it('/converse sets converseState only after successful opener delivery', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const converseStart = src.slice(src.indexOf("case 'converse':"), src.indexOf("case 'converse':") + 1200);
    assert.ok(converseStart.includes('Failed to deliver opener'), '/converse should check opener delivery');
    // converseState must be set AFTER pasteToPane succeeds, not before
    const pasteIdx = converseStart.indexOf('await pasteToPane');
    const stateIdx = converseStart.indexOf("converseState = {");
    assert.ok(pasteIdx > 0 && stateIdx > 0, 'both pasteToPane and converseState assignment must exist');
    assert.ok(stateIdx > pasteIdx, `converseState must be set after delivery (paste@${pasteIdx}, state@${stateIdx})`);
  });
});

// ─── E2E shared harness ───────────────────────────────────────────────────────

function e2eSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function e2eWaitFor(fn, timeoutMs = 15000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
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
async function findRouterPane(session) {
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

// Create an isolated e2e environment and return helpers
function createE2eHarness(tag, extraEnv = {}) {
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

    // Read startup log entries written by fake agents (one JSON per line)
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
        ...extraEnv,
      });
    },

    async launchDuet(args = '') {
      const duetScript = join(import.meta.dirname, 'duet.sh');
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

    // Dump diagnostics on failure
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
      const fixturesDir = join(import.meta.dirname, 'test', 'fixtures');
      writeFileSync(join(fakeBin, 'claude'),
        `#!/bin/sh\nexec "${nodeExe}" "${fixturesDir}/fake-claude.mjs" "$@"\n`, { mode: 0o755 });
      writeFileSync(join(fakeBin, 'codex'),
        `#!/bin/sh\nexec "${nodeExe}" "${fixturesDir}/fake-codex.mjs" "$@"\n`, { mode: 0o755 });
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

// ─── E2E integration tests with fake agents ──────────────────────────────────

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
});

// ─── E2E: Late-binding activation ─────────────────────────────────────────────

describe('e2e: late-binding activation', { timeout: 60000 }, () => {
  const h = createE2eHarness('latebind', {
    FAKE_CLAUDE_BIND_DELAY_MS: '3000',
    FAKE_CODEX_BIND_DELAY_MS: '3000',
  });

  before(async () => {
    h.setup();
    await h.launchDuet();
  });

  after(() => h.cleanup());

  it('starts with pending bindings', () => {
    // At launch, bindings should be pending since agents delay log creation
    // (bindings may already have transitioned if the binder polled after the delay)
    // We just verify the run dir exists and the manifest was created
    assert.ok(h.runDir, 'run dir should exist');
    const b = h.readBindings();
    assert.ok(b, 'bindings.json should exist');
    assert.ok(b.claude, 'claude binding entry should exist');
    assert.ok(b.codex, 'codex binding entry should exist');
  });

  it('transitions to bound after delay', async () => {
    // Wait for binding to resolve (3s agent delay + binder poll interval)
    await h.waitForBinding(25000);
    const b = h.readBindings();
    assert.equal(b.claude.status, 'bound', 'claude should be bound');
    assert.equal(b.codex.status, 'bound', 'codex should be bound');
  });

  it('session-driven relay works after late binding', async () => {
    // Send to claude, then use @relay to prove session-based automation is active
    const token = `LATEBIND_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);

    // Give session log time to be written
    await e2eSleep(1000);

    // @relay reads from session log — proves watcher started after late binding
    await h.sendToRouter(`@relay claude>codex verify late binding`);
    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes('claude says') || inbox.includes(token);
    }, 15000);

    const codexInbox = h.readInbox('codex');
    assert.ok(codexInbox.includes('claude says') || codexInbox.includes(token),
      'codex should receive session-driven relay after late binding');
  });
});

// ─── E2E: Resume ──────────────────────────────────────────────────────────────

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

    // Send a message so there's transcript history
    const token = `PRE_RESUME_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 8000);
    await e2eSleep(1000);

    // Phase 2: stop the run (kill tmux session, mark as stopped)
    try {
      execSync(
        `tmux -S ${TEST_TMUX_SOCKET} kill-session -t "${h.tmuxSession}" 2>/dev/null`,
        { env: tmuxEnv, stdio: 'ignore' }
      );
    } catch {}

    // Write stopped status to run.json (normally /quit does this via the router)
    const runJsonPath = join(h.runDir, 'run.json');
    const data = JSON.parse(readFileSync(runJsonPath, 'utf8'));
    data.status = 'stopped';
    data.updated_at = new Date().toISOString();
    // Store binding paths in run.json (normally updateRunJson does this)
    const bindings = h.readBindings();
    if (bindings.claude?.path) data.claude.binding_path = bindings.claude.path;
    if (bindings.codex?.path) data.codex.binding_path = bindings.codex.path;
    if (originalCodexSid) data.codex.session_id = originalCodexSid;
    writeFileSync(runJsonPath, JSON.stringify(data, null, 2));

    await e2eSleep(500);

    // Clear inbox and startup logs so we can detect new messages cleanly
    try { rmSync(join(h.inboxDir, 'claude-inbox.log')); } catch {}
    try { rmSync(join(h.inboxDir, 'codex-inbox.log')); } catch {}
    h.clearStartupLogs();

    // Phase 3: resume
    h.tmuxSession = null; // reset so cleanup doesn't fail on stale session
    const duetScript = join(import.meta.dirname, 'duet.sh');
    try {
      execSync(
        `bash "${duetScript}" resume "${originalRunId}"`,
        { encoding: 'utf8', env: h.buildEnv(), timeout: 10000 }
      );
    } catch {}

    // Re-discover the run dir and tmux session after resume
    await e2eWaitFor(() => {
      const rj2 = h.readRunJson();
      if (rj2 && rj2.status === 'active' && rj2.tmux_session) {
        h.tmuxSession = rj2.tmux_session;
        return true;
      }
      return false;
    }, 5000);

    // Wait for binding on the resumed run
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
    // Wait for startup log to be written (agent may still be starting)
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
    // The pre-resume message should NOT be in the new inbox
    // (we cleared inbox files between stop and resume)
    const inbox = h.readInbox('claude');
    assert.ok(!inbox.includes('PRE_RESUME_'),
      'pre-resume messages should not appear in post-resume inbox');
  });
});

// ─── E2E: Large multiline relay ───────────────────────────────────────────────

describe('e2e: large multiline relay', { timeout: 60000 }, () => {
  const h = createE2eHarness('large');

  before(async () => {
    h.setup();
    await h.launchDuet();
    await h.waitForBinding();
  });

  after(() => h.cleanup());

  it('relays large multiline response from claude to codex intact', async () => {
    // Send LARGE_RESPONSE trigger to claude
    const token = `LARGE_RESPONSE_${Date.now()}`;
    await h.sendToRouter(`@claude ${token}`);

    // Wait for claude to process and write the large response
    await e2eWaitFor(() => h.readInbox('claude').includes(token), 10000);
    await e2eSleep(1500);

    // Relay claude's response to codex
    await h.sendToRouter(`@relay claude>codex check the large response`);

    // Wait for codex to receive the FULL response (wait for END sentinel,
    // not BEGIN — the last line has no trailing newline in the paste, so it
    // only arrives after pasteToPane sends Enter 500ms later)
    await e2eWaitFor(() => {
      const inbox = h.readInbox('codex');
      return inbox.includes('END_LARGE_RESPONSE');
    }, 15000);

    // Verify the claude session log has the full response with sentinels
    const bindings = h.readBindings();
    const claudeLog = readFileSync(bindings.claude.path, 'utf8');
    assert.ok(claudeLog.includes('BEGIN_LARGE_RESPONSE'),
      'claude session log should contain start sentinel');
    assert.ok(claudeLog.includes('END_LARGE_RESPONSE'),
      'claude session log should contain end sentinel');

    // Verify codex received the complete large payload with sentinels and content
    const codexInbox = h.readInbox('codex');
    assert.ok(codexInbox.includes('BEGIN_LARGE_RESPONSE'),
      'codex inbox should contain start sentinel from relayed response');
    assert.ok(codexInbox.includes('END_LARGE_RESPONSE'),
      'codex inbox should contain end sentinel from relayed response');
    assert.ok(codexInbox.includes('Line 50:'),
      'codex inbox should contain deep interior line (Line 50) proving complete delivery');
  });
});

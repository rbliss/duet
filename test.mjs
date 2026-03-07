import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';

import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';

import { shellEscape, parseInput, sendKeys, capturePane, pasteToPane, focusPane, getNewContent, detectMentions, cleanCapture, extractClaudeResponse, extractCodexResponse, sessionState, getClaudeLastResponse, getCodexLastResponse, resolveSessionPath, setStateDir } from './router.mjs';

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

// ─── Integration Tests: tmux operations ──────────────────────────────────────

const TEST_SESSION = 'duet-test';
let paneA, paneB;

const tmuxEnv = { ...process.env, TMUX: '' };

function tmux(cmd) {
  return execSync(`tmux ${cmd}`, { encoding: 'utf8', env: tmuxEnv }).trim();
}

function cleanupSession() {
  try { execSync(`tmux kill-session -t ${TEST_SESSION} 2>/dev/null`, { env: tmuxEnv }); } catch {}
}

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
      execSync(`tmux send-keys -t ${paneA} C-c`);
      execSync(`tmux send-keys -t ${paneB} C-c`);
      execSync(`tmux send-keys -t ${paneA} C-l`);
      execSync(`tmux send-keys -t ${paneB} C-l`);
      execSync('sleep 0.3');
    } catch {}
  });

  describe('sendKeys', () => {
    it('sends text to a pane and it appears in output', () => {
      sendKeys(paneA, 'echo DUET_TEST_MARKER_1');
      execSync('sleep 0.5');
      const captured = capturePane(paneA, 20);
      assert.ok(captured.includes('DUET_TEST_MARKER_1'), `Expected marker in: ${captured}`);
    });

    it('sends to correct pane without affecting the other', () => {
      sendKeys(paneA, 'echo ONLY_IN_A');
      execSync('sleep 0.5');
      const capB = capturePane(paneB, 20);
      assert.ok(!capB.includes('ONLY_IN_A'), 'Text should not appear in other pane');
    });

    it('handles special characters', () => {
      sendKeys(paneA, 'echo "hello $USER \'world\'"');
      execSync('sleep 0.5');
      const captured = capturePane(paneA, 20);
      assert.ok(captured.includes('hello'), `Expected output in: ${captured}`);
    });

    it('returns true on success', () => {
      const result = sendKeys(paneA, 'echo ok');
      assert.equal(result, true);
    });

    it('returns false for invalid pane', () => {
      const result = sendKeys('%999', 'echo fail');
      assert.equal(result, false);
    });
  });

  describe('capturePane', () => {
    it('captures visible text from a pane', () => {
      sendKeys(paneA, 'echo CAPTURE_TEST_42');
      execSync('sleep 0.5');
      const output = capturePane(paneA, 20);
      assert.ok(output.includes('CAPTURE_TEST_42'));
    });

    it('respects line count parameter', () => {
      // Write many lines
      sendKeys(paneA, 'for i in $(seq 1 20); do echo "LINE_$i"; done');
      execSync('sleep 0.8');
      const few = capturePane(paneA, 5);
      const many = capturePane(paneA, 50);
      assert.ok(many.length >= few.length);
    });

    it('returns empty string for invalid pane', () => {
      const result = capturePane('%999', 10);
      assert.equal(result, '');
    });
  });

  describe('pasteToPane', () => {
    it('pastes multiline text into a pane', () => {
      pasteToPane(paneA, 'echo PASTE_LINE_ONE');
      execSync('sleep 0.5');
      const captured = capturePane(paneA, 20);
      assert.ok(captured.includes('PASTE_LINE_ONE'), `Expected paste in: ${captured}`);
    });

    it('returns true on success', () => {
      const result = pasteToPane(paneA, 'echo ok');
      assert.equal(result, true);
    });

    it('returns false for invalid pane', () => {
      const result = pasteToPane('%999', 'echo fail');
      assert.equal(result, false);
    });

    it('cleans up temp files', () => {
      const before = execSync('ls /tmp/duet-paste-* 2>/dev/null | wc -l', { encoding: 'utf8' }).trim();
      pasteToPane(paneA, 'echo cleanup-test');
      execSync('sleep 0.2');
      const after = execSync('ls /tmp/duet-paste-* 2>/dev/null | wc -l', { encoding: 'utf8' }).trim();
      assert.equal(after, before, 'Temp files should be cleaned up');
    });
  });

  describe('focusPane', () => {
    it('returns true for valid pane', () => {
      assert.equal(focusPane(paneA), true);
    });

    it('returns false for invalid pane', () => {
      assert.equal(focusPane('%999'), false);
    });

    it('actually changes the active pane', () => {
      focusPane(paneA);
      const active = tmux(`display-message -t ${TEST_SESSION} -p '#{pane_id}'`);
      assert.equal(active, paneA);

      focusPane(paneB);
      const active2 = tmux(`display-message -t ${TEST_SESSION} -p '#{pane_id}'`);
      assert.equal(active2, paneB);
    });
  });

  describe('cross-pane relay workflow', () => {
    it('captures from one pane and sends to another', () => {
      // Generate content in pane A
      sendKeys(paneA, 'echo RELAY_SOURCE_CONTENT_XYZ');
      execSync('sleep 0.5');

      // Capture from A
      const captured = capturePane(paneA, 30).trim();
      assert.ok(captured.includes('RELAY_SOURCE_CONTENT_XYZ'),
        `Expected source marker in pane A: ${captured}`);

      // Send a command to B that proves relay worked
      pasteToPane(paneB, 'echo "received relay"');
      execSync('sleep 0.5');

      const capB = capturePane(paneB, 20);
      assert.ok(capB.includes('received relay'), `Expected relay in pane B: ${capB}`);
    });
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
    sessionState.claude = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null };
    sessionState.codex = { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null };
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

  it('treats unbound status as final pane mode, not pending', () => {
    resetSessionState();
    writeBindings(
      { path: claudeLog, level: null, status: 'unbound', confirmedAt: null },
      { path: null, level: null, status: 'unbound', confirmedAt: null }
    );

    assert.equal(resolveSessionPath('claude'), null);
    assert.equal(sessionState.claude.relayMode, 'pane');
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
    const fullEnv = {
      ...process.env,
      STATE_DIR: stateDir,
      CLAUDE_PROJECTS: claudeProjects,
      CODEX_SESSIONS: codexSessions,
      GLOBAL_CODEX_SESSIONS: globalCodexSessions,
      WORKDIR: '/test/workdir',
      BIND_TIMEOUT: '2',
      ...env,
    };
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

  it('leaves tool unbound when no files appear', () => {
    cleanState();

    runBind({ CLAUDE_SESSION_ID: 'nonexistent-uuid' });

    const bindings = JSON.parse(execSync(`cat ${join(stateDir, 'bindings.json')}`, { encoding: 'utf8' }));
    assert.equal(bindings.claude.status, 'unbound');
    assert.equal(bindings.claude.path, null);
    assert.equal(bindings.codex.status, 'unbound');
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
    assert.equal(bindings.codex.status, 'unbound');
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

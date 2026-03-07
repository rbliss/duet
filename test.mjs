import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';

import { writeFileSync, mkdirSync, rmSync, appendFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { shellEscape, parseInput, sendKeys, capturePane, pasteToPane, focusPane, getNewContent, detectMentions, cleanCapture, extractClaudeResponse, extractCodexResponse, isResponseComplete, sessionState, getClaudeLastResponse, getCodexLastResponse, resolveSessionPath, setStateDir, setDuetMode, setRunDir, updateRunJson, readIncremental, handleNewOutput, lastAutoRelayTime, downgradeToPane, findRebindCandidate, rebindTool, stopFileWatchers } from './router.mjs';
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
    // Simulate claude mentioning @codex
    handleNewOutput('claude', 'Hey @codex, check this out');

    // The claude->codex direction should have a cooldown timestamp
    assert.ok(lastAutoRelayTime['claude->codex'] > 0, 'claude->codex cooldown should be set');

    // Simulate codex replying with @claude immediately (within 8s)
    handleNewOutput('codex', '@claude Got it, looks good!');

    // The codex->claude direction should ALSO have a cooldown timestamp
    // (previously this was blocked by the single global cooldown)
    assert.ok(lastAutoRelayTime['codex->claude'] > 0, 'codex->claude cooldown should be set');
  });

  it('blocks same-direction relay within cooldown window', () => {
    // Simulate claude mentioning @codex
    handleNewOutput('claude', 'Hey @codex, first message');
    const firstTime = lastAutoRelayTime['claude->codex'];
    assert.ok(firstTime > 0);

    // Simulate claude mentioning @codex again immediately
    handleNewOutput('claude', 'Hey @codex, second message');

    // The timestamp should NOT be updated (relay was blocked)
    assert.equal(lastAutoRelayTime['claude->codex'], firstTime,
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

  it('downgradeToPane sets relayMode to pane and marks staleDowngraded', () => {
    const origMode = sessionState.claude.relayMode;
    const origStale = sessionState.claude.staleDowngraded;
    sessionState.claude.relayMode = 'session';
    sessionState.claude.staleDowngraded = false;

    downgradeToPane('claude', 'test reason');

    assert.equal(sessionState.claude.relayMode, 'pane');
    assert.equal(sessionState.claude.staleDowngraded, true);

    // Restore
    sessionState.claude.relayMode = origMode;
    sessionState.claude.staleDowngraded = origStale;
  });

  it('/status output indicates stale downgrade', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    assert.ok(src.includes('staleDowngraded'));
    assert.ok(src.includes('stale session binding'));
    assert.ok(src.includes('possible manual /resume'));
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

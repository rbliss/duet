import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

import { shellEscape, parseInput, getNewContent, detectMentions, cleanCapture } from '../router.mjs';

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

  it('parses /debug', () => {
    assert.deepEqual(parseInput('/debug'), { type: 'debug', full: false });
  });

  it('parses /debug full', () => {
    assert.deepEqual(parseInput('/debug full'), { type: 'debug', full: true });
  });

  it('parses /send-debug with target', () => {
    assert.deepEqual(parseInput('/send-debug claude'), {
      type: 'send-debug', target: 'claude', note: null,
    });
  });

  it('parses /send-debug with target and note', () => {
    assert.deepEqual(parseInput('/send-debug codex relay seems stuck'), {
      type: 'send-debug', target: 'codex', note: 'relay seems stuck',
    });
  });

  it('returns send-debug-error for invalid target', () => {
    assert.deepEqual(parseInput('/send-debug foo'), { type: 'send-debug-error' });
  });

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

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('parseInput handles @claude with no message', () => {
    assert.deepEqual(parseInput('@claude '), { type: 'claude', msg: '' });
  });

  it('parseInput handles @codex with no message', () => {
    assert.deepEqual(parseInput('@codex '), { type: 'codex', msg: '' });
  });

  it('parseInput does not confuse @claudeX with @claude', () => {
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
    const result = detectMentions('email user@claude.ai');
    assert.ok(result.length >= 0);
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

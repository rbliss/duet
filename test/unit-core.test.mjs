import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

import { shellEscape, parseInput, detectMentions } from '../router.mjs';

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

// ─── Unit Tests: detectMentions ──────────────────────────────────────────────

describe('detectMentions', () => {
  // ── Line-start mentions (should trigger) ──
  it('detects @claude at start of text', () => {
    assert.deepEqual(detectMentions('@claude check this'), ['claude']);
  });

  it('detects @codex at start of text', () => {
    assert.deepEqual(detectMentions('@codex review this'), ['codex']);
  });

  it('detects @mention at start of a later line', () => {
    assert.deepEqual(detectMentions('Some preamble\n@codex here is the update'), ['codex']);
  });

  it('detects both when each starts a line', () => {
    const result = detectMentions('@claude first part\n@codex second part');
    assert.ok(result.includes('claude'));
    assert.ok(result.includes('codex'));
    assert.equal(result.length, 2);
  });

  it('is case insensitive', () => {
    assert.deepEqual(detectMentions('@Claude do this'), ['claude']);
    assert.deepEqual(detectMentions('@CODEX do that'), ['codex']);
  });

  it('matches with leading whitespace on line', () => {
    assert.deepEqual(detectMentions('  @codex indented address'), ['codex']);
  });

  it('matches with punctuation after mention', () => {
    assert.deepEqual(detectMentions('@claude, what do you think?'), ['claude']);
    assert.deepEqual(detectMentions('@codex - here is my update'), ['codex']);
  });

  it('requires word boundary after mention', () => {
    assert.deepEqual(detectMentions('@claudeX something'), []);
  });

  it('returns empty for no mentions', () => {
    assert.deepEqual(detectMentions('no mentions here'), []);
  });

  // ── Inline mentions (should NOT trigger) ──
  it('ignores inline @codex in prose', () => {
    assert.deepEqual(detectMentions('share with @codex so we can converge'), []);
  });

  it('ignores inline @claude in prose', () => {
    assert.deepEqual(detectMentions('I think @claude should look at this'), []);
  });

  it('ignores mid-sentence mention', () => {
    assert.deepEqual(detectMentions('thoughts @claude'), []);
  });

  it('ignores inline mention after verb', () => {
    assert.deepEqual(detectMentions('ask @codex.'), []);
  });

  // ── Live failure regression: real Claude output ──
  it('ignores incidental mention from real Claude output', () => {
    const text = "I'll synthesize all findings once they complete and share with @codex so we can converge on the final architecture.";
    assert.deepEqual(detectMentions(text), []);
  });

  it('detects explicit address from real Claude output', () => {
    const text = "Here are my findings:\n\n@codex - Great analysis. Here's my implementor-angle pressure test of your proposal:";
    assert.deepEqual(detectMentions(text), ['codex']);
  });

  // ── Code fences (should NOT trigger) ──
  it('ignores @mention inside fenced code block', () => {
    const text = 'Here is an example:\n```\n@codex do something\n```\nEnd of message.';
    assert.deepEqual(detectMentions(text), []);
  });

  it('ignores @mention inside triple-backtick with language', () => {
    const text = '```typescript\n@claude run tests\n```';
    assert.deepEqual(detectMentions(text), []);
  });

  // ── Blockquotes (should NOT trigger) ──
  it('ignores @mention in blockquote', () => {
    assert.deepEqual(detectMentions('> @codex said something earlier'), []);
  });

  it('ignores nested blockquote mention', () => {
    assert.deepEqual(detectMentions('> > @claude agreed with this'), []);
  });

  // ── Mixed scenarios ──
  it('detects line-start mention but ignores inline in same text', () => {
    const text = 'I agree with @codex on this.\n\n@claude - please review the implementation';
    const result = detectMentions(text);
    assert.deepEqual(result, ['claude']);
  });

  it('does not double-count same mention on multiple lines', () => {
    const text = '@codex first point\n@codex second point';
    assert.deepEqual(detectMentions(text), ['codex']);
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
    assert.deepEqual(detectMentions('email user@claude.ai'), []);
  });
});

// ─── Unit Tests: parseInput multiline ─────────────────────────────────────

describe('parseInput multiline', () => {
  it('@claude preserves multiline body', () => {
    const input = '@claude Here is the plan:\n  Step 1: do this\n  Step 2: do that';
    const result = parseInput(input);
    assert.equal(result.type, 'claude');
    assert.equal(result.msg, 'Here is the plan:\n  Step 1: do this\n  Step 2: do that');
  });

  it('@codex preserves multiline body with indentation', () => {
    const input = '@codex Review this code:\n  function foo() {\n    return 42;\n  }';
    const result = parseInput(input);
    assert.equal(result.type, 'codex');
    assert.ok(result.msg.includes('  function foo() {'));
    assert.ok(result.msg.includes('    return 42;'));
  });

  it('@both preserves multiline body', () => {
    const input = '@both Run these tests:\ntest 1\ntest 2\ntest 3';
    const result = parseInput(input);
    assert.equal(result.type, 'both');
    assert.equal(result.msg, 'Run these tests:\ntest 1\ntest 2\ntest 3');
  });

  it('@relay preserves multiline prompt', () => {
    const input = '@relay claude>codex Here is context:\nline 1\nline 2';
    const result = parseInput(input);
    assert.equal(result.type, 'relay');
    assert.equal(result.from, 'claude');
    assert.equal(result.to, 'codex');
    assert.equal(result.prompt, 'Here is context:\nline 1\nline 2');
  });

  it('preserves blank lines in body', () => {
    const input = '@claude First paragraph\n\nSecond paragraph';
    const result = parseInput(input);
    assert.equal(result.type, 'claude');
    assert.equal(result.msg, 'First paragraph\n\nSecond paragraph');
  });

  it('single-line commands still work normally', () => {
    assert.deepEqual(parseInput('/help'), { type: 'help' });
    assert.deepEqual(parseInput('/quit'), { type: 'quit' });
    assert.deepEqual(parseInput('@claude single line'), { type: 'claude', msg: 'single line' });
  });
});

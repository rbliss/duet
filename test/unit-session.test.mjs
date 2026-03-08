import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';

import { extractClaudeResponse, extractCodexResponse, isResponseComplete, sessionState, getClaudeLastResponse, getCodexLastResponse } from '../router.mjs';

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

  it('extracts from event_msg agent_message (Codex CLI ≥0.105)', () => {
    const obj = { type: 'event_msg', payload: { type: 'agent_message', message: '@claude\n\n## Task: gap scan\n\nHere is the analysis.' } };
    const result = extractCodexResponse(obj);
    assert.ok(result.includes('@claude'));
    assert.ok(result.includes('gap scan'));
  });

  it('extracts from response_item assistant message', () => {
    const obj = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: '@claude here is the result' },
    ] } };
    assert.equal(extractCodexResponse(obj), '@claude here is the result');
  });

  it('response_item with multiple content blocks', () => {
    const obj = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: 'Part 1 @claude' },
      { type: 'output_text', text: 'Part 2' },
    ] } };
    assert.equal(extractCodexResponse(obj), 'Part 1 @claude\nPart 2');
  });

  it('returns null for response_item user message', () => {
    const obj = { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'hi' },
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
    const msg1 = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] } });
    writeFileSync(claudeLog, msg1 + '\n');

    sessionState.claude.path = claudeLog;
    sessionState.claude.resolved = true;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;

    assert.equal(getClaudeLastResponse(), 'First response');
  });

  it('picks up new messages without re-reading old ones', () => {
    const offsetBefore = sessionState.claude.offset;
    assert.ok(offsetBefore > 0, 'Offset should have advanced from previous read');

    const msg2 = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }] } });
    appendFileSync(claudeLog, msg2 + '\n');

    assert.equal(getClaudeLastResponse(), 'Second response');
    assert.ok(sessionState.claude.offset > offsetBefore, 'Offset should have advanced further');
  });

  it('skips non-assistant lines', () => {
    const userMsg = JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'user says hi' }] } });
    appendFileSync(claudeLog, userMsg + '\n');

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
    const savedPath = sessionState.claude.path;
    const savedResolved = sessionState.claude.resolved;
    const savedOffset = sessionState.claude.offset;
    const savedResponse = sessionState.claude.lastResponse;

    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;

    assert.equal(getClaudeLastResponse(), null);

    sessionState.claude.path = savedPath;
    sessionState.claude.resolved = savedResolved;
    sessionState.claude.offset = savedOffset;
    sessionState.claude.lastResponse = savedResponse;
  });

  it('does not re-read when file has not grown', () => {
    const offsetBefore = sessionState.claude.offset;
    getClaudeLastResponse();
    assert.equal(sessionState.claude.offset, offsetBefore);
  });

  it('handles partial lines correctly', () => {
    const partial = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Partial' }] } });
    appendFileSync(claudeLog, partial);

    const before = sessionState.claude.lastResponse;
    getClaudeLastResponse();
    assert.equal(sessionState.claude.lastResponse, before);

    appendFileSync(claudeLog, '\n');
    assert.equal(getClaudeLastResponse(), 'Partial');
  });
});

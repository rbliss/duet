import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';

import { extractClaudeResponse, extractCodexResponse, isResponseComplete, isClaudeApiError, isClaudeApiErrorObj, readIncremental, sessionState, getClaudeLastResponse, getCodexLastResponse, getLastRelayableResponse } from '../router.mjs';

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
    sessionState.claude.lastRelayableResponse = null;
    sessionState.codex.path = null;
    sessionState.codex.resolved = false;
    sessionState.codex.offset = 0;
    sessionState.codex.lastResponse = null;
    sessionState.codex.lastRelayableResponse = null;
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
    const savedRelayable = sessionState.claude.lastRelayableResponse;

    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.lastRelayableResponse = null;

    assert.equal(getClaudeLastResponse(), null);

    sessionState.claude.path = savedPath;
    sessionState.claude.resolved = savedResolved;
    sessionState.claude.offset = savedOffset;
    sessionState.claude.lastResponse = savedResponse;
    sessionState.claude.lastRelayableResponse = savedRelayable;
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

// ─── Unit Tests: isClaudeApiError ─────────────────────────────────────────────

describe('isClaudeApiError', () => {
  it('detects "Request too large" synthetic error', () => {
    assert.equal(isClaudeApiError('Request too large (max 20MB). Double press esc to go back and try with a smaller file.'), true);
  });

  it('detects Anthropic API error type names', () => {
    assert.equal(isClaudeApiError('invalid_request_error: prompt is too long'), true);
    assert.equal(isClaudeApiError('overloaded_error'), true);
    assert.equal(isClaudeApiError('rate_limit_error: too many requests'), true);
    assert.equal(isClaudeApiError('api_error'), true);
    assert.equal(isClaudeApiError('authentication_error'), true);
    assert.equal(isClaudeApiError('permission_error'), true);
    assert.equal(isClaudeApiError('not_found_error'), true);
    assert.equal(isClaudeApiError('server_error'), true);
  });

  it('does not flag normal model responses', () => {
    assert.equal(isClaudeApiError('Here is the analysis you requested.'), false);
    assert.equal(isClaudeApiError('@codex\n\n## Done: SA-128\n\nLong response here...'), false);
    assert.equal(isClaudeApiError('The request was too large for the API to handle, so I split it.'), false);
  });

  it('does not flag text that mentions error types inline', () => {
    assert.equal(isClaudeApiError('I got an invalid_request_error when testing the API.'), false);
  });

  it('handles whitespace trimming', () => {
    assert.equal(isClaudeApiError('  Request too large  '), true);
  });
});

// ─── Unit Tests: isClaudeApiErrorObj (structured markers) ─────────────────────

describe('isClaudeApiErrorObj', () => {
  it('detects top-level isApiErrorMessage: true', () => {
    assert.equal(isClaudeApiErrorObj({ isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Some novel error wording' }] } }), true);
  });

  it('detects top-level type: error', () => {
    assert.equal(isClaudeApiErrorObj({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt too long' } }), true);
  });

  it('detects top-level error string field', () => {
    assert.equal(isClaudeApiErrorObj({ error: 'invalid_request', message: { role: 'assistant', content: [{ type: 'text', text: 'Something went wrong' }] } }), true);
  });

  it('detects nested message.isApiErrorMessage: true', () => {
    assert.equal(isClaudeApiErrorObj({ message: { role: 'assistant', isApiErrorMessage: true, content: [{ type: 'text', text: 'Unexpected error text' }] } }), true);
  });

  it('detects nested message.error string', () => {
    assert.equal(isClaudeApiErrorObj({ message: { role: 'assistant', error: 'rate_limit', content: [{ type: 'text', text: 'Try again later' }] } }), true);
  });

  it('does not flag normal assistant messages', () => {
    assert.equal(isClaudeApiErrorObj({ message: { role: 'assistant', content: [{ type: 'text', text: 'Normal response' }] } }), false);
  });

  it('does not flag result type', () => {
    assert.equal(isClaudeApiErrorObj({ type: 'result', result: {} }), false);
  });

  it('does not flag empty error string', () => {
    assert.equal(isClaudeApiErrorObj({ error: '', message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] } }), false);
  });
});

// ─── Regression: structured API error does not clobber relayable response ─────

describe('structured API error does not clobber relayable response', () => {
  const tmpDir = '/tmp/duet-test-structured-error-' + process.pid;
  const claudeLog = join(tmpDir, 'claude-structured.jsonl');

  before(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.lastRelayableResponse = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isApiErrorMessage:true with novel text does not become relayable', () => {
    // Good response first
    const goodMsg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the real analysis.' }] } });
    writeFileSync(claudeLog, goodMsg + '\n');

    sessionState.claude.path = claudeLog;
    sessionState.claude.resolved = true;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.lastRelayableResponse = null;

    readIncremental('claude');
    assert.equal(sessionState.claude.lastRelayableResponse, 'Here is the real analysis.');

    // Structured API error with text that does NOT match any regex pattern
    const errorMsg = JSON.stringify({
      isApiErrorMessage: true,
      error: 'invalid_request',
      message: { role: 'assistant', content: [{ type: 'text', text: 'A completely novel error message that no regex would catch.' }] },
    });
    appendFileSync(claudeLog, errorMsg + '\n');

    const result = readIncremental('claude');
    assert.equal(result.hasNew, true);
    assert.equal(result.relayContent, null, 'structured error should not produce relayContent');

    // Raw lastResponse is clobbered (for debug), but relayable is preserved
    assert.equal(sessionState.claude.lastResponse, 'A completely novel error message that no regex would catch.');
    assert.equal(sessionState.claude.lastRelayableResponse, 'Here is the real analysis.');
  });

  it('message.error field with novel text does not become relayable', () => {
    const log2 = join(tmpDir, 'claude-msg-error.jsonl');
    const goodMsg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Good response.' }] } });
    writeFileSync(log2, goodMsg + '\n');

    sessionState.claude.path = log2;
    sessionState.claude.resolved = true;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.lastRelayableResponse = null;

    readIncremental('claude');
    assert.equal(sessionState.claude.lastRelayableResponse, 'Good response.');

    // Error with message.error field but no isApiErrorMessage
    const errorMsg = JSON.stringify({
      message: { role: 'assistant', error: 'some_new_error_type', content: [{ type: 'text', text: 'Brand new error nobody predicted.' }] },
    });
    appendFileSync(log2, errorMsg + '\n');

    const result = readIncremental('claude');
    assert.equal(result.relayContent, null, 'message.error should prevent relayability');
    assert.equal(sessionState.claude.lastRelayableResponse, 'Good response.');
  });
});

// ─── Regression: API error does not clobber relayable response ───────────────

describe('relayable response survives API error clobbering', () => {
  const tmpDir = '/tmp/duet-test-relay-clobber-' + process.pid;
  const claudeLog = join(tmpDir, 'claude-clobber.jsonl');

  before(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    sessionState.claude.path = null;
    sessionState.claude.resolved = false;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.lastRelayableResponse = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('good response followed by API error does not clobber relay source', () => {
    // Write a good relayable response
    const goodMsg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: '@codex\n\n## Done: SA-128\n\nHere is the implementation.' }] } });
    writeFileSync(claudeLog, goodMsg + '\n');

    sessionState.claude.path = claudeLog;
    sessionState.claude.resolved = true;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.lastRelayableResponse = null;

    const result1 = readIncremental('claude');
    assert.equal(result1.hasNew, true);
    assert.ok(result1.relayContent.includes('@codex'));
    assert.equal(sessionState.claude.lastRelayableResponse, '@codex\n\n## Done: SA-128\n\nHere is the implementation.');

    // Append a synthetic API error
    const errorMsg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Request too large (max 20MB). Double press esc to go back and try with a smaller file.' }] } });
    appendFileSync(claudeLog, errorMsg + '\n');

    const result2 = readIncremental('claude');
    assert.equal(result2.hasNew, true);
    assert.equal(result2.relayContent, null, 'error text should not be relayable');

    // lastResponse is clobbered (expected for debug), but lastRelayableResponse is preserved
    assert.ok(sessionState.claude.lastResponse.includes('Request too large'));
    assert.equal(sessionState.claude.lastRelayableResponse, '@codex\n\n## Done: SA-128\n\nHere is the implementation.');

    // getLastRelayableResponse returns the good response
    assert.ok(getLastRelayableResponse('claude').includes('@codex'));
  });

  it('readIncremental returns relayContent for good responses', () => {
    // Reset and write a new good response
    const log2 = join(tmpDir, 'claude-relay-ok.jsonl');
    const msg = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'RELAY_OK' }] } });
    writeFileSync(log2, msg + '\n');

    sessionState.claude.path = log2;
    sessionState.claude.resolved = true;
    sessionState.claude.offset = 0;
    sessionState.claude.lastResponse = null;
    sessionState.claude.lastRelayableResponse = null;

    const result = readIncremental('claude');
    assert.equal(result.relayContent, 'RELAY_OK');
    assert.equal(sessionState.claude.lastRelayableResponse, 'RELAY_OK');
  });

  it('codex responses are always relayable', () => {
    const log3 = join(tmpDir, 'codex-relay.jsonl');
    const msg = JSON.stringify({ payload: { type: 'task_complete', last_agent_message: 'api_error happened but this is codex text' } });
    writeFileSync(log3, msg + '\n');

    sessionState.codex.path = log3;
    sessionState.codex.resolved = true;
    sessionState.codex.offset = 0;
    sessionState.codex.lastResponse = null;
    sessionState.codex.lastRelayableResponse = null;

    const result = readIncremental('codex');
    assert.equal(result.relayContent, 'api_error happened but this is codex text');
    assert.equal(sessionState.codex.lastRelayableResponse, 'api_error happened but this is codex text');

    // cleanup
    sessionState.codex.path = null;
    sessionState.codex.resolved = false;
    sessionState.codex.offset = 0;
    sessionState.codex.lastResponse = null;
    sessionState.codex.lastRelayableResponse = null;
  });
});

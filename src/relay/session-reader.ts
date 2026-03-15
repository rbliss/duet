import type { ToolName, SessionToolState, SessionStateMap, IncrementalReadResult } from '../types/runtime.js';
import { statSync, openSync, readSync, closeSync, readFileSync } from 'fs';
import { STATE_DIR, loadBindings } from '../runtime/bindings-store.js';
import { updateRunJson } from '../runtime/run-store.js';

let DUET_MODE = process.env.DUET_MODE || 'new';

export function setDuetMode(mode: string): void { DUET_MODE = mode; }

// Session ownership model:
//   - Claude: launcher generates a UUID, passes --session-id, polls until the
//     exact UUID-named .jsonl appears on disk. Process-level ownership.
//   - Codex: launcher sets CODEX_HOME to a run-scoped overlay that isolates
//     session storage while reusing auth/config (read-only). Process-level if
//     CODEX_HOME works; degrades to workspace-level if it doesn't.
//     Only read-only config is shared — mutable SQLite state is NOT symlinked.
//
// Each session is read incrementally via a byte-offset cursor. On each call
// we read only new bytes appended since the last read, parse complete JSONL
// lines, and update a cached lastResponse.

// relayMode tracks durable binding state per tool:
//   'pending'  — binder is still looking for session file
//   'session'  — authoritative session binding exists
//   'pane'     — binding degraded or unavailable
// bindingLevel describes the ownership guarantee:
//   'process'   — bound to exact launched process (both Claude and Codex)
//   null        — not yet bound
export const sessionState: SessionStateMap = {
  claude: { path: null, resolved: false, offset: 0, lastResponse: null, lastRelayableResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0 },
  codex:  { path: null, resolved: false, offset: 0, lastResponse: null, lastRelayableResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0 },
};

export function resolveSessionPath(tool: ToolName): string | null {
  const st = sessionState[tool];
  if (st.resolved) return st.path;
  if (!STATE_DIR) {
    st.relayMode = 'pane';
    return null;
  }
  const bindings = loadBindings();
  if (bindings && bindings[tool]) {
    const b = bindings[tool];
    if (b.status === 'bound' && b.path) {
      st.path = b.path;
      st.resolved = true;
      st.relayMode = 'session';
      st.bindingLevel = b.level || null;

      // On resume, seek reader to end of file to avoid replaying history
      if (DUET_MODE === 'resumed' && st.path) {
        try {
          const { size } = statSync(st.path);
          st.offset = size;
        } catch {}
      }

      // Propagate binding info to run.json
      const updates: Record<string, string> = { [`${tool}.binding_path`]: b.path, updated_at: new Date().toISOString() };
      if (b.session_id) updates[`${tool}.session_id`] = b.session_id;
      updateRunJson(updates);

      return st.path;
    }
    if (b.status === 'degraded') {
      // Binder gave up — terminal state
      st.resolved = true;
      st.relayMode = 'pane';
      return null;
    }
    // status === 'pending' — binder is still looking
    st.relayMode = 'pending';
    return null;
  }
  // No manifest yet — genuinely pending
  st.relayMode = 'pending';
  return null;
}

export function extractClaudeResponse(obj: Record<string, unknown>): string | null {
  const msg = obj.message as Record<string, unknown> | undefined;
  if (msg?.role !== 'assistant') return null;
  const texts: string[] = [];
  for (const block of (msg.content || []) as Array<Record<string, unknown>>) {
    if (block.type === 'text' && block.text) texts.push(block.text as string);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

export function extractCodexResponse(obj: Record<string, unknown>): string | null {
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (payload?.type === 'task_complete' && payload.last_agent_message) {
    return payload.last_agent_message as string;
  }
  // event_msg with agent_message (Codex CLI ≥0.105)
  if (obj.type === 'event_msg' && payload?.type === 'agent_message' && typeof payload.message === 'string') {
    return payload.message;
  }
  // response_item or event_msg with assistant message content blocks
  if ((obj.type === 'response_item' || obj.type === 'event_msg') && payload?.role === 'assistant') {
    const texts: string[] = [];
    for (const block of (payload.content || []) as Array<Record<string, unknown>>) {
      if (block.type === 'output_text' && block.text) texts.push(block.text as string);
      if (block.type === 'text' && block.text) texts.push(block.text as string);
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

export function isResponseComplete(tool: string, obj: Record<string, unknown>): boolean {
  if (tool === 'claude') {
    if (obj.type === 'result') return true;
    const msg = obj.message as Record<string, unknown> | undefined;
    if (msg?.role === 'assistant' && msg?.stop_reason === 'end_turn') return true;
  }
  if (tool === 'codex') {
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (payload?.type === 'task_complete') return true;
  }
  return false;
}

/**
 * Detect Claude Code synthetic API error messages via structured JSONL fields.
 * Claude Code marks these entries with `isApiErrorMessage: true` and/or an
 * `error` field. Checking these first catches any error wording we haven't
 * seen yet.
 */
export function isClaudeApiErrorObj(obj: Record<string, unknown>): boolean {
  if (obj.isApiErrorMessage === true) return true;
  if (obj.type === 'error') return true;
  if (typeof obj.error === 'string' && obj.error.length > 0) return true;
  const msg = obj.message as Record<string, unknown> | undefined;
  if (msg?.isApiErrorMessage === true) return true;
  if (typeof msg?.error === 'string' && (msg.error as string).length > 0) return true;
  return false;
}

/**
 * Detect Claude Code synthetic API error messages by text content (fallback).
 * Catches known error text patterns when the JSONL entry lacks structured
 * error markers.
 */
export function isClaudeApiError(text: string): boolean {
  const trimmed = text.trim();
  if (/^Request too large\b/.test(trimmed)) return true;
  if (/^(invalid_request_error|overloaded_error|rate_limit_error|api_error|authentication_error|permission_error|not_found_error|server_error)\b/.test(trimmed)) return true;
  return false;
}

function isRelayable(tool: ToolName, text: string, obj: Record<string, unknown>): boolean {
  if (tool === 'codex') return true;
  // Structured markers first — catches any error wording
  if (isClaudeApiErrorObj(obj)) return false;
  // Text fallback for entries without structured markers
  return !isClaudeApiError(text);
}

export function readIncremental(tool: ToolName): IncrementalReadResult {
  const st = sessionState[tool];
  const filePath = resolveSessionPath(tool);
  if (!filePath) return { hasNew: false, complete: false, relayContent: null };
  let hasNew = false;
  let complete = false;
  let relayContent: string | null = null;
  try {
    const { size } = statSync(filePath);
    if (size <= st.offset) return { hasNew: false, complete: false, relayContent: null };
    const fd = openSync(filePath, 'r');
    try {
      const len = size - st.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.offset);
      const chunk = buf.toString('utf8');
      // Only process complete lines; save any trailing partial line for next read
      const lastNl = chunk.lastIndexOf('\n');
      if (lastNl < 0) return { hasNew: false, complete: false, relayContent: null };
      const completeText = chunk.slice(0, lastNl);
      st.offset += lastNl + 1; // advance past the newline
      // Parse lines and update cached response
      const lines = completeText.split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const extracted = tool === 'claude'
            ? extractClaudeResponse(obj)
            : extractCodexResponse(obj);
          if (extracted) {
            st.lastResponse = extracted;
            hasNew = true;
            if (isRelayable(tool, extracted, obj)) {
              st.lastRelayableResponse = extracted;
              relayContent = extracted;
            }
          }
          if (isResponseComplete(tool, obj)) complete = true;
        } catch {}
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
  return { hasNew, complete, relayContent };
}

export function getClaudeLastResponse(): string | null {
  readIncremental('claude');
  return sessionState.claude.lastResponse;
}

export function getCodexLastResponse(): string | null {
  readIncremental('codex');
  return sessionState.codex.lastResponse;
}

export function getLastResponse(tool: ToolName): string | null {
  return tool === 'claude' ? getClaudeLastResponse() : getCodexLastResponse();
}

export function getLastRelayableResponse(tool: ToolName): string | null {
  readIncremental(tool);
  return sessionState[tool].lastRelayableResponse;
}

export function extractCodexSessionId(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8');
    const firstLine = content.split('\n')[0];
    if (!firstLine) return null;
    const obj = JSON.parse(firstLine);
    const id = obj?.payload?.id;
    return id || null;
  } catch {
    return null;
  }
}

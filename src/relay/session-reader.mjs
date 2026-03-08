/**
 * @typedef {import('../types/runtime.js').ToolName} ToolName
 * @typedef {import('../types/runtime.js').SessionToolState} SessionToolState
 * @typedef {import('../types/runtime.js').SessionStateMap} SessionStateMap
 * @typedef {import('../types/runtime.js').IncrementalReadResult} IncrementalReadResult
 */

import { statSync, openSync, readSync, closeSync, readFileSync } from 'fs';
import { STATE_DIR, loadBindings } from '../runtime/bindings-store.js';
import { updateRunJson } from '../runtime/run-store.js';

let DUET_MODE = process.env.DUET_MODE || 'new';

/** @param {string} mode */
export function setDuetMode(mode) { DUET_MODE = mode; }

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
/** @type {SessionStateMap} */
export const sessionState = {
  claude: { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false },
  codex:  { path: null, resolved: false, offset: 0, lastResponse: null, relayMode: 'pending', bindingLevel: null, lastSessionActivityAt: 0, staleDowngraded: false },
};

/**
 * @param {ToolName} tool
 * @returns {string | null}
 */
export function resolveSessionPath(tool) {
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
      /** @type {Record<string, string>} */
      const updates = { [`${tool}.binding_path`]: b.path, updated_at: new Date().toISOString() };
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

/**
 * @param {Record<string, unknown>} obj
 * @returns {string | null}
 */
export function extractClaudeResponse(obj) {
  const msg = /** @type {Record<string, unknown> | undefined} */ (obj.message);
  if (msg?.role !== 'assistant') return null;
  /** @type {string[]} */
  const texts = [];
  for (const block of /** @type {Array<Record<string, unknown>>} */ (msg.content || [])) {
    if (block.type === 'text' && block.text) texts.push(/** @type {string} */ (block.text));
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {string | null}
 */
export function extractCodexResponse(obj) {
  const payload = /** @type {Record<string, unknown> | undefined} */ (obj.payload);
  if (payload?.type === 'task_complete' && payload.last_agent_message) {
    return /** @type {string} */ (payload.last_agent_message);
  }
  if (obj.type === 'event_msg' && payload?.type === 'message' && payload.role === 'assistant') {
    /** @type {string[]} */
    const texts = [];
    for (const block of /** @type {Array<Record<string, unknown>>} */ (payload.content || [])) {
      if (block.type === 'output_text' && block.text) texts.push(/** @type {string} */ (block.text));
      if (block.type === 'text' && block.text) texts.push(/** @type {string} */ (block.text));
    }
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

/**
 * Detect JSONL entries that signal the tool has finished its response.
 * @param {string} tool
 * @param {Record<string, unknown>} obj
 * @returns {boolean}
 */
export function isResponseComplete(tool, obj) {
  if (tool === 'claude') {
    if (obj.type === 'result') return true;
    const msg = /** @type {Record<string, unknown> | undefined} */ (obj.message);
    if (msg?.role === 'assistant' && msg?.stop_reason === 'end_turn') return true;
  }
  if (tool === 'codex') {
    const payload = /** @type {Record<string, unknown> | undefined} */ (obj.payload);
    if (payload?.type === 'task_complete') return true;
  }
  return false;
}

/**
 * @param {ToolName} tool
 * @returns {IncrementalReadResult}
 */
export function readIncremental(tool) {
  const st = sessionState[tool];
  const filePath = resolveSessionPath(tool);
  if (!filePath) return { hasNew: false, complete: false };
  let hasNew = false;
  let complete = false;
  try {
    const { size } = statSync(filePath);
    if (size <= st.offset) return { hasNew: false, complete: false };
    const fd = openSync(filePath, 'r');
    try {
      const len = size - st.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.offset);
      const chunk = buf.toString('utf8');
      // Only process complete lines; save any trailing partial line for next read
      const lastNl = chunk.lastIndexOf('\n');
      if (lastNl < 0) return { hasNew: false, complete: false };
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
          if (extracted) { st.lastResponse = extracted; hasNew = true; }
          if (isResponseComplete(tool, obj)) complete = true;
        } catch {}
      }
    } finally {
      closeSync(fd);
    }
  } catch {}
  return { hasNew, complete };
}

/** @returns {string | null} */
export function getClaudeLastResponse() {
  readIncremental('claude');
  return sessionState.claude.lastResponse;
}

/** @returns {string | null} */
export function getCodexLastResponse() {
  readIncremental('codex');
  return sessionState.codex.lastResponse;
}

/**
 * @param {ToolName} tool
 * @returns {string | null}
 */
export function getLastResponse(tool) {
  return tool === 'claude' ? getClaudeLastResponse() : getCodexLastResponse();
}

/**
 * Extract Codex session ID from payload.id in the first JSONL line.
 * @param {string} filePath
 * @returns {string | null}
 */
export function extractCodexSessionId(filePath) {
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

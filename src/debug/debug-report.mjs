/**
 * @typedef {import('../types/runtime.js').DebugSnapshotInput} DebugSnapshotInput
 */

import { readFileSync, statSync } from 'fs';

// Truncation limits
const RESPONSE_PREVIEW_LEN = 200;
const RESPONSE_PREVIEW_FULL_LEN = 500;
const LOG_TAIL_LINES = 5;
const LOG_TAIL_FULL_LINES = 20;
const PANE_CAPTURE_LINES = 30;

/**
 * @param {string | null | undefined} str
 * @param {number} maxLen
 * @returns {string | null}
 */
function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || null;
  return str.slice(0, maxLen) + `… [${str.length - maxLen} more chars]`;
}

/**
 * @param {string} filePath
 * @param {number} n
 * @returns {{ lines: string[], totalLines: number } | null}
 */
function tailLines(filePath, n) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trimEnd().split('\n');
    const tail = lines.slice(-n);
    return { lines: tail, totalLines: lines.length };
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @returns {number | null}
 */
function fileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * Normalize relayMode to user-facing binding status.
 * @param {string} relayMode
 * @returns {string}
 */
function normalizeBindingStatus(relayMode) {
  if (relayMode === 'session') return 'bound';
  if (relayMode === 'pending') return 'pending';
  return 'degraded';
}

/**
 * Collect a debug snapshot from the current Duet session state.
 * @param {DebugSnapshotInput} params
 * @returns {Record<string, unknown>}
 */
export function collectDebugSnapshot({ sessionState, routerState, bindings, runJson, paneCaptures, full = false }) {
  const previewLen = full ? RESPONSE_PREVIEW_FULL_LEN : RESPONSE_PREVIEW_LEN;
  const tailN = full ? LOG_TAIL_FULL_LINES : LOG_TAIL_LINES;

  /** @type {Record<string, unknown>} */
  const tools = {};
  for (const tool of ['claude', 'codex']) {
    const st = /** @type {Record<string, unknown>} */ (sessionState[tool]);
    const stPath = /** @type {string | null} */ (st.path);
    const logTail = stPath ? tailLines(stPath, tailN) : null;

    // Cross-file binding comparison
    const bindingsEntry = bindings ? /** @type {Record<string, unknown> | null} */ (/** @type {unknown} */ (bindings[/** @type {'claude' | 'codex'} */ (tool)])) : null;
    const runEntry = runJson ? /** @type {Record<string, unknown> | null} */ (runJson[tool]) : null;

    tools[tool] = {
      // Normalized user-facing status
      bindingStatus: normalizeBindingStatus(/** @type {string} */ (st.relayMode)),
      // Raw relayMode for implementation detail
      relayMode: st.relayMode,
      bindingLevel: st.bindingLevel,
      // Live router/session state
      livePath: stPath,
      watcherActive: routerState.fileWatcherActive[/** @type {'claude' | 'codex'} */ (tool)] || false,
      watcherFailed: routerState.watcherFailed.includes(tool),
      pending: routerState.pendingTools.includes(tool),
      offset: st.offset,
      fileSize: stPath ? fileSize(stPath) : null,
      lastSessionActivityAt: st.lastSessionActivityAt || null,
      lastResponsePreview: truncate(/** @type {string | null} */ (st.lastResponse), previewLen),
      sessionLogTail: logTail,
      // bindings.json state
      manifest: bindingsEntry ? {
        status: /** @type {unknown} */ (bindingsEntry.status) || null,
        level: /** @type {unknown} */ (bindingsEntry.level) || null,
        path: /** @type {unknown} */ (bindingsEntry.path) || null,
        session_id: /** @type {unknown} */ (bindingsEntry.session_id) || null,
      } : null,
      // run.json state
      runJson: runEntry ? {
        session_id: /** @type {unknown} */ (runEntry.session_id) || null,
        binding_path: /** @type {unknown} */ (runEntry.binding_path) || null,
      } : null,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    duetMode: process.env.DUET_MODE || null,
    duetSession: process.env.DUET_SESSION || null,
    run: runJson ? {
      run_id: runJson.run_id || null,
      cwd: runJson.cwd || null,
      status: runJson.status || null,
      mode: runJson.mode || null,
      tmux_session: runJson.tmux_session || null,
    } : null,
    router: {
      watching: routerState.watching,
      converseActive: !!routerState.converseState,
      converse: routerState.converseState ? {
        topic: routerState.converseState.topic,
        round: routerState.converseState.rounds,
        maxRounds: routerState.converseState.maxRounds,
        turn: routerState.converseState.turn,
      } : null,
      pendingTools: routerState.pendingTools,
      watcherFailed: routerState.watcherFailed,
    },
    tools,
    paneCaptures: paneCaptures || null,
  };
}

/**
 * Render a debug snapshot into a human-readable report string.
 * @param {Record<string, unknown>} snapshot
 * @returns {string}
 */
export function renderDebugReport(snapshot) {
  /** @type {string[]} */
  const lines = [];
  const hr = '─'.repeat(50);

  lines.push(`${hr}`);
  lines.push(`DUET DEBUG SNAPSHOT  ${snapshot.timestamp}`);
  lines.push(`${hr}`);

  // Session info
  const mode = snapshot.duetMode || '?';
  const session = snapshot.duetSession || '?';
  lines.push(`Mode: ${mode}  Session: ${session}`);

  // Run info
  const run = /** @type {Record<string, unknown> | null} */ (snapshot.run);
  if (run) {
    lines.push(`Run: ${run.run_id || '?'}  Status: ${run.status || '?'}`);
    lines.push(`CWD: ${run.cwd || '?'}`);
    if (run.tmux_session) lines.push(`Tmux: ${run.tmux_session}`);
  } else {
    lines.push('Run: (no run.json)');
  }

  // Router state
  const router = /** @type {Record<string, unknown>} */ (snapshot.router);
  const converse = /** @type {Record<string, unknown> | null} */ (router.converse);
  lines.push('');
  const routerStatus = router.converseActive
    ? `converse "${converse?.topic}" round ${converse?.round}/${converse?.maxRounds} (${converse?.turn}'s turn)`
    : router.watching ? 'watching' : 'idle';
  lines.push(`Router: ${routerStatus}`);
  const pendingTools = /** @type {string[]} */ (router.pendingTools);
  if (pendingTools.length > 0) {
    lines.push(`Pending: ${pendingTools.join(', ')}`);
  }
  const watcherFailed = /** @type {string[]} */ (router.watcherFailed);
  if (watcherFailed.length > 0) {
    lines.push(`Watcher failed: ${watcherFailed.join(', ')}`);
  }

  // Per-tool cross-file binding comparison + live state
  const tools = /** @type {Record<string, Record<string, unknown>>} */ (snapshot.tools);
  for (const tool of ['claude', 'codex']) {
    const t = tools[tool];
    lines.push('');
    lines.push(`[${tool}]`);

    // Binding status (normalized)
    let statusLabel = /** @type {string} */ (t.bindingStatus);
    if (t.bindingStatus === 'bound' && t.watcherFailed) {
      statusLabel = 'bound (watcher FAILED — automation inactive)';
    } else if (t.bindingStatus === 'bound' && t.watcherActive) {
      statusLabel = 'bound (watcher active)';
    }
    lines.push(`  status: ${statusLabel}${t.bindingLevel ? ` [${t.bindingLevel}]` : ''}`);

    // Cross-file comparison: run.json
    const tRunJson = /** @type {Record<string, unknown> | null} */ (t.runJson);
    if (tRunJson) {
      lines.push(`  run.json    session_id: ${tRunJson.session_id || '—'}`);
      lines.push(`              binding_path: ${tRunJson.binding_path || '—'}`);
    } else {
      lines.push(`  run.json    (no entry)`);
    }

    // Cross-file comparison: bindings.json
    const manifest = /** @type {Record<string, unknown> | null} */ (t.manifest);
    if (manifest) {
      lines.push(`  bindings    status: ${manifest.status || '—'}  level: ${manifest.level || '—'}`);
      lines.push(`              path: ${manifest.path || '—'}`);
      if (manifest.session_id) {
        lines.push(`              session_id: ${manifest.session_id}`);
      }
    } else {
      lines.push(`  bindings    (no manifest)`);
    }

    // Live router state
    lines.push(`  live        path: ${t.livePath || '—'}`);
    if (t.livePath) {
      lines.push(`              offset: ${t.offset}  file size: ${t.fileSize ?? '?'}`);
    }
    if (t.lastSessionActivityAt) {
      const ago = Math.round((Date.now() - /** @type {number} */ (t.lastSessionActivityAt)) / 1000);
      lines.push(`              last activity: ${ago}s ago`);
    }
    if (t.lastResponsePreview) {
      lines.push(`  last response: ${t.lastResponsePreview}`);
    }
    const sessionLogTail = /** @type {{ lines: string[], totalLines: number } | null} */ (t.sessionLogTail);
    if (sessionLogTail) {
      lines.push(`  session log (last ${sessionLogTail.lines.length} of ${sessionLogTail.totalLines} lines):`);
      for (const l of sessionLogTail.lines) {
        const display = l.length > 120 ? l.slice(0, 120) + '…' : l;
        lines.push(`    ${display}`);
      }
    }
  }

  // Pane captures (full mode only)
  const paneCaptures = /** @type {Record<string, string | null> | null} */ (snapshot.paneCaptures);
  if (paneCaptures) {
    for (const tool of ['claude', 'codex']) {
      if (paneCaptures[tool]) {
        lines.push('');
        lines.push(`[${tool} pane capture]`);
        const capLines = /** @type {string} */ (paneCaptures[tool]).trimEnd().split('\n');
        for (const l of capLines.slice(-PANE_CAPTURE_LINES)) {
          lines.push(`  ${l}`);
        }
      }
    }
  }

  lines.push(`${hr}`);
  return lines.join('\n');
}

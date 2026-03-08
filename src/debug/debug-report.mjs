import { readFileSync, statSync } from 'fs';

// Truncation limits
const RESPONSE_PREVIEW_LEN = 200;
const RESPONSE_PREVIEW_FULL_LEN = 500;
const LOG_TAIL_LINES = 5;
const LOG_TAIL_FULL_LINES = 20;
const PANE_CAPTURE_LINES = 30;

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || null;
  return str.slice(0, maxLen) + `… [${str.length - maxLen} more chars]`;
}

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

function fileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

// Normalize relayMode to user-facing binding status
function normalizeBindingStatus(relayMode) {
  if (relayMode === 'session') return 'bound';
  if (relayMode === 'pending') return 'pending';
  return 'degraded';
}

/**
 * Collect a debug snapshot from the current Duet session state.
 *
 * @param {Object} params
 * @param {Object} params.sessionState - Per-tool session state from session-reader
 * @param {Object} params.routerState - Router-level state (watching, converse, pending, etc.)
 * @param {Object|null} params.bindings - Current bindings.json content
 * @param {Object|null} params.runJson - Current run.json content
 * @param {Object|null} params.paneCaptures - { claude: string, codex: string } (full mode only)
 * @param {boolean} params.full - Include extended output
 */
export function collectDebugSnapshot({ sessionState, routerState, bindings, runJson, paneCaptures, full = false }) {
  const previewLen = full ? RESPONSE_PREVIEW_FULL_LEN : RESPONSE_PREVIEW_LEN;
  const tailN = full ? LOG_TAIL_FULL_LINES : LOG_TAIL_LINES;

  const tools = {};
  for (const tool of ['claude', 'codex']) {
    const st = sessionState[tool];
    const logTail = st.path ? tailLines(st.path, tailN) : null;

    // Cross-file binding comparison
    const bindingsEntry = bindings?.[tool] || null;
    const runEntry = runJson?.[tool] || null;

    tools[tool] = {
      // Normalized user-facing status
      bindingStatus: normalizeBindingStatus(st.relayMode),
      // Raw relayMode for implementation detail
      relayMode: st.relayMode,
      bindingLevel: st.bindingLevel,
      // Live router/session state
      livePath: st.path,
      watcherActive: routerState.fileWatcherActive[tool] || false,
      watcherFailed: routerState.watcherFailed.includes(tool),
      pending: routerState.pendingTools.includes(tool),
      offset: st.offset,
      fileSize: st.path ? fileSize(st.path) : null,
      lastSessionActivityAt: st.lastSessionActivityAt || null,
      lastResponsePreview: truncate(st.lastResponse, previewLen),
      sessionLogTail: logTail,
      // bindings.json state
      manifest: bindingsEntry ? {
        status: bindingsEntry.status || null,
        level: bindingsEntry.level || null,
        path: bindingsEntry.path || null,
        session_id: bindingsEntry.session_id || null,
      } : null,
      // run.json state
      runJson: runEntry ? {
        session_id: runEntry.session_id || null,
        binding_path: runEntry.binding_path || null,
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
 */
export function renderDebugReport(snapshot) {
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
  if (snapshot.run) {
    const r = snapshot.run;
    lines.push(`Run: ${r.run_id || '?'}  Status: ${r.status || '?'}`);
    lines.push(`CWD: ${r.cwd || '?'}`);
    if (r.tmux_session) lines.push(`Tmux: ${r.tmux_session}`);
  } else {
    lines.push('Run: (no run.json)');
  }

  // Router state
  lines.push('');
  const routerStatus = snapshot.router.converseActive
    ? `converse "${snapshot.router.converse.topic}" round ${snapshot.router.converse.round}/${snapshot.router.converse.maxRounds} (${snapshot.router.converse.turn}'s turn)`
    : snapshot.router.watching ? 'watching' : 'idle';
  lines.push(`Router: ${routerStatus}`);
  if (snapshot.router.pendingTools.length > 0) {
    lines.push(`Pending: ${snapshot.router.pendingTools.join(', ')}`);
  }
  if (snapshot.router.watcherFailed.length > 0) {
    lines.push(`Watcher failed: ${snapshot.router.watcherFailed.join(', ')}`);
  }

  // Per-tool cross-file binding comparison + live state
  for (const tool of ['claude', 'codex']) {
    const t = snapshot.tools[tool];
    lines.push('');
    lines.push(`[${tool}]`);

    // Binding status (normalized)
    let statusLabel = t.bindingStatus;
    if (t.bindingStatus === 'bound' && t.watcherFailed) {
      statusLabel = 'bound (watcher FAILED — automation inactive)';
    } else if (t.bindingStatus === 'bound' && t.watcherActive) {
      statusLabel = 'bound (watcher active)';
    }
    lines.push(`  status: ${statusLabel}${t.bindingLevel ? ` [${t.bindingLevel}]` : ''}`);

    // Cross-file comparison: run.json
    if (t.runJson) {
      lines.push(`  run.json    session_id: ${t.runJson.session_id || '—'}`);
      lines.push(`              binding_path: ${t.runJson.binding_path || '—'}`);
    } else {
      lines.push(`  run.json    (no entry)`);
    }

    // Cross-file comparison: bindings.json
    if (t.manifest) {
      lines.push(`  bindings    status: ${t.manifest.status || '—'}  level: ${t.manifest.level || '—'}`);
      lines.push(`              path: ${t.manifest.path || '—'}`);
      if (t.manifest.session_id) {
        lines.push(`              session_id: ${t.manifest.session_id}`);
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
      const ago = Math.round((Date.now() - t.lastSessionActivityAt) / 1000);
      lines.push(`              last activity: ${ago}s ago`);
    }
    if (t.lastResponsePreview) {
      lines.push(`  last response: ${t.lastResponsePreview}`);
    }
    if (t.sessionLogTail) {
      lines.push(`  session log (last ${t.sessionLogTail.lines.length} of ${t.sessionLogTail.totalLines} lines):`);
      for (const l of t.sessionLogTail.lines) {
        const display = l.length > 120 ? l.slice(0, 120) + '…' : l;
        lines.push(`    ${display}`);
      }
    }
  }

  // Pane captures (full mode only)
  if (snapshot.paneCaptures) {
    for (const tool of ['claude', 'codex']) {
      if (snapshot.paneCaptures[tool]) {
        lines.push('');
        lines.push(`[${tool} pane capture]`);
        const capLines = snapshot.paneCaptures[tool].trimEnd().split('\n');
        for (const l of capLines.slice(-PANE_CAPTURE_LINES)) {
          lines.push(`  ${l}`);
        }
      }
    }
  }

  lines.push(`${hr}`);
  return lines.join('\n');
}

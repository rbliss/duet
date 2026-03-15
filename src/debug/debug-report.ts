import { readFileSync, statSync } from 'fs';
import type { DebugSnapshotInput } from '../types/runtime.js';

// Truncation limits
const RESPONSE_PREVIEW_LEN = 200;
const RESPONSE_PREVIEW_FULL_LEN = 500;
const LOG_TAIL_LINES = 5;
const LOG_TAIL_FULL_LINES = 20;
const PANE_CAPTURE_LINES = 30;

function truncate(str: string | null | undefined, maxLen: number): string | null {
  if (!str || str.length <= maxLen) return str || null;
  return str.slice(0, maxLen) + `… [${str.length - maxLen} more chars]`;
}

function tailLines(filePath: string, n: number): { lines: string[]; totalLines: number } | null {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trimEnd().split('\n');
    const tail = lines.slice(-n);
    return { lines: tail, totalLines: lines.length };
  } catch {
    return null;
  }
}

function fileSize(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

function normalizeBindingStatus(relayMode: string): string {
  if (relayMode === 'session') return 'bound';
  if (relayMode === 'pending') return 'pending';
  return 'degraded';
}

export function collectDebugSnapshot({ sessionState, routerState, bindings, runJson, paneCaptures, full = false }: DebugSnapshotInput): Record<string, unknown> {
  const previewLen = full ? RESPONSE_PREVIEW_FULL_LEN : RESPONSE_PREVIEW_LEN;
  const tailN = full ? LOG_TAIL_FULL_LINES : LOG_TAIL_LINES;

  const tools: Record<string, unknown> = {};
  for (const tool of ['claude', 'codex']) {
    const st = sessionState[tool] as Record<string, unknown>;
    const stPath = st.path as string | null;
    const logTail = stPath ? tailLines(stPath, tailN) : null;

    // Cross-file binding comparison
    const bindingsEntry = bindings ? (bindings[tool as 'claude' | 'codex'] as unknown as Record<string, unknown> | null) : null;
    const runEntry = runJson ? (runJson[tool] as Record<string, unknown> | null) : null;

    tools[tool] = {
      // Normalized user-facing status
      bindingStatus: normalizeBindingStatus(st.relayMode as string),
      // Raw relayMode for implementation detail
      relayMode: st.relayMode,
      bindingLevel: st.bindingLevel,
      // Live router/session state
      livePath: stPath,
      watcherActive: routerState.fileWatcherActive[tool as 'claude' | 'codex'] || false,
      watcherFailed: routerState.watcherFailed.includes(tool),
      pending: routerState.pendingTools.includes(tool),
      offset: st.offset,
      fileSize: stPath ? fileSize(stPath) : null,
      lastSessionActivityAt: st.lastSessionActivityAt || null,
      lastResponsePreview: truncate(st.lastResponse as string | null, previewLen),
      lastRelayableResponsePreview: truncate(st.lastRelayableResponse as string | null, previewLen),
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

export function renderDebugReport(snapshot: Record<string, unknown>): string {
  const lines: string[] = [];
  const hr = '─'.repeat(50);

  lines.push(`${hr}`);
  lines.push(`DUET DEBUG SNAPSHOT  ${snapshot.timestamp}`);
  lines.push(`${hr}`);

  // Session info
  const mode = snapshot.duetMode || '?';
  const session = snapshot.duetSession || '?';
  lines.push(`Mode: ${mode}  Session: ${session}`);

  // Run info
  const run = snapshot.run as Record<string, unknown> | null;
  if (run) {
    lines.push(`Run: ${run.run_id || '?'}  Status: ${run.status || '?'}`);
    lines.push(`CWD: ${run.cwd || '?'}`);
    if (run.tmux_session) lines.push(`Tmux: ${run.tmux_session}`);
  } else {
    lines.push('Run: (no run.json)');
  }

  // Router state
  const router = snapshot.router as Record<string, unknown>;
  const converse = router.converse as Record<string, unknown> | null;
  lines.push('');
  const routerStatus = router.converseActive
    ? `converse "${converse?.topic}" round ${converse?.round}/${converse?.maxRounds} (${converse?.turn}'s turn)`
    : router.watching ? 'watching' : 'idle';
  lines.push(`Router: ${routerStatus}`);
  const pendingTools = router.pendingTools as string[];
  if (pendingTools.length > 0) {
    lines.push(`Pending: ${pendingTools.join(', ')}`);
  }
  const watcherFailed = router.watcherFailed as string[];
  if (watcherFailed.length > 0) {
    lines.push(`Watcher failed: ${watcherFailed.join(', ')}`);
  }

  // Per-tool cross-file binding comparison + live state
  const tools = snapshot.tools as Record<string, Record<string, unknown>>;
  for (const tool of ['claude', 'codex']) {
    const t = tools[tool];
    lines.push('');
    lines.push(`[${tool}]`);

    // Binding status (normalized)
    let statusLabel = t.bindingStatus as string;
    if (t.bindingStatus === 'bound' && t.watcherFailed) {
      statusLabel = 'bound (watcher FAILED)';
    } else if (t.bindingStatus === 'bound' && t.watcherActive) {
      statusLabel = 'bound (watcher active)';
    }
    lines.push(`  status: ${statusLabel}${t.bindingLevel ? ` [${t.bindingLevel}]` : ''}`);

    // Cross-file comparison: run.json
    const tRunJson = t.runJson as Record<string, unknown> | null;
    if (tRunJson) {
      lines.push(`  run.json    session_id: ${tRunJson.session_id || '—'}`);
      lines.push(`              binding_path: ${tRunJson.binding_path || '—'}`);
    } else {
      lines.push(`  run.json    (no entry)`);
    }

    // Cross-file comparison: bindings.json
    const manifest = t.manifest as Record<string, unknown> | null;
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
      const ago = Math.round((Date.now() - (t.lastSessionActivityAt as number)) / 1000);
      lines.push(`              last activity: ${ago}s ago`);
    }
    if (t.lastResponsePreview) {
      lines.push(`  last response: ${t.lastResponsePreview}`);
    }
    if ((t.lastRelayableResponsePreview ?? null) !== (t.lastResponsePreview ?? null)) {
      const relayLabel = t.lastRelayableResponsePreview || '(none — last response is non-relayable)';
      lines.push(`  relay source:  ${relayLabel}`);
    }
    const sessionLogTail = t.sessionLogTail as { lines: string[]; totalLines: number } | null;
    if (sessionLogTail) {
      lines.push(`  session log (last ${sessionLogTail.lines.length} of ${sessionLogTail.totalLines} lines):`);
      for (const l of sessionLogTail.lines) {
        const display = l.length > 120 ? l.slice(0, 120) + '…' : l;
        lines.push(`    ${display}`);
      }
    }
  }

  // Pane captures (full mode only)
  const paneCaptures = snapshot.paneCaptures as Record<string, string | null> | null;
  if (paneCaptures) {
    for (const tool of ['claude', 'codex']) {
      if (paneCaptures[tool]) {
        lines.push('');
        lines.push(`[${tool} pane capture]`);
        const capLines = (paneCaptures[tool] as string).trimEnd().split('\n');
        for (const l of capLines.slice(-PANE_CAPTURE_LINES)) {
          lines.push(`  ${l}`);
        }
      }
    }
  }

  lines.push(`${hr}`);
  return lines.join('\n');
}

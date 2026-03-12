/**
 * Router entry point — thin wrapper with re-exports for backward compatibility.
 * All logic lives in src/router/{commands,state,controller}.mjs
 */

// ─── Re-exports: existing modules (unchanged) ───────────────────────────────

export { shellEscape, sendKeys, pasteToPane, capturePane, focusPane } from './src/transport/tmux-client.js';
export { setRunDir, updateRunJson } from './src/runtime/run-store.js';
export { STATE_DIR, setStateDir } from './src/runtime/bindings-store.js';
export { collectDebugSnapshot, renderDebugReport } from './src/debug/debug-report.js';
export {
  sessionState, resolveSessionPath, readIncremental,
  extractClaudeResponse, extractCodexResponse, isResponseComplete,
  getClaudeLastResponse, getCodexLastResponse, getLastResponse,
  setDuetMode, extractCodexSessionId,
} from './src/relay/session-reader.js';

// ─── Re-exports: router modules (new) ───────────────────────────────────────

export { parseInput, detectMentions } from './src/router/commands.js';
export {
  lastAutoRelayTime, watcherFailed,
  isWatching, findRebindCandidate, rebindTool,
  stopFileWatchers, getRouterState,
} from './src/router/state.js';
export { handleNewOutput } from './src/router/controller.js';

// ─── Main entry ──────────────────────────────────────────────────────────────

import { main } from './src/router/controller.js';

const isMain = process.argv[1] &&
  (process.argv[1].endsWith('router.mjs') || process.argv[1].endsWith('router'));

if (isMain) main();

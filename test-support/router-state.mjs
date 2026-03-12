import { sessionState, setStateDir, setDuetMode, setRunDir, stopFileWatchers, watcherFailed } from '../router.mjs';

// Save and restore the mutable router/session state around test suites
export function saveSessionState() {
  return {
    claude: { ...sessionState.claude },
    codex: { ...sessionState.codex },
  };
}

export function restoreSessionState(saved) {
  Object.assign(sessionState.claude, saved.claude);
  Object.assign(sessionState.codex, saved.codex);
  setStateDir(null);
  setDuetMode('new');
  setRunDir(null);
  stopFileWatchers();
  watcherFailed.clear();
}

export function resetSessionState() {
  for (const tool of ['claude', 'codex']) {
    sessionState[tool].path = null;
    sessionState[tool].resolved = false;
    sessionState[tool].offset = 0;
    sessionState[tool].lastResponse = null;
    sessionState[tool].relayMode = 'pending';
    sessionState[tool].bindingLevel = null;
    sessionState[tool].lastSessionActivityAt = 0;
  }
}

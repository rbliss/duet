// Type layer for the binding reconciler.
// Actual runtime logic lives in reconciler.mjs.
// Future TS callers import this file for full type safety.

export interface BindingReconcilerEnv {
  claudeSessionId: string;
  claudeProjects: string;
  codexSessions: string;
  stateDir: string;
  workdir: string;
  bindTimeout: number;
  globalCodexSessions: string;
  resumeClaudePath: string | null;
  resumeCodexPath: string | null;
  resumeCodexSessionId: string | null;
}

export { reconcile } from './reconciler.mjs';

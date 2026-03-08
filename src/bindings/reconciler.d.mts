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

export declare function reconcile(envOverride?: BindingReconcilerEnv): Promise<void>;

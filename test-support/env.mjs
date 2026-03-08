// Env vars that duet.sh/bind-sessions.sh use — must be stripped from test env
// to prevent the live Duet session's values from leaking into binding tests.
const DUET_ENV_VARS = [
  'RESUME_CLAUDE_PATH', 'RESUME_CODEX_PATH', 'RESUME_CODEX_SESSION_ID',
  'STATE_DIR', 'CODEX_SESSIONS', 'CODEX_HOME', 'CLAUDE_PROJECTS',
  'CLAUDE_SESSION_ID', 'WORKDIR', 'DUET_STATE_DIR', 'DUET_RUN_DIR',
  'DUET_MODE', 'DUET_SESSION', 'DUET_BASE', 'GLOBAL_CODEX_SESSIONS',
];

export function sanitizedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of DUET_ENV_VARS) delete env[key];
  return { ...env, ...overrides };
}

/**
 * Binding reconciler — replaces bind-sessions.sh
 *
 * Runs as a background process. Owns the full binding lifecycle:
 *   pending → bound    (session file discovered)
 *   pending → degraded (deadline expired without discovery)
 *
 * Expects environment variables (see ReconcilerEnv below).
 * Writes $STATE_DIR/bindings.json as its sole output.
 * Always exits 0 (partial binding is not an error).
 */

import type { ReconcilerEnv, ReconcilerToolState } from '../types/runtime.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { nowIso } from '../runtime/workspace.js';
import { extractCodexSessionId } from '../relay/session-reader.js';
import { findJsonlFiles } from './discovery.js';

// ─── Environment contract ────────────────────────────────────────────────────

function parseEnv(): Readonly<ReconcilerEnv> {
  const env = process.env;
  const claudeSessionId = env.CLAUDE_SESSION_ID;
  const claudeProjects = env.CLAUDE_PROJECTS;
  const codexSessions = env.CODEX_SESSIONS;
  const stateDir = env.STATE_DIR;
  const workdir = env.WORKDIR;

  if (!claudeSessionId || !claudeProjects || !codexSessions || !stateDir || !workdir) {
    const missing: string[] = [];
    if (!claudeSessionId) missing.push('CLAUDE_SESSION_ID');
    if (!claudeProjects) missing.push('CLAUDE_PROJECTS');
    if (!codexSessions) missing.push('CODEX_SESSIONS');
    if (!stateDir) missing.push('STATE_DIR');
    if (!workdir) missing.push('WORKDIR');
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return Object.freeze({
    claudeSessionId,
    claudeProjects,
    codexSessions,
    stateDir,
    workdir,
    bindTimeout: parseInt(env.BIND_TIMEOUT || '240', 10),
    globalCodexSessions: env.GLOBAL_CODEX_SESSIONS || join(env.HOME || '', '.codex/sessions'),
    resumeClaudePath: env.RESUME_CLAUDE_PATH || null,
    resumeCodexPath: env.RESUME_CODEX_PATH || null,
    resumeCodexSessionId: env.RESUME_CODEX_SESSION_ID || null,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractCodexCwd(filePath: string): string {
  try {
    const firstLine = readFileSync(filePath, 'utf8').split('\n')[0];
    const data = JSON.parse(firstLine);
    return (data.payload && data.payload.cwd) || '';
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Manifest state ──────────────────────────────────────────────────────────

function createManifestState(): { claude: ReconcilerToolState; codex: ReconcilerToolState } {
  return {
    claude: { status: 'pending', path: '', level: '', sessionId: '' },
    codex: { status: 'pending', path: '', level: '', sessionId: '' },
  };
}

function writeManifest(state: { claude: ReconcilerToolState; codex: ReconcilerToolState }, stateDir: string): void {
  const now = nowIso();
  const bindings = {
    claude: {
      path: state.claude.path || null,
      level: state.claude.level || null,
      status: state.claude.status,
      confirmedAt: state.claude.status === 'bound' ? now : null,
      session_id: state.claude.sessionId || null,
    },
    codex: {
      path: state.codex.path || null,
      level: state.codex.level || null,
      status: state.codex.status,
      confirmedAt: state.codex.status === 'bound' ? now : null,
      session_id: state.codex.sessionId || null,
    },
  };
  writeFileSync(join(stateDir, 'bindings.json'), JSON.stringify(bindings, null, 2));
}

// ─── Main reconciler logic ───────────────────────────────────────────────────

export async function reconcile(envOverride?: ReconcilerEnv): Promise<void> {
  const env = envOverride || parseEnv();
  const state = createManifestState();
  let claudeBound = false;
  let codexBound = false;

  // --- Resume fast-path: verify stored session paths ---

  if (env.resumeClaudePath && existsSync(env.resumeClaudePath)) {
    const resumeBasename = basename(env.resumeClaudePath, '.jsonl');
    if (resumeBasename === env.claudeSessionId) {
      claudeBound = true;
      state.claude.status = 'bound';
      state.claude.path = env.resumeClaudePath;
      state.claude.level = 'process';
      state.claude.sessionId = env.claudeSessionId;
    }
  }

  if (env.resumeCodexPath && existsSync(env.resumeCodexPath)) {
    const extractedId = extractCodexSessionId(env.resumeCodexPath) || '';
    if (!env.resumeCodexSessionId || extractedId === env.resumeCodexSessionId) {
      codexBound = true;
      state.codex.status = 'bound';
      state.codex.path = env.resumeCodexPath;
      state.codex.level = 'process';
      state.codex.sessionId = extractedId;
    }
  }

  // Write initial manifest (pending or pre-verified bound)
  writeManifest(state, env.stateDir);

  // If both already verified from resume, we're done
  if (claudeBound && codexBound) {
    return;
  }

  // Snapshot global Codex sessions before launch (for fallback cwd matching)
  const globalBefore = new Set(findJsonlFiles(env.globalCodexSessions));

  // Poll for both session files
  for (let i = 0; i < env.bindTimeout; i++) {
    await sleep(500);

    // Claude: find our UUID file anywhere in the projects tree
    if (!claudeBound) {
      const claudeFiles = findJsonlFiles(env.claudeProjects);
      const match = claudeFiles.find(f => basename(f) === `${env.claudeSessionId}.jsonl`);
      if (match) {
        claudeBound = true;
        state.claude.status = 'bound';
        state.claude.path = match;
        state.claude.level = 'process';
        state.claude.sessionId = env.claudeSessionId;
        writeManifest(state, env.stateDir);
      }
    }

    // Codex primary: find any .jsonl in the isolated sessions dir (recursive)
    if (!codexBound) {
      const codexFiles = findJsonlFiles(env.codexSessions);
      if (codexFiles.length > 0) {
        const codexFile = codexFiles[0];
        codexBound = true;
        state.codex.status = 'bound';
        state.codex.path = codexFile;
        state.codex.level = 'process';
        state.codex.sessionId = extractCodexSessionId(codexFile) || '';
        writeManifest(state, env.stateDir);
      }
    }

    // Stop polling once both are bound
    if (claudeBound && codexBound) {
      break;
    }
  }

  // Codex fallback: if isolation produced nothing, try global sessions with cwd matching
  if (!codexBound) {
    const globalAfter = findJsonlFiles(env.globalCodexSessions);
    const newFiles = globalAfter.filter(f => !globalBefore.has(f)).sort();
    for (const candidate of newFiles) {
      const candidateCwd = extractCodexCwd(candidate);
      if (candidateCwd === env.workdir) {
        codexBound = true;
        state.codex.status = 'bound';
        state.codex.path = candidate;
        state.codex.level = 'workspace';
        state.codex.sessionId = extractCodexSessionId(candidate) || '';
        writeManifest(state, env.stateDir);
        break;
      }
    }
  }

  // Mark remaining unfound tools:
  // - degraded if resume expected a prior binding (resume path was set)
  // - stay pending if fresh launch (tool may create session later)
  if (!claudeBound) {
    state.claude.status = env.resumeClaudePath ? 'degraded' : 'pending';
  }
  if (!codexBound) {
    state.codex.status = (env.resumeCodexPath || env.resumeCodexSessionId) ? 'degraded' : 'pending';
  }
  writeManifest(state, env.stateDir);
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

// When run directly (not imported), execute reconciler from process.env
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/reconciler.mjs') ||
  process.argv[1].endsWith('/reconciler.ts') ||
  process.argv[1].endsWith('/reconciler.js') ||
  process.argv[1].endsWith('\\reconciler.mjs') ||
  process.argv[1].endsWith('\\reconciler.ts') ||
  process.argv[1].endsWith('\\reconciler.js')
);

if (isMain) {
  reconcile().catch(err => {
    console.error('bind-sessions:', err.message);
    process.exit(0); // Always exit 0 — partial binding is not an error
  });
}

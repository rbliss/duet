/**
 * Launcher commands: new, resume, fork, list, destroy.
 * Ported from duet.sh's cmd_new(), cmd_resume(), cmd_fork(), etc.
 */

import type { LauncherConfig, TmuxRunner } from '../types/runtime.js';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';

import { setupCodexHome } from './codex-home.js';
import {
  shellQuote,
  createTmuxRunner,
  createTmuxLayout,
  launchRouter,
  tmuxHasSession,
  tmuxAttach,
} from './tmux.js';
import { entryPaths, nodeArgs } from '../runtime/entry-paths.js';
import {
  nowIso,
  readRunField,
  writeRunJson,
  findActiveRun,
  updateWorkspaceIndex,
  resolveRunId,
  buildToolPrompt,
  listRuns,
  destroyRun,
} from '../runtime/workspace.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getConfig(): LauncherConfig {
  const duetBase = process.env.DUET_BASE || `${process.env.HOME || ''}/.local/state/duet`;
  return {
    duetBase,
    runsDir: `${duetBase}/runs`,
    workspacesDir: `${duetBase}/workspaces`,
    duetDir: process.env.DUET_DIR || '', // set by entry point
    socket: process.env.DUET_TMUX_SOCKET,
    noAttach: process.env.DUET_NO_ATTACH === '1',
  };
}

function ensureDirs(cfg: LauncherConfig): void {
  mkdirSync(cfg.runsDir, { recursive: true });
  mkdirSync(cfg.workspacesDir, { recursive: true });
}

function startReconciler(): void {
  const child = spawn('node', [...nodeArgs, entryPaths.reconciler], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

function buildClaudeCmd(sessionId: string, promptFile: string, isResume: boolean): string {
  const prompt = readFileSync(promptFile, 'utf8');
  const escapedPrompt = shellQuote(prompt);
  if (isResume) {
    return `claude --dangerously-skip-permissions --resume ${sessionId} --append-system-prompt ${escapedPrompt}`;
  }
  return `claude --dangerously-skip-permissions --session-id ${sessionId} --append-system-prompt ${escapedPrompt}`;
}

function buildClaudeForkCmd(oldSessionId: string, newSessionId: string, promptFile: string): string {
  const prompt = readFileSync(promptFile, 'utf8');
  const escapedPrompt = shellQuote(prompt);
  return `claude --dangerously-skip-permissions --resume ${oldSessionId} --fork-session --session-id ${newSessionId} --append-system-prompt ${escapedPrompt}`;
}

function buildCodexCmd(codexHome: string, promptFile: string, sessionId: string | null, mode: string): string {
  const qHome = shellQuote(codexHome);
  const qPrompt = shellQuote(promptFile);
  if (mode === 'resume' && sessionId) {
    return `CODEX_HOME=${qHome} codex resume ${sessionId} --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=${qPrompt}`;
  }
  if (mode === 'fork' && sessionId) {
    return `CODEX_HOME=${qHome} codex fork ${sessionId} --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=${qPrompt}`;
  }
  return `CODEX_HOME=${qHome} codex --dangerously-bypass-approvals-and-sandbox -c model_instructions_file=${qPrompt}`;
}

function canonicalizePath(p: string): string {
  try {
    return execSync(`cd ${shellQuote(p)} && pwd -P`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    console.error(`Error: cannot resolve workdir: ${p}`);
    process.exit(1);
  }
}

// ─── Commands ───────────────────────────────────────────────────────────────

export function cmdNew(workdirArg: string | undefined): void {
  const workdir = canonicalizePath(workdirArg || process.cwd());
  const cfg = getConfig();
  ensureDirs(cfg);
  const tmux = createTmuxRunner(cfg.socket);

  // Check for existing active run
  const activeRun = findActiveRun(workdir, cfg.runsDir, cfg.workspacesDir);
  if (activeRun) {
    const tmuxSession = readRunField(join(cfg.runsDir, activeRun, 'run.json'), 'tmux_session');
    if (tmuxSession && tmuxHasSession(tmux, tmuxSession)) {
      console.log('Active run exists for this workspace — attaching.');
      console.log(`  run: ${activeRun.slice(0, 8)}`);
      console.log(`  tmux: ${tmuxSession}`);
      console.log(`Stop it first with /quit, or use 'duet destroy ${activeRun.slice(0, 8)}' to remove.`);
      if (!cfg.noAttach) process.exitCode = tmuxAttach(tmuxSession, cfg.socket);
      return;
    }
    // tmux session gone — mark old run as stopped
    writeRunJson(join(cfg.runsDir, activeRun, 'run.json'), {
      status: 'stopped', updated_at: nowIso(),
    });
    updateWorkspaceIndex(workdir, activeRun, 'clear', cfg.workspacesDir);
  }

  // Create new run
  const runId = randomUUID();
  const tmuxSession = `duet-${runId.slice(0, 8)}`;
  const runDir = join(cfg.runsDir, runId);
  mkdirSync(join(runDir, 'runtime'), { recursive: true });

  const codexHome = join(runDir, 'codex-home');
  setupCodexHome(codexHome);

  const claudeSessionId = randomUUID();

  writeRunJson(join(runDir, 'run.json'), {
    run_id: runId,
    cwd: workdir,
    created_at: nowIso(),
    updated_at: nowIso(),
    status: 'active',
    tmux_session: tmuxSession,
    mode: 'new',
    'claude.session_id': claudeSessionId,
    'codex.session_id': '',
    'claude.binding_path': '',
    'codex.binding_path': '',
    codex_home: codexHome,
  });

  updateWorkspaceIndex(workdir, runId, true, cfg.workspacesDir);

  // Env for binding reconciler
  process.env.CLAUDE_SESSION_ID = claudeSessionId;
  process.env.CLAUDE_PROJECTS = `${process.env.HOME}/.claude/projects`;
  process.env.STATE_DIR = runDir;
  process.env.WORKDIR = workdir;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_SESSIONS = join(codexHome, 'sessions');

  // tmux layout
  const panes = createTmuxLayout(tmux, tmuxSession);

  // Prompt files
  const claudePromptFile = join(runDir, 'runtime/claude-system-prompt.md');
  const codexPromptFile = join(runDir, 'runtime/codex-model-instructions.md');
  buildToolPrompt('claude', workdir, claudePromptFile, join(cfg.duetDir, 'DUET.md'));
  buildToolPrompt('codex', workdir, codexPromptFile, join(cfg.duetDir, 'DUET.md'));

  // Launch tools
  const qWorkdir = shellQuote(workdir);
  const claudeCmd = buildClaudeCmd(claudeSessionId, claudePromptFile, false);
  const codexCmd = buildCodexCmd(codexHome, codexPromptFile, null, 'new');

  tmux('send-keys', '-t', panes.claudePane, `cd ${qWorkdir} && ${claudeCmd}`, 'Enter');
  tmux('send-keys', '-t', panes.codexPane, `cd ${qWorkdir} && ${codexCmd}`, 'Enter');

  startReconciler();
  launchRouter(tmux, panes.routerPane, {
    session: tmuxSession, runDir, mode: 'new',
    claudePane: panes.claudePane, codexPane: panes.codexPane,
  });

  if (!cfg.noAttach) process.exitCode = tmuxAttach(tmuxSession, cfg.socket);
}

export function cmdResume(ref: string | undefined): void {
  const cfg = getConfig();
  ensureDirs(cfg);
  const tmux = createTmuxRunner(cfg.socket);

  const { runId, error } = resolveRunId(ref || 'last', cfg.runsDir);
  if (error) { console.error(`Error: ${error}`); process.exit(1); }
  if (!runId) { console.error('Error: no run found to resume'); process.exit(1); }

  const runDir = join(cfg.runsDir, runId);
  const runJson = join(runDir, 'run.json');
  if (!existsSync(runJson)) { console.error(`Error: run manifest not found: ${runJson}`); process.exit(1); }

  // Read fields
  const cwd = readRunField(runJson, 'cwd');
  let claudeSessionId = readRunField(runJson, 'claude.session_id');
  const codexSessionId = readRunField(runJson, 'codex.session_id');
  let codexHome = readRunField(runJson, 'codex_home');
  let tmuxSession = readRunField(runJson, 'tmux_session');
  const status = readRunField(runJson, 'status');
  const claudeBindingPath = readRunField(runJson, 'claude.binding_path');
  const codexBindingPath = readRunField(runJson, 'codex.binding_path');

  // If tmux session still alive, just attach
  if (tmuxSession && tmuxHasSession(tmux, tmuxSession)) {
    console.log('tmux session still alive — attaching.');
    if (!cfg.noAttach) process.exitCode = tmuxAttach(tmuxSession, cfg.socket);
    return;
  }

  if (status !== 'stopped' && status !== 'detached') {
    console.log(`Warning: run status is '${status}' (expected 'stopped' or 'detached')`);
  }

  console.log(`Resuming run ${runId.slice(0, 8)}...`);
  console.log(`  cwd: ${cwd}`);
  console.log(claudeSessionId ? `  claude: ${claudeSessionId}` : '  claude: (fresh)');
  console.log(codexSessionId ? `  codex: ${codexSessionId}` : '  codex: (fresh)');

  tmuxSession = tmuxSession || `duet-${runId.slice(0, 8)}`;
  codexHome = codexHome || join(runDir, 'codex-home');
  setupCodexHome(codexHome);

  mkdirSync(join(runDir, 'runtime'), { recursive: true });
  const claudePromptFile = join(runDir, 'runtime/claude-system-prompt.md');
  const codexPromptFile = join(runDir, 'runtime/codex-model-instructions.md');
  buildToolPrompt('claude', cwd, claudePromptFile, join(cfg.duetDir, 'DUET.md'));
  buildToolPrompt('codex', cwd, codexPromptFile, join(cfg.duetDir, 'DUET.md'));

  // Build Claude command
  let claudeSid = claudeSessionId;
  let claudeCmd: string;
  if (claudeSid) {
    claudeCmd = buildClaudeCmd(claudeSid, claudePromptFile, true);
  } else {
    claudeSid = randomUUID();
    claudeCmd = buildClaudeCmd(claudeSid, claudePromptFile, false);
  }

  // Build Codex command
  const codexCmd = buildCodexCmd(codexHome, codexPromptFile, codexSessionId, 'resume');

  // Update run manifest
  writeRunJson(runJson, {
    status: 'active',
    updated_at: nowIso(),
    tmux_session: tmuxSession,
    mode: 'resumed',
    'claude.session_id': claudeSid,
  });

  updateWorkspaceIndex(cwd, runId, true, cfg.workspacesDir);

  // Env for binding reconciler
  process.env.CLAUDE_SESSION_ID = claudeSid;
  process.env.CLAUDE_PROJECTS = `${process.env.HOME}/.claude/projects`;
  process.env.STATE_DIR = runDir;
  process.env.WORKDIR = cwd;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_SESSIONS = join(codexHome, 'sessions');
  if (claudeBindingPath) process.env.RESUME_CLAUDE_PATH = claudeBindingPath;
  if (codexBindingPath && codexSessionId) {
    process.env.RESUME_CODEX_PATH = codexBindingPath;
    process.env.RESUME_CODEX_SESSION_ID = codexSessionId;
  }

  // Create tmux layout and launch
  const panes = createTmuxLayout(tmux, tmuxSession);
  const qCwd = shellQuote(cwd);

  tmux('send-keys', '-t', panes.claudePane, `cd ${qCwd} && ${claudeCmd}`, 'Enter');
  tmux('send-keys', '-t', panes.codexPane, `cd ${qCwd} && ${codexCmd}`, 'Enter');

  startReconciler();
  launchRouter(tmux, panes.routerPane, {
    session: tmuxSession, runDir, mode: 'resumed',
    claudePane: panes.claudePane, codexPane: panes.codexPane,
  });

  if (!cfg.noAttach) process.exitCode = tmuxAttach(tmuxSession, cfg.socket);
}

export function cmdFork(ref: string | undefined): void {
  const cfg = getConfig();
  ensureDirs(cfg);
  const tmux = createTmuxRunner(cfg.socket);

  const { runId, error } = resolveRunId(ref || 'last', cfg.runsDir);
  if (error) { console.error(`Error: ${error}`); process.exit(1); }
  if (!runId) { console.error('Error: no run found to fork'); process.exit(1); }

  const sourceJson = join(cfg.runsDir, runId, 'run.json');
  if (!existsSync(sourceJson)) { console.error('Error: source run manifest not found'); process.exit(1); }

  const cwd = readRunField(sourceJson, 'cwd');
  const claudeSessionId = readRunField(sourceJson, 'claude.session_id');
  const codexSessionId = readRunField(sourceJson, 'codex.session_id');

  console.log(`Forking run ${runId.slice(0, 8)}...`);

  // Create new run
  const newRunId = randomUUID();
  const newRunDir = join(cfg.runsDir, newRunId);
  const tmuxSession = `duet-${newRunId.slice(0, 8)}`;
  mkdirSync(join(newRunDir, 'runtime'), { recursive: true });

  const codexHome = join(newRunDir, 'codex-home');
  setupCodexHome(codexHome);
  const newClaudeSid = randomUUID();

  const claudePromptFile = join(newRunDir, 'runtime/claude-system-prompt.md');
  const codexPromptFile = join(newRunDir, 'runtime/codex-model-instructions.md');
  buildToolPrompt('claude', cwd, claudePromptFile, join(cfg.duetDir, 'DUET.md'));
  buildToolPrompt('codex', cwd, codexPromptFile, join(cfg.duetDir, 'DUET.md'));

  // Build commands
  let claudeCmd: string;
  if (claudeSessionId) {
    claudeCmd = buildClaudeForkCmd(claudeSessionId, newClaudeSid, claudePromptFile);
  } else {
    claudeCmd = buildClaudeCmd(newClaudeSid, claudePromptFile, false);
  }

  const codexCmd = buildCodexCmd(codexHome, codexPromptFile, codexSessionId, 'fork');

  // Write run manifest
  writeRunJson(join(newRunDir, 'run.json'), {
    run_id: newRunId,
    cwd,
    created_at: nowIso(),
    updated_at: nowIso(),
    status: 'active',
    tmux_session: tmuxSession,
    mode: 'forked',
    'claude.session_id': newClaudeSid,
    'codex.session_id': '',
    'claude.binding_path': '',
    'codex.binding_path': '',
    codex_home: codexHome,
    forked_from: runId,
  });

  updateWorkspaceIndex(cwd, newRunId, true, cfg.workspacesDir);

  // Env for binding reconciler
  process.env.CLAUDE_SESSION_ID = newClaudeSid;
  process.env.CLAUDE_PROJECTS = `${process.env.HOME}/.claude/projects`;
  process.env.STATE_DIR = newRunDir;
  process.env.WORKDIR = cwd;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_SESSIONS = join(codexHome, 'sessions');

  // Create tmux layout and launch
  const panes = createTmuxLayout(tmux, tmuxSession);
  const qCwd = shellQuote(cwd);

  tmux('send-keys', '-t', panes.claudePane, `cd ${qCwd} && ${claudeCmd}`, 'Enter');
  tmux('send-keys', '-t', panes.codexPane, `cd ${qCwd} && ${codexCmd}`, 'Enter');

  startReconciler();
  launchRouter(tmux, panes.routerPane, {
    session: tmuxSession, runDir: newRunDir, mode: 'forked',
    claudePane: panes.claudePane, codexPane: panes.codexPane,
  });

  if (!cfg.noAttach) process.exitCode = tmuxAttach(tmuxSession, cfg.socket);
}

export function cmdList(progName: string): void {
  const cfg = getConfig();
  ensureDirs(cfg);
  process.stdout.write(listRuns(cfg.runsDir, progName));
}

export function cmdDestroy(ref: string | undefined): void {
  const cfg = getConfig();
  ensureDirs(cfg);

  const { runId, error } = resolveRunId(ref, cfg.runsDir);
  if (error) { console.error(`Error: ${error}`); process.exit(1); }
  if (!runId) { console.error('Error: no run found to destroy'); process.exit(1); }

  destroyRun(runId, cfg.runsDir, cfg.workspacesDir, cfg.socket);
  console.log(`Destroyed run ${runId.slice(0, 8)}`);
}

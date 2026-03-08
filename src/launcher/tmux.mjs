/**
 * Synchronous tmux helpers for the launcher.
 * These are one-time setup calls, not hot-path — execFileSync is fine.
 *
 * @typedef {import('../types/runtime.js').TmuxRunner} TmuxRunner
 * @typedef {import('../types/runtime.js').TermSize} TermSize
 * @typedef {import('../types/runtime.js').TmuxLayout} TmuxLayout
 * @typedef {import('../types/runtime.js').LaunchRouterOptions} LaunchRouterOptions
 */

import { execFileSync, spawnSync } from 'child_process';
import { entryPaths, nodeArgs } from '../runtime/entry-paths.mjs';

/**
 * Shell-quote a string for safe interpolation into commands typed into tmux panes.
 * Uses POSIX single-quote wrapping: wrap in '' and escape internal ' as '\''
 * @param {string} s
 * @returns {string}
 */
export function shellQuote(s) {
  if (s === '') return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Create a tmux runner that optionally uses a custom socket.
 * Returns a function that calls tmux with the given args and returns stdout.
 * @param {string | undefined} socket
 * @returns {TmuxRunner}
 */
export function createTmuxRunner(socket) {
  return function tmux(/** @type {string[]} */ ...args) {
    const fullArgs = socket ? ['-S', socket, ...args] : args;
    return execFileSync('tmux', fullArgs, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  };
}

/**
 * Get terminal dimensions from env vars, tput, or defaults.
 * @returns {TermSize}
 */
export function getTermSize() {
  let cols = parseInt(process.env.COLUMNS || '', 10);
  if (!cols || isNaN(cols)) {
    try {
      cols = parseInt(execFileSync('tput', ['cols'], { encoding: 'utf8' }).trim(), 10);
    } catch {}
  }
  if (!cols || isNaN(cols)) cols = 120;

  let lines = parseInt(process.env.LINES || '', 10);
  if (!lines || isNaN(lines)) {
    try {
      lines = parseInt(execFileSync('tput', ['lines'], { encoding: 'utf8' }).trim(), 10);
    } catch {}
  }
  if (!lines || isNaN(lines)) lines = 40;

  return { cols, lines };
}

/**
 * Create the 3-pane tmux layout with styling.
 * @param {TmuxRunner} tmux
 * @param {string} session
 * @returns {TmuxLayout}
 */
export function createTmuxLayout(tmux, session) {
  try { tmux('kill-session', '-t', session); } catch {}

  const { cols, lines } = getTermSize();
  const routerHeight = Math.floor(lines * 30 / 100);
  const codexWidth = Math.floor((cols - 1) / 2);

  const claudePane = tmux('new-session', '-d', '-s', session,
    '-x', String(cols), '-y', String(lines),
    '-P', '-F', '#{pane_id}');
  const routerPane = tmux('split-window', '-v', '-t', claudePane,
    '-l', String(routerHeight), '-P', '-F', '#{pane_id}');
  const codexPane = tmux('split-window', '-h', '-t', claudePane,
    '-l', String(codexWidth), '-P', '-F', '#{pane_id}');

  // Styling
  tmux('set', '-t', session, 'mouse', 'on');
  tmux('set', '-t', session, 'status', 'on');
  tmux('set', '-t', session, 'status-style', 'bg=#1a1a2e,fg=#cccccc');
  tmux('set', '-t', session, 'status-left', ' #[fg=#00d4ff,bold]DUET#[default] | ');
  tmux('set', '-t', session, 'status-right',
    ' #[fg=#ff79c6]Claude#[default] + #[fg=#50fa7b]Codex#[default] ');
  tmux('set', '-t', session, 'status-left-length', '20');
  tmux('set', '-t', session, 'status-right-length', '40');
  tmux('set', '-t', session, 'pane-border-style', 'fg=#444444');
  tmux('set', '-t', session, 'pane-active-border-style', 'fg=#00bfff,bold');

  tmux('select-pane', '-t', claudePane, '-T', 'Claude Code');
  tmux('select-pane', '-t', codexPane, '-T', 'Codex');
  tmux('select-pane', '-t', routerPane, '-T', 'Duet Router');
  tmux('set', '-t', session, 'pane-border-format', ' #{pane_title} ');
  tmux('set', '-t', session, 'pane-border-status', 'top');

  return { claudePane, codexPane, routerPane };
}

/**
 * Launch the router process in the bottom pane.
 * @param {TmuxRunner} tmux
 * @param {string} routerPane
 * @param {LaunchRouterOptions} options
 */
export function launchRouter(tmux, routerPane, { session, runDir, mode, claudePane, codexPane }) {
  const qRunDir = shellQuote(runDir);
  const nodeCmd = ['node', ...nodeArgs, shellQuote(entryPaths.router)].join(' ');
  const cmd = `DUET_SESSION=${shellQuote(session)} CLAUDE_PANE=${claudePane} CODEX_PANE=${codexPane} DUET_STATE_DIR=${qRunDir} DUET_MODE=${mode} DUET_RUN_DIR=${qRunDir} ${nodeCmd}`;
  tmux('send-keys', '-t', routerPane, cmd, 'Enter');
  tmux('select-pane', '-t', routerPane);
}

/**
 * Check if a tmux session exists.
 * @param {TmuxRunner} tmux
 * @param {string} session
 * @returns {boolean}
 */
export function tmuxHasSession(tmux, session) {
  try {
    tmux('has-session', '-t', session);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach to a tmux session (blocks until detach).
 * Returns the exit code; callers should propagate failure.
 * @param {string} session
 * @param {string | undefined} socket
 * @returns {number}
 */
export function tmuxAttach(session, socket) {
  const args = socket
    ? ['-S', socket, 'attach', '-t', session]
    : ['attach', '-t', session];
  const result = spawnSync('tmux', args, { stdio: 'inherit' });
  return result.status || 0;
}

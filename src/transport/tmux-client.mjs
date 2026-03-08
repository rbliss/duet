import { exec } from 'child_process';
import { writeFile, unlink } from 'fs/promises';

// Build tmux command prefix — uses isolated socket when DUET_TMUX_SOCKET is set.
// Read lazily so tests can set process.env.DUET_TMUX_SOCKET after import.
/** @returns {string} */
function tmuxCmd() {
  return process.env.DUET_TMUX_SOCKET
    ? `tmux -S ${process.env.DUET_TMUX_SOCKET}`
    : 'tmux';
}

/**
 * @param {string} cmd
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Per-pane write queues to serialize sends/pastes to the same pane
/** @type {Map<string, Promise<unknown>>} */
const writeQueues = new Map();

/**
 * @template T
 * @param {string} pane
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueue(pane, fn) {
  const prev = writeQueues.get(pane) || Promise.resolve();
  const next = prev.then(fn, fn); // always proceed even if previous failed
  writeQueues.set(pane, next);
  return next;
}

// Monotonic counter for unique buffer names and temp files across concurrent pastes.
// Buffer names include PID to avoid collisions when multiple processes share a tmux server.
let pasteSeq = 0;

/**
 * @param {string} text
 * @returns {string}
 */
export function shellEscape(text) {
  return "'" + text.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * @param {string | undefined} pane
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function sendKeys(pane, text) {
  if (!pane) return false;
  return enqueue(pane, async () => {
    try {
      await execAsync(`${tmuxCmd()} send-keys -t ${shellEscape(pane)} -l ${shellEscape(text)}`);
      // Small delay so TUI apps (Codex/Ink) can process the input before Enter
      await delay(150);
      await execAsync(`${tmuxCmd()} send-keys -t ${shellEscape(pane)} Enter`);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * @param {string | undefined} pane
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function pasteToPane(pane, text) {
  if (!pane) return false;
  return enqueue(pane, async () => {
    const seq = pasteSeq++;
    const bufName = `duet-${process.pid}-${seq}`;
    const tmp = `/tmp/duet-paste-${process.pid}-${seq}.txt`;
    try {
      await writeFile(tmp, text);
      await execAsync(`${tmuxCmd()} load-buffer -b ${shellEscape(bufName)} ${shellEscape(tmp)}`);
      await execAsync(`${tmuxCmd()} paste-buffer -p -b ${shellEscape(bufName)} -t ${shellEscape(pane)}`);
      // Wait for TUI to process the pasted content before submitting
      await delay(500);
      await execAsync(`${tmuxCmd()} send-keys -t ${shellEscape(pane)} Enter`);
      return true;
    } catch {
      return false;
    } finally {
      try { await unlink(tmp); } catch {}
      try { await execAsync(`${tmuxCmd()} delete-buffer -b ${shellEscape(bufName)}`); } catch {}
    }
  });
}

/**
 * @param {string} pane
 * @param {number} [lines]
 * @returns {Promise<string>}
 */
export async function capturePane(pane, lines = 50) {
  try {
    const { stdout } = await execAsync(
      `${tmuxCmd()} capture-pane -t ${shellEscape(pane)} -p -S -${lines}`
    );
    return stdout;
  } catch {
    return '';
  }
}

/**
 * @param {string | undefined} pane
 * @returns {Promise<boolean>}
 */
export async function focusPane(pane) {
  if (!pane) return false;
  try {
    await execAsync(`${tmuxCmd()} select-pane -t ${shellEscape(pane)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} session
 * @returns {Promise<boolean>}
 */
export async function killSession(session) {
  try {
    await execAsync(`${tmuxCmd()} kill-session -t ${shellEscape(session)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} session
 * @returns {Promise<boolean>}
 */
export async function detachClient(session) {
  try {
    await execAsync(`${tmuxCmd()} detach-client -s ${shellEscape(session)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} target
 * @param {string} fmt
 * @returns {Promise<string>}
 */
export async function displayMessage(target, fmt) {
  try {
    const { stdout } = await execAsync(
      `${tmuxCmd()} display-message -t ${shellEscape(target)} -p ${shellEscape(fmt)}`
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

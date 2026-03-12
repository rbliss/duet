import { exec } from 'child_process';
import { writeFile, unlink } from 'fs/promises';

// Build tmux command prefix — uses isolated socket when DUET_TMUX_SOCKET is set.
// Read lazily so tests can set process.env.DUET_TMUX_SOCKET after import.
function tmuxCmd(): string {
  return process.env.DUET_TMUX_SOCKET
    ? `tmux -S ${process.env.DUET_TMUX_SOCKET}`
    : 'tmux';
}

function execAsync(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Per-pane write queues to serialize sends/pastes to the same pane
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(pane: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(pane) || Promise.resolve();
  const next = prev.then(fn, fn); // always proceed even if previous failed
  writeQueues.set(pane, next);
  return next;
}

// Delay between paste-buffer and send-keys Enter.
// TUI apps (Claude Code, Codex/Ink) may need time to process a bracketed paste
// before they're ready to accept Enter. Too short → Enter is ignored and the
// message sits in the input field without being submitted.
const PASTE_SUBMIT_DELAY_MS = 1000;

// Monotonic counter for unique buffer names and temp files across concurrent pastes.
// Buffer names include PID to avoid collisions when multiple processes share a tmux server.
let pasteSeq = 0;

export function shellEscape(text: string): string {
  return "'" + text.replace(/'/g, "'\"'\"'") + "'";
}

export async function sendKeys(pane: string | undefined, text: string): Promise<boolean> {
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

export async function pasteToPane(pane: string | undefined, text: string): Promise<boolean> {
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
      await delay(PASTE_SUBMIT_DELAY_MS);
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

export async function capturePane(pane: string, lines: number = 50): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `${tmuxCmd()} capture-pane -t ${shellEscape(pane)} -p -S -${lines}`
    );
    return stdout;
  } catch {
    return '';
  }
}

export async function focusPane(pane: string | undefined): Promise<boolean> {
  if (!pane) return false;
  try {
    await execAsync(`${tmuxCmd()} select-pane -t ${shellEscape(pane)}`);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(session: string): Promise<boolean> {
  try {
    await execAsync(`${tmuxCmd()} kill-session -t ${shellEscape(session)}`);
    return true;
  } catch {
    return false;
  }
}

export async function detachClient(session: string): Promise<boolean> {
  try {
    await execAsync(`${tmuxCmd()} detach-client -s ${shellEscape(session)}`);
    return true;
  } catch {
    return false;
  }
}

export async function displayMessage(target: string, fmt: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `${tmuxCmd()} display-message -t ${shellEscape(target)} -p ${shellEscape(fmt)}`
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

import { exec } from 'child_process';
import { writeFile, unlink } from 'fs/promises';

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Per-pane write queues to serialize sends/pastes to the same pane
const writeQueues = new Map();

function enqueue(pane, fn) {
  const prev = writeQueues.get(pane) || Promise.resolve();
  const next = prev.then(fn, fn); // always proceed even if previous failed
  writeQueues.set(pane, next);
  return next;
}

// Monotonic counter for unique buffer names and temp files across concurrent pastes
let pasteSeq = 0;

export function shellEscape(text) {
  return "'" + text.replace(/'/g, "'\"'\"'") + "'";
}

export async function sendKeys(pane, text) {
  return enqueue(pane, async () => {
    try {
      await execAsync(`tmux send-keys -t ${shellEscape(pane)} -l ${shellEscape(text)}`);
      // Small delay so TUI apps (Codex/Ink) can process the input before Enter
      await delay(150);
      await execAsync(`tmux send-keys -t ${shellEscape(pane)} Enter`);
      return true;
    } catch {
      return false;
    }
  });
}

export async function pasteToPane(pane, text) {
  return enqueue(pane, async () => {
    const seq = pasteSeq++;
    const bufName = `duet-${seq}`;
    const tmp = `/tmp/duet-paste-${process.pid}-${seq}.txt`;
    try {
      await writeFile(tmp, text);
      await execAsync(`tmux load-buffer -b ${shellEscape(bufName)} ${shellEscape(tmp)}`);
      await execAsync(`tmux paste-buffer -p -b ${shellEscape(bufName)} -t ${shellEscape(pane)}`);
      // Wait for TUI to process the pasted content before submitting
      await delay(500);
      await execAsync(`tmux send-keys -t ${shellEscape(pane)} Enter`);
      return true;
    } catch {
      return false;
    } finally {
      try { await unlink(tmp); } catch {}
      try { await execAsync(`tmux delete-buffer -b ${shellEscape(bufName)}`); } catch {}
    }
  });
}

export async function capturePane(pane, lines = 50) {
  try {
    const { stdout } = await execAsync(
      `tmux capture-pane -t ${shellEscape(pane)} -p -S -${lines}`
    );
    return stdout;
  } catch {
    return '';
  }
}

export async function focusPane(pane) {
  try {
    await execAsync(`tmux select-pane -t ${shellEscape(pane)}`);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(session) {
  try {
    await execAsync(`tmux kill-session -t ${shellEscape(session)}`);
    return true;
  } catch {
    return false;
  }
}

export async function detachClient(session) {
  try {
    await execAsync(`tmux detach-client -s ${shellEscape(session)}`);
    return true;
  } catch {
    return false;
  }
}

export async function displayMessage(target, fmt) {
  try {
    const { stdout } = await execAsync(
      `tmux display-message -t ${shellEscape(target)} -p ${shellEscape(fmt)}`
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

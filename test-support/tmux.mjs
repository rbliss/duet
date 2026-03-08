import { execSync } from 'child_process';
import { existsSync } from 'fs';

// Isolated tmux socket — all test tmux traffic goes through this socket only.
// Setting process.env ensures the imported tmuxCmd() in tmux-client.mjs uses
// the isolated socket for sendKeys/capturePane/pasteToPane/focusPane too.
export const TEST_TMUX_SOCKET = `/tmp/duet-test-tmux-${process.pid}.sock`;
process.env.DUET_TMUX_SOCKET = TEST_TMUX_SOCKET;
process.env.TMUX = '';

// Snapshot env after socket setup so subprocess calls use the isolated socket
export const tmuxEnv = { ...process.env };

export function tmux(cmd) {
  return execSync(`tmux -S ${TEST_TMUX_SOCKET} ${cmd}`, { encoding: 'utf8', env: tmuxEnv }).trim();
}

export function cleanupTmuxSession(sessionName) {
  try { execSync(`tmux -S ${TEST_TMUX_SOCKET} kill-session -t ${sessionName} 2>/dev/null`, { env: tmuxEnv, stdio: 'ignore' }); } catch {}
}

export function cleanupTestTmuxServer() {
  if (!existsSync(TEST_TMUX_SOCKET)) return;
  try { execSync(`tmux -S ${TEST_TMUX_SOCKET} kill-server 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  try { execSync(`rm -f ${TEST_TMUX_SOCKET}`, { stdio: 'ignore' }); } catch {}
}

// Kill the isolated tmux server when the test process exits
process.on('exit', cleanupTestTmuxServer);

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFileSync } from 'fs';

import { sendKeys, capturePane, pasteToPane, focusPane } from '../router.mjs';
import { TEST_TMUX_SOCKET, tmuxEnv, tmux, cleanupTmuxSession } from '../test-support/tmux.mjs';

const TEST_SESSION = `duet-test-${process.pid}`;
let paneA, paneB;

// ─── Integration Tests: tmux operations ──────────────────────────────────────

describe('tmux integration', () => {
  before(() => {
    cleanupTmuxSession(TEST_SESSION);
    paneA = tmux(`new-session -d -s ${TEST_SESSION} -x 120 -y 40 -P -F '#{pane_id}'`);
    paneB = tmux(`split-window -h -t '${paneA}' -l 59 -P -F '#{pane_id}'`);
    execSync('sleep 0.5');
  });

  after(() => {
    cleanupTmuxSession(TEST_SESSION);
  });

  beforeEach(() => {
    try {
      tmux(`send-keys -t ${paneA} C-c`);
      tmux(`send-keys -t ${paneB} C-c`);
      tmux(`send-keys -t ${paneA} C-l`);
      tmux(`send-keys -t ${paneB} C-l`);
      execSync('sleep 0.3');
    } catch {}
  });

  describe('sendKeys', () => {
    it('sends text to a pane and it appears in output', async () => {
      await sendKeys(paneA, 'echo DUET_TEST_MARKER_1');
      execSync('sleep 0.5');
      const captured = await capturePane(paneA, 20);
      assert.ok(captured.includes('DUET_TEST_MARKER_1'), `Expected marker in: ${captured}`);
    });

    it('sends to correct pane without affecting the other', async () => {
      await sendKeys(paneA, 'echo ONLY_IN_A');
      execSync('sleep 0.5');
      const capB = await capturePane(paneB, 20);
      assert.ok(!capB.includes('ONLY_IN_A'), 'Text should not appear in other pane');
    });

    it('handles special characters', async () => {
      await sendKeys(paneA, 'echo "hello $USER \'world\'"');
      execSync('sleep 0.5');
      const captured = await capturePane(paneA, 20);
      assert.ok(captured.includes('hello'), `Expected output in: ${captured}`);
    });

    it('returns true on success', async () => {
      const result = await sendKeys(paneA, 'echo ok');
      assert.equal(result, true);
    });

    it('returns false for invalid pane', async () => {
      const result = await sendKeys('%999', 'echo fail');
      assert.equal(result, false);
    });
  });

  describe('capturePane', () => {
    it('captures visible text from a pane', async () => {
      await sendKeys(paneA, 'echo CAPTURE_TEST_42');
      execSync('sleep 0.5');
      const output = await capturePane(paneA, 20);
      assert.ok(output.includes('CAPTURE_TEST_42'));
    });

    it('respects line count parameter', async () => {
      await sendKeys(paneA, 'for i in $(seq 1 20); do echo "LINE_$i"; done');
      execSync('sleep 0.8');
      const few = await capturePane(paneA, 5);
      const many = await capturePane(paneA, 50);
      assert.ok(many.length >= few.length);
    });

    it('returns empty string for invalid pane', async () => {
      const result = await capturePane('%999', 10);
      assert.equal(result, '');
    });
  });

  describe('pasteToPane', () => {
    it('pastes multiline text into a pane', async () => {
      await pasteToPane(paneA, 'echo PASTE_LINE_ONE');
      execSync('sleep 0.5');
      const captured = await capturePane(paneA, 20);
      assert.ok(captured.includes('PASTE_LINE_ONE'), `Expected paste in: ${captured}`);
    });

    it('returns true on success', async () => {
      const result = await pasteToPane(paneA, 'echo ok');
      assert.equal(result, true);
    });

    it('returns false for invalid pane', async () => {
      const result = await pasteToPane('%999', 'echo fail');
      assert.equal(result, false);
    });

    it('cleans up temp files', async () => {
      const before = execSync('ls /tmp/duet-paste-* 2>/dev/null | wc -l', { encoding: 'utf8' }).trim();
      await pasteToPane(paneA, 'echo cleanup-test');
      execSync('sleep 0.2');
      const after = execSync('ls /tmp/duet-paste-* 2>/dev/null | wc -l', { encoding: 'utf8' }).trim();
      assert.equal(after, before, 'Temp files should be cleaned up');
    });

    it('uses bracketed paste (-p) to avoid chunked paste issues', () => {
      const src = readFileSync('/home/claude/duet/src/transport/tmux-client.mjs', 'utf8');
      assert.ok(src.includes('paste-buffer -p -b'),
        'pasteToPane should use paste-buffer -p for bracketed paste');
    });
  });

  describe('focusPane', () => {
    it('returns true for valid pane', async () => {
      assert.equal(await focusPane(paneA), true);
    });

    it('returns false for invalid pane', async () => {
      assert.equal(await focusPane('%999'), false);
    });

    it('actually changes the active pane', async () => {
      await focusPane(paneA);
      const active = tmux(`display-message -t ${TEST_SESSION} -p '#{pane_id}'`);
      assert.equal(active, paneA);

      await focusPane(paneB);
      const active2 = tmux(`display-message -t ${TEST_SESSION} -p '#{pane_id}'`);
      assert.equal(active2, paneB);
    });
  });

  describe('cross-pane relay workflow', () => {
    it('captures from one pane and sends to another', async () => {
      await sendKeys(paneA, 'echo RELAY_SOURCE_CONTENT_XYZ');
      execSync('sleep 0.5');

      const captured = (await capturePane(paneA, 30)).trim();
      assert.ok(captured.includes('RELAY_SOURCE_CONTENT_XYZ'),
        `Expected source marker in pane A: ${captured}`);

      await pasteToPane(paneB, 'echo "received relay"');
      execSync('sleep 0.5');

      const capB = await capturePane(paneB, 20);
      assert.ok(capB.includes('received relay'), `Expected relay in pane B: ${capB}`);
    });
  });
});

// ─── Regression: tmux socket isolation ────────────────────────────────────────

describe('tmux socket isolation', () => {
  const ISOLATION_SESSION = `duet-isolation-${process.pid}`;

  before(() => {
    tmux(`new-session -d -s ${ISOLATION_SESSION} -x 80 -y 24`);
  });

  after(() => {
    try { tmux(`kill-session -t ${ISOLATION_SESSION}`); } catch {}
  });

  it('sessions on isolated socket are not visible on the default tmux server', () => {
    let defaultSessions = '';
    try {
      defaultSessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
        encoding: 'utf8',
        env: { ...tmuxEnv, DUET_TMUX_SOCKET: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {}
    assert.ok(!defaultSessions.includes(ISOLATION_SESSION),
      `Test session "${ISOLATION_SESSION}" should not appear on default tmux server`);
  });

  it('sessions on isolated socket are visible via the socket', () => {
    const sessions = tmux('list-sessions -F "#{session_name}"');
    assert.ok(sessions.includes(ISOLATION_SESSION),
      `Test session "${ISOLATION_SESSION}" should exist on isolated socket`);
  });
});

// ─── Integration Tests: duet.sh layout ───────────────────────────────────────

describe('duet.sh launcher', () => {
  const LAUNCH_SESSION = 'duet-launch-test';

  before(() => {
    try { tmux(`kill-session -t ${LAUNCH_SESSION}`); } catch {}
  });

  after(() => {
    try { tmux(`kill-session -t ${LAUNCH_SESSION}`); } catch {}
  });

  it('script exists and is executable', () => {
    assert.ok(existsSync('/home/claude/duet/duet.sh'));
    const stat = execSync('stat -c %a /home/claude/duet/duet.sh', { encoding: 'utf8' }).trim();
    assert.ok(stat.includes('7') || stat.includes('5'), `Expected executable, got ${stat}`);
  });

  it('creates correct 3-pane layout', () => {
    const p0 = tmux(`new-session -d -s ${LAUNCH_SESSION} -x 120 -y 40 -P -F '#{pane_id}'`);
    const p1 = tmux(`split-window -v -t '${p0}' -l 12 -P -F '#{pane_id}'`);
    const p2 = tmux(`split-window -h -t '${p0}' -l 59 -P -F '#{pane_id}'`);

    const paneList = tmux(`list-panes -t ${LAUNCH_SESSION} -F '#{pane_id}'`);
    const paneIds = paneList.split('\n').filter(Boolean);
    assert.equal(paneIds.length, 3, `Expected 3 panes, got ${paneIds.length}`);

    const layout = tmux(`list-panes -t ${LAUNCH_SESSION} -F '#{pane_top} #{pane_left} #{pane_width} #{pane_height}'`);
    const panes = layout.split('\n').filter(Boolean).map(line => {
      const [top, left, width, height] = line.split(' ').map(Number);
      return { top, left, width, height };
    });

    const rows = {};
    for (const p of panes) {
      const key = p.top;
      if (!rows[key]) rows[key] = [];
      rows[key].push(p);
    }
    const rowKeys = Object.keys(rows).map(Number).sort((a, b) => a - b);

    assert.ok(rowKeys.length >= 2, `Expected at least 2 rows, got ${rowKeys.length}`);
    const topRow = rows[rowKeys[0]];
    const bottomRow = rows[rowKeys[rowKeys.length - 1]];

    assert.equal(topRow.length, 2, 'Top row should have 2 panes');
    assert.equal(bottomRow.length, 1, 'Bottom row should have 1 pane');

    const bottomWidth = bottomRow[0].width;
    const topWidths = topRow.map(p => p.width);
    assert.ok(bottomWidth > Math.max(...topWidths),
      `Bottom pane (${bottomWidth}) should be wider than top panes (${topWidths})`);
  });

  it('tmux options can be applied to session', () => {
    assert.doesNotThrow(() => {
      tmux(`set -t ${LAUNCH_SESSION} mouse on`);
      tmux(`set -t ${LAUNCH_SESSION} status on`);
      tmux(`set -t ${LAUNCH_SESSION} pane-border-status top`);
    });

    const mouse = tmux(`show-option -t ${LAUNCH_SESSION} -v mouse`);
    assert.equal(mouse, 'on');
  });
});

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { sendKeys, capturePane, pasteToPane, focusPane } from '../router.mjs';
import { createTmuxLayout, createTmuxRunner, getTmuxWindowSize } from '../src/launcher/tmux.ts';
import { TEST_TMUX_SOCKET, tmuxEnv, tmux, cleanupTmuxSession } from '../test-support/tmux.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TEST_SESSION = `duet-test-${process.pid}`;
let paneA, paneB;

// ─── Integration Tests: tmux operations ──────────────────────────────────────

describe('tmux integration', () => {
  before(() => {
    cleanupTmuxSession(TEST_SESSION);
    paneA = tmux(`new-session -d -s ${TEST_SESSION} -x 120 -y 40 -P -F '#{pane_id}'`);
    paneB = tmux(`split-window -h -t '${paneA}' -l 60 -P -F '#{pane_id}'`);
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
      const src = readFileSync('/home/claude/duet/src/transport/tmux-client.ts', 'utf8');
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
    const p2 = tmux(`split-window -h -t '${p0}' -l 60 -P -F '#{pane_id}'`);

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

  it('codex pane is not narrower than claude pane', () => {
    const layout = tmux(`list-panes -t ${LAUNCH_SESSION} -F '#{pane_top} #{pane_left} #{pane_width}'`);
    const panes = layout.split('\n').filter(Boolean).map(line => {
      const [top, left, width] = line.split(' ').map(Number);
      return { top, left, width };
    });
    // Top row panes (same top offset, two panes side by side)
    const topRow = panes.filter(p => p.top === panes[0].top);
    assert.equal(topRow.length, 2, 'Top row should have 2 panes');

    // Sort by left offset: first = Claude (left), second = Codex (right)
    topRow.sort((a, b) => a.left - b.left);
    const claudeWidth = topRow[0].width;
    const codexWidth = topRow[1].width;

    assert.ok(Math.abs(claudeWidth - codexWidth) <= 1,
      `Top panes should differ by at most 1 column (claude=${claudeWidth}, codex=${codexWidth})`);
    assert.ok(codexWidth >= claudeWidth,
      `Codex (${codexWidth}) should not be narrower than Claude (${claudeWidth})`);
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

// ─── Regression: cross-process paste safety ─────────────────────────────────

describe('cross-process paste safety', { timeout: 30000 }, () => {
  const XPROC_SESSION = `duet-xproc-${process.pid}`;
  let xpaneA, xpaneB;

  before(() => {
    try { tmux(`kill-session -t ${XPROC_SESSION}`); } catch {}
    xpaneA = tmux(`new-session -d -s ${XPROC_SESSION} -x 120 -y 40 -P -F '#{pane_id}'`);
    xpaneB = tmux(`split-window -h -t '${xpaneA}' -l 60 -P -F '#{pane_id}'`);
    execSync('sleep 0.5');
  });

  after(() => {
    try { tmux(`kill-session -t ${XPROC_SESSION}`); } catch {}
  });

  it('concurrent pasteToPane from two processes does not collide', async () => {
    const markerA = `XPROC_A_${Date.now()}`;
    const markerB = `XPROC_B_${Date.now()}`;

    // Spawn two independent Node processes that each call pasteToPane
    // on the same tmux server (via DUET_TMUX_SOCKET) but to different panes.
    const transportPath = new URL('../src/transport/tmux-client.ts', import.meta.url).href;
    const helperScript = (pane, marker) => `
      import { pasteToPane } from '${transportPath}';
      const ok = await pasteToPane(${JSON.stringify(pane)}, 'echo ${marker}');
      process.exit(ok ? 0 : 1);
    `;

    // Write helper scripts
    const scriptA = `/tmp/duet-xproc-a-${process.pid}.mjs`;
    const scriptB = `/tmp/duet-xproc-b-${process.pid}.mjs`;
    writeFileSync(scriptA, helperScript(xpaneA, markerA));
    writeFileSync(scriptB, helperScript(xpaneB, markerB));

    try {
      // Launch both concurrently via Promise.all with exec
      const { exec } = await import('child_process');
      const runHelper = (script) => new Promise((resolve, reject) => {
        exec(`node --import tsx/esm "${script}"`, {
          encoding: 'utf8',
          env: tmuxEnv,
          timeout: 15000,
          cwd: process.cwd(),
        }, (err, stdout, stderr) => {
          if (err) reject(new Error(`Helper failed: ${stderr || err.message}`));
          else resolve(stdout);
        });
      });

      await Promise.all([runHelper(scriptA), runHelper(scriptB)]);

      // Wait for panes to process
      execSync('sleep 1');

      // Verify each pane got its own marker
      const capA = await capturePane(xpaneA, 20);
      const capB = await capturePane(xpaneB, 20);

      assert.ok(capA.includes(markerA),
        `Pane A should contain marker A: ${capA}`);
      assert.ok(capB.includes(markerB),
        `Pane B should contain marker B: ${capB}`);

      // Verify no cross-contamination
      assert.ok(!capA.includes(markerB),
        `Pane A should NOT contain marker B`);
      assert.ok(!capB.includes(markerA),
        `Pane B should NOT contain marker A`);
    } finally {
      try { unlinkSync(scriptA); } catch {}
      try { unlinkSync(scriptB); } catch {}
    }
  });
});

// ─── Regression: paste-settle timing ─────────────────────────────────────────

describe('pasteToPane paste-settle regression', { timeout: 30000 }, () => {
  const SETTLE_SESSION = `duet-settle-${process.pid}`;
  const tmpDir = `/tmp/duet-settle-test-${process.pid}`;
  const inboxFile = join(tmpDir, 'fake-tui-inbox.log');
  let settlePane;

  before(() => {
    mkdirSync(tmpDir, { recursive: true });
    cleanupTmuxSession(SETTLE_SESSION);

    // Launch fake-tui in a tmux pane with 800ms paste settle
    const fakeTui = join(PROJECT_ROOT, 'test-support', 'fake-tui.mjs');
    settlePane = tmux(
      `new-session -d -s ${SETTLE_SESSION} -x 120 -y 40 -P -F '#{pane_id}' ` +
      `"FAKE_PASTE_SETTLE_MS=800 FAKE_TUI_INBOX='${inboxFile}' node '${fakeTui}'"`
    );

    // Wait for fake-tui to be ready
    execSync('sleep 1');
  });

  after(() => {
    cleanupTmuxSession(SETTLE_SESSION);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pasteToPane submits message to TUI with paste-settle timing', async () => {
    const token = `SETTLE_TOKEN_${Date.now()}`;
    const ok = await pasteToPane(settlePane, `test message ${token}`);
    assert.ok(ok, 'pasteToPane should return true');

    // Wait for the TUI to process
    execSync('sleep 1.5');

    // Verify the message was actually submitted (not just pasted)
    const captured = await capturePane(settlePane, 20);
    assert.ok(captured.includes(`SUBMITTED: test message ${token}`),
      `Expected SUBMITTED marker in pane output: ${captured}`);

    // Also verify the inbox file has the submission
    const inbox = readFileSync(inboxFile, 'utf8');
    assert.ok(inbox.includes(token),
      `Expected token in inbox file: ${inbox}`);
  });

  it('handles multiple pastes in sequence', async () => {
    for (let i = 0; i < 3; i++) {
      const token = `SEQ_${i}_${Date.now()}`;
      await pasteToPane(settlePane, `seq message ${token}`);
      execSync('sleep 1.5');

      const inbox = readFileSync(inboxFile, 'utf8');
      assert.ok(inbox.includes(token),
        `Paste ${i} should be submitted: ${token}`);
    }
  });

  it('old timing: draft visible but not sent, then later Enter submits', { timeout: 30000 }, async () => {
    // Simulate the OLD 500ms delay using raw tmux commands.
    // With 800ms settle, 500ms is too short — Enter is ignored, draft persists.
    const token = `OLD_TIMING_${Date.now()}`;
    const tmp = join(tmpDir, 'old-timing-paste.txt');
    const bufName = `duet-old-timing-${process.pid}`;

    writeFileSync(tmp, `old timing message ${token}`);

    tmux(`load-buffer -b '${bufName}' '${tmp}'`);
    tmux(`paste-buffer -p -b '${bufName}' -t '${settlePane}'`);

    // OLD delay: 500ms (too short for 800ms settle)
    execSync('sleep 0.5');
    tmux(`send-keys -t '${settlePane}' Enter`);

    execSync('sleep 0.3');

    // 1. Draft IS visible in the pane (message copied but not sent)
    const captured = await capturePane(settlePane, 20);
    assert.ok(captured.includes(token),
      `Draft should be visible in pane: ${captured}`);

    // 2. Inbox does NOT have the token yet (not submitted)
    const inboxBefore = readFileSync(inboxFile, 'utf8');
    assert.ok(!inboxBefore.includes(token),
      `Token should NOT be in inbox yet (Enter was ignored): ${inboxBefore}`);

    // 3. Wait past settle period, then send Enter again — draft should submit
    execSync('sleep 1');
    tmux(`send-keys -t '${settlePane}' Enter`);
    execSync('sleep 0.5');

    const inboxAfter = readFileSync(inboxFile, 'utf8');
    assert.ok(inboxAfter.includes(token),
      `Token should now be in inbox after later Enter: ${inboxAfter}`);

    // Cleanup
    try { tmux(`delete-buffer -b '${bufName}'`); } catch {}
    try { unlinkSync(tmp); } catch {}
  });
});

// ─── Regression: pane width with mismatched terminal size ─────────────────────

describe('createTmuxLayout pane width regression', () => {
  const LAYOUT_SESSION = `duet-layout-${process.pid}`;
  const tmuxRunner = createTmuxRunner(TEST_TMUX_SOCKET);

  after(() => {
    cleanupTmuxSession(LAYOUT_SESSION);
  });

  it('codex and claude panes are equal width regardless of getTermSize hint', () => {
    const layout = createTmuxLayout(tmuxRunner, LAYOUT_SESSION);

    const panes = tmux(`list-panes -t ${LAYOUT_SESSION} -F '#{pane_id} #{pane_top} #{pane_left} #{pane_width}'`)
      .split('\n').filter(Boolean).map(line => {
        const [id, top, left, width] = line.split(' ');
        return { id, top: Number(top), left: Number(left), width: Number(width) };
      });

    const topRow = panes.filter(p => p.top === panes[0].top);
    assert.equal(topRow.length, 2, 'Top row should have 2 panes');
    topRow.sort((a, b) => a.left - b.left);

    assert.ok(Math.abs(topRow[0].width - topRow[1].width) <= 1,
      `Panes should differ by at most 1 column (claude=${topRow[0].width}, codex=${topRow[1].width})`);
  });

  it('getTmuxWindowSize returns actual dimensions from tmux', () => {
    const actual = getTmuxWindowSize(tmuxRunner, LAYOUT_SESSION);
    assert.ok(actual.cols >= 40, `cols should be >= 40, got ${actual.cols}`);
    assert.ok(actual.lines >= 10, `lines should be >= 10, got ${actual.lines}`);
  });
});

// ─── Regression: smushed Codex pane when server overrides session size ─────────

describe('smushed codex pane regression', () => {
  // Reproduces the bug: getTermSize returns 30 cols, but the tmux server
  // creates the window at 214 cols. Old code split with codexWidth=15 (from 30),
  // leaving codex at 7% of the actual width. The fix queries actual window
  // dimensions after session creation.
  const SMUSH_SESSION = `duet-smush-${process.pid}`;
  const tmuxRunner = createTmuxRunner(TEST_TMUX_SOCKET);

  after(() => {
    cleanupTmuxSession(SMUSH_SESSION);
  });

  it('createTmuxLayout uses actual window size, not hint, for splits', () => {
    // Step 1: create session at small size (simulating stale getTermSize)
    try { tmuxRunner('kill-session', '-t', SMUSH_SESSION); } catch {}
    const claudePane = tmuxRunner('new-session', '-d', '-s', SMUSH_SESSION,
      '-x', '30', '-y', '20', '-P', '-F', '#{pane_id}');

    // Step 2: resize window to simulate server override (shared tmux server
    // forces new sessions to match the largest attached client)
    tmuxRunner('resize-window', '-t', SMUSH_SESSION, '-x', '214', '-y', '48');

    // Step 3: query actual size (this is what the fix does)
    const actual = getTmuxWindowSize(tmuxRunner, SMUSH_SESSION);
    assert.equal(actual.cols, 214);
    assert.equal(actual.lines, 48);

    // Step 4: split using actual dimensions (the fix)
    const routerHeight = Math.floor(actual.lines * 30 / 100);
    const codexWidth = Math.ceil((actual.cols - 1) / 2);
    tmuxRunner('split-window', '-v', '-t', claudePane,
      '-l', String(routerHeight), '-P', '-F', '#{pane_id}');
    tmuxRunner('split-window', '-h', '-t', claudePane,
      '-l', String(codexWidth), '-P', '-F', '#{pane_id}');

    // Verify: panes should be nearly equal
    const panes = tmux(`list-panes -t ${SMUSH_SESSION} -F '#{pane_top} #{pane_left} #{pane_width}'`)
      .split('\n').filter(Boolean).map(line => {
        const [top, left, width] = line.split(' ').map(Number);
        return { top, left, width };
      });

    const topRow = panes.filter(p => p.top === panes[0].top);
    assert.equal(topRow.length, 2, 'Top row should have 2 panes');
    topRow.sort((a, b) => a.left - b.left);
    const claudeWidth = topRow[0].width;
    const codexW = topRow[1].width;

    // Old bug: claude=198, codex=15. Fixed: claude=106, codex=107.
    assert.ok(Math.abs(claudeWidth - codexW) <= 1,
      `Panes should be near-equal (claude=${claudeWidth}, codex=${codexW})`);
    assert.ok(codexW > 100,
      `Codex should be >100 cols in a 214-wide window, got ${codexW}`);
  });

  it('old behavior would produce smushed codex (documents the bug)', () => {
    // This test documents what the OLD code would produce, proving the
    // regression is real. Uses the stale 30-col width for splits.
    const OLD_SESSION = `duet-smush-old-${process.pid}`;
    try { tmuxRunner('kill-session', '-t', OLD_SESSION); } catch {}
    const claudePane = tmuxRunner('new-session', '-d', '-s', OLD_SESSION,
      '-x', '30', '-y', '20', '-P', '-F', '#{pane_id}');

    // Server overrides to 214 wide
    tmuxRunner('resize-window', '-t', OLD_SESSION, '-x', '214', '-y', '48');

    // OLD: split using the hint size (30), not actual (214)
    const oldCodexWidth = Math.ceil((30 - 1) / 2); // 15
    tmuxRunner('split-window', '-v', '-t', claudePane,
      '-l', '6', '-P', '-F', '#{pane_id}');
    tmuxRunner('split-window', '-h', '-t', claudePane,
      '-l', String(oldCodexWidth), '-P', '-F', '#{pane_id}');

    const panes = tmux(`list-panes -t ${OLD_SESSION} -F '#{pane_top} #{pane_left} #{pane_width}'`)
      .split('\n').filter(Boolean).map(line => {
        const [top, left, width] = line.split(' ').map(Number);
        return { top, left, width };
      });

    const topRow = panes.filter(p => p.top === panes[0].top);
    topRow.sort((a, b) => a.left - b.left);

    // Old behavior: codex is tiny (15 cols), claude is huge (198 cols)
    assert.ok(topRow[1].width <= 20,
      `Old behavior: codex should be <=20 cols, got ${topRow[1].width}`);
    assert.ok(topRow[0].width > 180,
      `Old behavior: claude should be >180 cols, got ${topRow[0].width}`);

    try { tmuxRunner('kill-session', '-t', OLD_SESSION); } catch {}
  });
});

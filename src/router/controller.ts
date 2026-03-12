/**
 * Router controller: command handlers, output relay, banner, and main entry.
 */

import { createInterface } from 'readline';
import { rmSync } from 'fs';

import type { ToolName, ConverseState, SessionStateMap } from '../types/runtime.js';

import { parseInput, detectMentions } from './commands.js';
import {
  C, SESSION, PANES, RELAY_COOLDOWN_MS,
  lastAutoRelayTime, watcherFailed,
  setRl, isWatching, prompt, bindingStatus,
  getConverseState, setConverseState, setNewOutputHandler,
  getSessionResponse, readRunJson, getRouterState,
  startPolling, stopPolling, startFileWatcher, stopFileWatchers,
  findRebindCandidate, rebindTool,
} from './state.js';
import {
  sendKeys, pasteToPane, capturePane, focusPane,
  killSession, detachClient,
} from '../transport/tmux-client.js';
import { sessionState as _sessionState, resolveSessionPath } from '../relay/session-reader.js';

const sessionState = _sessionState as SessionStateMap;
import { loadBindings } from '../runtime/bindings-store.js';
import { updateRunJson } from '../runtime/run-store.js';
import { collectDebugSnapshot, renderDebugReport } from '../debug/debug-report.js';

// ─── Output relay ────────────────────────────────────────────────────────────

export async function handleNewOutput(source: ToolName, newContent: string): Promise<void> {
  const other: ToolName = source === 'claude' ? 'codex' : 'claude';
  const now = Date.now();
  const converseState = getConverseState();

  // --- Converse mode auto-relay (turn tracking prevents loops — no cooldown) ---
  if (converseState && converseState.turn === source) {
    converseState.rounds++;
    if (converseState.rounds > converseState.maxRounds) {
      console.log(`\n${C.yellow}[converse] Reached ${converseState.maxRounds} rounds — stopping${C.reset}`);
      setConverseState(null);
      prompt();
      return;
    }

    const direction = `${source}->${other}`;
    const response = getSessionResponse(source) || newContent;
    console.log(`\n${C.blue}[converse] round ${converseState.rounds}/${converseState.maxRounds}: ${source} -> ${other}${C.reset}`);
    const msg = `${source} says (round ${converseState.rounds} on "${converseState.topic}"):\n${response}`;
    const delivered = await pasteToPane(PANES[other], msg);
    if (!delivered) {
      // Don't advance turn or record cooldown on failed delivery
      converseState.rounds--;
      console.log(`${C.red}[converse] delivery to ${other} failed — turn not advanced${C.reset}`);
      prompt();
      return;
    }
    lastAutoRelayTime[direction] = now;
    converseState.turn = other;
    prompt();
    return;
  }

  // --- @mention detection (per-direction cooldown to prevent loops) ---
  const direction = `${source}->${other}`;
  if (now - (lastAutoRelayTime[direction] || 0) < RELAY_COOLDOWN_MS) return;

  const mentions = detectMentions(newContent);
  const mentionsOther = mentions.includes(other);

  if (mentionsOther) {
    const response = getSessionResponse(source) || newContent;
    console.log(`\n${C.blue}[auto] ${source} mentioned @${other} — relaying${C.reset}`);
    const msg = `${source} says:\n${response}`;
    const delivered = await pasteToPane(PANES[other], msg);
    if (delivered) {
      lastAutoRelayTime[direction] = now;
    } else {
      console.log(`${C.red}[auto] delivery to ${other} failed${C.reset}`);
    }
    prompt();
  }
}

// ─── Banner ──────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log(`
${C.cyan}${C.bold}  DUET ${C.reset}${C.dim} - Claude Code + Codex, one conversation${C.reset}

  ${C.magenta}@claude${C.reset} <msg>            Send to Claude Code
  ${C.green}@codex${C.reset}  <msg>            Send to Codex
  ${C.yellow}@both${C.reset}   <msg>            Send to both
  ${C.blue}@relay${C.reset}  src>dst [msg]    Relay one's output to the other

  ${C.cyan}/converse${C.reset} [n] <topic>    Start an n-round discussion (default 10)
  ${C.cyan}/watch${C.reset}                   Watch for @mentions and auto-relay
  ${C.cyan}/stop${C.reset}                    Stop watching / converse
  ${C.cyan}/status${C.reset}                  Show watch/converse state

  ${C.dim}/debug [full]             Print live debug snapshot
  /send-debug target [note] Send debug snapshot to claude|codex
  /focus claude|codex      Switch to pane (click router pane to return)
  /snap  claude|codex      View last output from a pane
  /rebind claude|codex     Re-discover session after manual /resume
  /clear                   Clear this screen
  /quit                    Stop tools, preserve state for resume
  /detach                  Detach — tools keep running
  /destroy                 Stop tools and remove all run state
  /help                    Show this help${C.reset}
`);
}

// ─── Input handling ──────────────────────────────────────────────────────────

async function handleInput(input: string): Promise<void> {
  const parsed = parseInput(input);

  switch (parsed.type) {
    case 'empty': return;
    case 'help': return printBanner();
    case 'quit':
      stopPolling();
      console.log(`${C.dim}Stopping tools...${C.reset}`);
      await sendKeys(PANES.claude, '/exit');
      await sendKeys(PANES.codex, '/exit');
      updateRunJson({ status: 'stopped', updated_at: new Date().toISOString() });
      console.log(`${C.dim}Run state preserved — use 'duet resume' to continue.${C.reset}`);
      setTimeout(async () => {
        await killSession(SESSION);
        process.exit(0);
      }, 3000);
      return;
    case 'detach':
      console.log(`${C.dim}Detaching — tools will keep running. Reattach with 'duet'.${C.reset}`);
      if (!await detachClient(SESSION)) {
        console.log(`${C.red}Failed to detach${C.reset}`);
      }
      return;
    case 'destroy':
      stopPolling();
      console.log(`${C.dim}Destroying run — stopping tools and removing state...${C.reset}`);
      await sendKeys(PANES.claude, '/exit');
      await sendKeys(PANES.codex, '/exit');
      setTimeout(async () => {
        const DUET_RUN_DIR = process.env.DUET_RUN_DIR || null;
        if (DUET_RUN_DIR) { try { rmSync(DUET_RUN_DIR, { recursive: true, force: true }); } catch {} }
        await killSession(SESSION);
        process.exit(0);
      }, 3000);
      return;
    case 'clear':
      process.stdout.write('\x1b[2J\x1b[H');
      return;
    case 'watch': {
      startPolling();
      console.log(`${C.cyan}Watching for @mentions — tools can now talk to each other${C.reset}`);
      for (const tool of (['claude', 'codex'] as ToolName[])) {
        const bs = bindingStatus(tool);
        const color = tool === 'claude' ? C.magenta : C.green;
        if (bs === 'bound' && watcherFailed.has(tool)) {
          console.log(`  ${color}${tool}${C.reset}: ${C.red}inactive${C.reset} (watcher failed — /rebind ${tool})`);
        } else if (bs === 'bound') {
          console.log(`  ${color}${tool}${C.reset}: ${C.green}active${C.reset} (session-bound)`);
        } else if (bs === 'pending') {
          console.log(`  ${color}${tool}${C.reset}: ${C.yellow}waiting${C.reset} (binding pending)`);
        } else {
          console.log(`  ${color}${tool}${C.reset}: ${C.red}unavailable${C.reset} (binding degraded)`);
        }
      }
      return;
    }
    case 'stop':
      if (isWatching()) {
        stopPolling();
        console.log(`${C.dim}Stopped watching${C.reset}`);
      } else {
        console.log(`${C.dim}Nothing running${C.reset}`);
      }
      return;
    case 'status': {
      const cs = getConverseState();
      if (cs) {
        console.log(`${C.cyan}Converse:${C.reset} "${cs.topic}" — round ${cs.rounds}/${cs.maxRounds}, waiting on ${cs.turn}`);
      } else if (isWatching()) {
        console.log(`${C.cyan}Watching${C.reset} for @mentions`);
      } else {
        console.log(`${C.dim}Idle — not watching${C.reset}`);
      }
      for (const tool of (['claude', 'codex'] as ToolName[])) {
        const st = sessionState[tool];
        const bs = bindingStatus(tool);
        const color = tool === 'claude' ? C.magenta : C.green;
        const pad = tool === 'claude' ? '' : ' ';
        const level = st.bindingLevel ? ` (${st.bindingLevel})` : '';
        const watching = !!st.path && bs === 'bound' ? ', watching' : bs === 'pending' ? ', polling binding' : watcherFailed.has(tool) ? ', watcher failed' : '';
        const bsColor = (bs === 'bound' && !watcherFailed.has(tool)) ? C.green : bs === 'pending' ? C.yellow : C.red;
        const autoLabel = (bs === 'bound' && !watcherFailed.has(tool)) ? 'active' : bs === 'pending' ? 'waiting' : (bs === 'bound' && watcherFailed.has(tool)) ? 'inactive' : 'unavailable';
        console.log(`  ${color}${tool}${C.reset}${pad} binding: ${bsColor}${bs}${level}${C.reset}  automation: ${bsColor}${autoLabel}${watching}${C.reset}`);
      }
      return;
    }
    case 'debug': {
      const runJson = readRunJson();
      const bindings = loadBindings();
      const paneCaptures = parsed.full ? {
        claude: PANES.claude ? await capturePane(PANES.claude, 30) : null,
        codex: PANES.codex ? await capturePane(PANES.codex, 30) : null,
      } : null;
      const snapshot = collectDebugSnapshot({
        sessionState,
        routerState: getRouterState(),
        bindings,
        runJson,
        paneCaptures,
        full: parsed.full,
      });
      console.log(renderDebugReport(snapshot));
      return;
    }
    case 'send-debug': {
      const runJson = readRunJson();
      const bindings = loadBindings();
      const snapshot = collectDebugSnapshot({
        sessionState,
        routerState: getRouterState(),
        bindings,
        runJson,
        paneCaptures: null,
        full: false,
      });
      const report = renderDebugReport(snapshot);
      const header = 'The operator is sending you a live debug snapshot of the current Duet session. Please review it and help diagnose any issues.';
      const noteBlock = parsed.note ? `\nOperator note: ${parsed.note}\n` : '';
      const msg = `${header}${noteBlock}\n${report}`;
      if (!PANES[parsed.target]) {
        console.log(`${C.red}No pane configured for ${parsed.target}${C.reset}`);
        return;
      }
      if (await pasteToPane(PANES[parsed.target], msg)) {
        console.log(`${C.blue}Debug snapshot sent to ${parsed.target}${C.reset}`);
      } else {
        console.log(`${C.red}Failed to send debug snapshot to ${parsed.target}${C.reset}`);
      }
      return;
    }
    case 'send-debug-error':
      console.log(`Usage: /send-debug claude|codex [optional note]`);
      return;
    case 'rebind': {
      if (parsed.target !== 'claude' && parsed.target !== 'codex') {
        console.log(`${C.red}Usage: /rebind claude|codex${C.reset}`);
        return;
      }
      const tool = parsed.target as ToolName;
      const candidate = findRebindCandidate(tool);
      if (!candidate) {
        console.log(`${C.red}No rebind candidate found for ${tool} — current binding unchanged${C.reset}`);
        return;
      }
      const { oldPath, newPath, newSid } = await rebindTool(tool, candidate);
      console.log(`${C.green}Rebound ${tool}:${C.reset}`);
      console.log(`  ${C.dim}old: ${oldPath}${C.reset}`);
      console.log(`  ${C.green}new: ${newPath}${C.reset}`);
      if (newSid) console.log(`  ${C.green}session: ${newSid}${C.reset}`);
      return;
    }
    case 'converse': {
      // Resolve latest binding state
      for (const t of (['claude', 'codex'] as ToolName[])) resolveSessionPath(t);
      const cbs = bindingStatus('claude');
      const xbs = bindingStatus('codex');
      if (cbs !== 'bound' || xbs !== 'bound') {
        console.log(`${C.red}Cannot start conversation — both tools must be session-bound${C.reset}`);
        if (cbs !== 'bound') console.log(`  ${C.magenta}claude${C.reset}: ${C.red}${cbs}${C.reset}`);
        if (xbs !== 'bound') console.log(`  ${C.green}codex${C.reset}:  ${C.red}${xbs}${C.reset}`);
        return;
      }
      startPolling();
      console.log(`${C.cyan}Starting conversation: "${parsed.topic}" (${parsed.maxRounds} rounds)${C.reset}`);
      const opener = `Let's discuss with @codex: ${parsed.topic}`;
      if (await pasteToPane(PANES.claude, opener)) {
        setConverseState({
          turn: 'claude',
          rounds: 0,
          maxRounds: parsed.maxRounds,
          topic: parsed.topic,
        });
      } else {
        console.log(`${C.red}Failed to deliver opener to claude — conversation not started${C.reset}`);
      }
      return;
    }
    case 'focus':
      if (PANES[parsed.target]) {
        await focusPane(PANES[parsed.target]);
        console.log(`${C.dim}Focused ${parsed.target}. Click the bottom pane or Ctrl-B ; to return.${C.reset}`);
      } else {
        console.log(`${C.red}Unknown target. Use: claude, codex${C.reset}`);
      }
      return;
    case 'snap':
      if (PANES[parsed.target]) {
        const output = await capturePane(PANES[parsed.target] as string, parsed.lines);
        console.log(`${C.yellow}-- ${parsed.target} (last ${parsed.lines} lines) --${C.reset}`);
        console.log(output);
        console.log(`${C.yellow}-- end --${C.reset}`);
      } else {
        console.log(`${C.red}Unknown target. Use: claude, codex${C.reset}`);
      }
      return;
    case 'relay': {
      const fromBs = bindingStatus(parsed.from as ToolName);
      if (fromBs !== 'bound') {
        console.log(`${C.red}Cannot relay — ${parsed.from} is not session-bound (${fromBs})${C.reset}`);
        return;
      }
      const response = getSessionResponse(parsed.from as ToolName);
      if (!response) {
        console.log(`${C.red}No structured response available from ${parsed.from} — nothing to relay${C.reset}`);
        return;
      }
      const msg = parsed.prompt
        ? `${parsed.prompt.trim()}\n\n${parsed.from} says:\n${response}`
        : `${parsed.from} says:\n${response}`;
      if (await pasteToPane(PANES[parsed.to], msg)) {
        console.log(`${C.blue}Relayed ${parsed.from} -> ${parsed.to}${C.reset}`);
      } else {
        console.log(`${C.red}Failed to relay to ${parsed.to}${C.reset}`);
      }
      return;
    }
    case 'relay_error':
      console.log(`Usage: @relay claude>codex [optional prompt]`);
      return;
    case 'both': {
      const [cOk, xOk] = await Promise.all([
        sendKeys(PANES.claude, parsed.msg),
        sendKeys(PANES.codex, parsed.msg),
      ]);
      if (cOk && xOk) {
        console.log(`${C.yellow}-> both${C.reset}`);
      } else {
        const failed = [!cOk && 'claude', !xOk && 'codex'].filter(Boolean).join(', ');
        console.log(`${C.red}Failed to send to ${failed}${C.reset}`);
      }
      return;
    }
    case 'claude':
      if (await sendKeys(PANES.claude, parsed.msg)) {
        console.log(`${C.magenta}-> claude${C.reset}`);
      } else {
        console.log(`${C.red}Failed to send to claude${C.reset}`);
      }
      return;
    case 'codex':
      if (await sendKeys(PANES.codex, parsed.msg)) {
        console.log(`${C.green}-> codex${C.reset}`);
      } else {
        console.log(`${C.red}Failed to send to codex${C.reset}`);
      }
      return;
    case 'unknown_command':
      console.log(`${C.dim}Unknown command. /help for usage.${C.reset}`);
      return;
    case 'no_target':
      console.log(`${C.dim}Prefix with @claude, @codex, or @both. /help for commands.${C.reset}`);
      return;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function main(): void {
  const DUET_MODE = process.env.DUET_MODE || 'new';

  // Register the output handler callback with state module
  setNewOutputHandler(handleNewOutput);

  const rlInstance = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}${C.bold}duet>${C.reset} `,
    historySize: 200,
  });
  setRl(rlInstance);

  printBanner();

  if (DUET_MODE === 'resumed') {
    console.log(`${C.green}Resumed session — reader initialized at EOF to skip history${C.reset}`);
  } else if (DUET_MODE === 'forked') {
    console.log(`${C.green}Forked session${C.reset}`);
  }

  startPolling();

  for (const tool of (['claude', 'codex'] as ToolName[])) {
    const bs = bindingStatus(tool);
    const st = sessionState[tool];
    const level = st.bindingLevel ? ` [${st.bindingLevel}]` : '';
    if (bs === 'bound' && watcherFailed.has(tool)) {
      console.log(`${C.red}${tool}: session-bound but watcher failed — automation inactive${C.reset}`);
    } else if (bs === 'bound') {
      console.log(`${C.green}${tool}: session-bound — automation active${level}${C.reset}`);
    } else if (bs === 'pending') {
      console.log(`${C.yellow}${tool}: binding pending — automation will start when bound${C.reset}`);
    } else {
      console.log(`${C.red}${tool}: binding degraded — automation unavailable${C.reset}`);
    }
  }
  console.log(`${C.cyan}Watching for @mentions — tools can talk to each other${C.reset}\n`);

  rlInstance.prompt();

  rlInstance.on('line', (line) => {
    handleInput(line.trim()).then(() => rlInstance.prompt());
  });

  rlInstance.on('close', () => {
    stopPolling();
    process.exit(0);
  });
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

// When run directly (not imported via router.mjs), auto-invoke main().
// This enables the dist path: node dist/router/controller.js
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/controller.mjs') ||
  process.argv[1].endsWith('/controller.ts') ||
  process.argv[1].endsWith('/controller.js') ||
  process.argv[1].endsWith('\\controller.mjs') ||
  process.argv[1].endsWith('\\controller.ts') ||
  process.argv[1].endsWith('\\controller.js')
);

if (isMain) main();

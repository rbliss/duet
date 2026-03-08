#!/usr/bin/env node
/**
 * CLI entry point for run operations called by duet.sh.
 * Each subcommand outputs JSON to stdout for shell consumption.
 *
 * Usage:
 *   node run-ops.mjs find-active <cwd>
 *   node run-ops.mjs resolve-run <ref>
 *   node run-ops.mjs write-run-json <path> <key1> <val1> [<key2> <val2> ...]
 *   node run-ops.mjs read-fields <path> <key1> [<key2> ...]
 *   node run-ops.mjs update-workspace <cwd> <run-id> <active>
 *   node run-ops.mjs build-prompt <tool> <workdir> <output> <duet-md-path>
 *   node run-ops.mjs list-runs
 *   node run-ops.mjs destroy-run <run-id>
 */

import {
  cwdHash,
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

const DUET_BASE = process.env.DUET_BASE || `${process.env.HOME || ''}/.local/state/duet`;
const RUNS_DIR = `${DUET_BASE}/runs`;
const WORKSPACES_DIR = `${DUET_BASE}/workspaces`;

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'find-active': {
    const cwd = args[0];
    const runId = findActiveRun(cwd, RUNS_DIR, WORKSPACES_DIR);
    process.stdout.write(JSON.stringify({ runId: runId || '' }) + '\n');
    break;
  }

  case 'resolve-run': {
    const ref = args[0] || 'last';
    const result = resolveRunId(ref, RUNS_DIR);
    process.stdout.write(JSON.stringify(result) + '\n');
    break;
  }

  case 'write-run-json': {
    const path = args[0];
    /** @type {Record<string, string>} */
    const kvPairs = {};
    for (let i = 1; i < args.length; i += 2) {
      kvPairs[args[i]] = args[i + 1] || '';
    }
    writeRunJson(path, kvPairs);
    break;
  }

  case 'read-fields': {
    const path = args[0];
    /** @type {Record<string, string>} */
    const result = {};
    for (let i = 1; i < args.length; i++) {
      result[args[i]] = readRunField(path, args[i]);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    break;
  }

  case 'update-workspace': {
    const [cwd, runId, active] = args;
    updateWorkspaceIndex(cwd, runId, active, WORKSPACES_DIR);
    break;
  }

  case 'build-prompt': {
    const [tool, workdir, output, duetMdPath] = args;
    buildToolPrompt(tool, workdir, output, duetMdPath);
    break;
  }

  case 'list-runs': {
    const progName = args[0] || 'duet.sh';
    process.stdout.write(listRuns(RUNS_DIR, progName));
    break;
  }

  case 'destroy-run': {
    const runId = args[0];
    if (!runId) {
      process.stderr.write('Error: run-id required\n');
      process.exit(1);
    }
    const { error } = resolveRunId(runId, RUNS_DIR);
    if (error) {
      process.stderr.write(`Error: ${error}\n`);
      process.exit(1);
    }
    const resolved = resolveRunId(runId, RUNS_DIR);
    if (!resolved.runId) {
      process.stderr.write('Error: no run found to destroy\n');
      process.exit(1);
    }
    destroyRun(resolved.runId, RUNS_DIR, WORKSPACES_DIR, process.env.DUET_TMUX_SOCKET);
    process.stdout.write(`Destroyed run ${resolved.runId.slice(0, 8)}\n`);
    break;
  }

  case 'now-iso': {
    process.stdout.write(nowIso() + '\n');
    break;
  }

  case 'cwd-hash': {
    process.stdout.write(cwdHash(args[0]) + '\n');
    break;
  }

  default:
    process.stderr.write(`Unknown command: ${cmd}\nUsage: node run-ops.mjs <command> [args...]\n`);
    process.exit(1);
}

#!/usr/bin/env node
/**
 * Duet CLI entry point.
 * Replaces the launcher logic formerly in duet.sh.
 */

import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const DUET_DIR = resolve(dirname(__filename), '../..');

// Make DUET_DIR available to commands
process.env.DUET_DIR = DUET_DIR;

// Preflight checks
for (const cmd of ['tmux', 'claude', 'codex', 'node']) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
  } catch {
    console.error(`Error: ${cmd} is not installed or not in PATH`);
    process.exit(1);
  }
}

// Lazy import to avoid loading all modules before preflight
const { cmdNew, cmdResume, cmdFork, cmdList, cmdDestroy } = await import('../launcher/commands.mjs');

const [subcommand, ...rest] = process.argv.slice(2);

switch (subcommand) {
  case 'resume':
    cmdResume(rest[0] || 'last');
    break;
  case 'fork':
    cmdFork(rest[0] || 'last');
    break;
  case 'list':
    cmdList('duet');
    break;
  case 'destroy':
    if (!rest[0]) {
      console.error('Usage: duet destroy <run-id>');
      process.exit(1);
    }
    cmdDestroy(rest[0]);
    break;
  default:
    cmdNew(subcommand || process.cwd());
    break;
}

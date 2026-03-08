/**
 * Resolve internal entrypoint paths for source vs dist mode.
 *
 * Production default: runs from dist/ (built output).
 * Dev override: DUET_USE_SOURCE=1 runs from src/ with tsx loader.
 *
 * Mode is auto-detected from __dirname — if this module is loaded from
 * dist/, paths point at built output and nodeArgs is empty. If loaded
 * from src/, paths point at the source tree and nodeArgs includes tsx.
 */

import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const isDist: boolean = __dirname.includes(`${sep}dist${sep}`) || __dirname.endsWith(`${sep}dist`);

const root = resolve(__dirname, '../..');

/** Absolute paths to internal entrypoints. */
export const entryPaths = Object.freeze({
  /** CLI entry point. */
  cli:         isDist ? join(root, 'dist/cli/duet.js')             : join(root, 'src/cli/duet.ts'),
  /** Router entry point. */
  router:      isDist ? join(root, 'dist/router/controller.js')    : join(root, 'router.mjs'),
  /** Binding reconciler entry point. */
  reconciler:  isDist ? join(root, 'dist/bindings/reconciler.js')  : join(root, 'src/bindings/reconciler.ts'),
  /** Project root directory. */
  root,
});

/**
 * Extra node arguments for spawning child processes.
 * In source mode, includes the tsx ESM loader for .ts resolution.
 */
export const nodeArgs: readonly string[] = Object.freeze(isDist ? [] : ['--import', 'tsx/esm']);

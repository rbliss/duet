/**
 * Resolve internal entrypoint paths for source vs dist mode.
 *
 * When running from source (src/), paths point at the source tree and
 * nodeArgs includes the tsx loader for .ts resolution.
 * When running from dist/, paths point at built output and nodeArgs is empty.
 */

import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {boolean} */
export const isDist = __dirname.includes(`${sep}dist${sep}`) || __dirname.endsWith(`${sep}dist`);

const root = resolve(__dirname, '../..');

/** Absolute paths to internal entrypoints. */
export const entryPaths = Object.freeze({
  /** CLI entry point. */
  cli:         isDist ? join(root, 'dist/cli/duet.mjs')             : join(root, 'src/cli/duet.mjs'),
  /** Router entry point (.mjs source → .mjs dist). */
  router:      isDist ? join(root, 'dist/router/controller.mjs')    : join(root, 'router.mjs'),
  /** Binding reconciler entry point. */
  reconciler:  isDist ? join(root, 'dist/bindings/reconciler.mjs')  : join(root, 'src/bindings/reconciler.mjs'),
  /** Project root directory. */
  root,
});

/**
 * Extra node arguments for spawning child processes.
 * In source mode, includes the tsx ESM loader for .ts resolution.
 * @type {readonly string[]}
 */
export const nodeArgs = Object.freeze(isDist ? [] : ['--import', 'tsx/esm']);

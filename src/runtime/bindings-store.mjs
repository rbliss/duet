/**
 * @typedef {import('../types/runtime.js').BindingsManifest} BindingsManifest
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** @type {string | null} */
export let STATE_DIR = process.env.DUET_STATE_DIR || null;

/** @type {BindingsManifest | null} */
let bindingsCache = null;

/**
 * @param {string} dir
 */
export function setStateDir(dir) { STATE_DIR = dir; bindingsCache = null; }

/**
 * @returns {BindingsManifest | null}
 */
function loadBindings() {
  if (bindingsCache !== null) {
    // Re-read if any tool is still pending (binder may have updated it)
    const hasPending = ['claude', 'codex'].some(t =>
      bindingsCache !== null && bindingsCache[/** @type {'claude' | 'codex'} */ (t)]?.status === 'pending');
    if (!hasPending) return bindingsCache;
    bindingsCache = null;
  }
  if (!STATE_DIR) return null;
  const manifestPath = join(STATE_DIR, 'bindings.json');
  try {
    if (existsSync(manifestPath)) {
      bindingsCache = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return bindingsCache;
    }
  } catch {}
  return null;
}

export { loadBindings };

/**
 * CODEX_HOME overlay setup.
 * Ported from lib/codex-home.sh.
 */

import { mkdirSync, existsSync, symlinkSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

const CONFIG_FILES = ['auth.json', 'config.toml', 'version.json'];
const CONFIG_DIRS = ['rules', 'skills'];

/**
 * Force-create a symlink (unlink + symlink for ln -sf parity).
 * @param {string} target
 * @param {string} linkPath
 */
function forceSymlink(target, linkPath) {
  try { unlinkSync(linkPath); } catch {}
  symlinkSync(target, linkPath);
}

/**
 * Set up a CODEX_HOME overlay with read-only config symlinks.
 * @param {string} codexHome - Path to the isolated CODEX_HOME directory
 * @param {string} [homeDir] - Override HOME for testing (defaults to process.env.HOME)
 */
export function setupCodexHome(codexHome, homeDir) {
  const home = homeDir || process.env.HOME || '';
  const codexDir = join(home, '.codex');

  mkdirSync(join(codexHome, 'sessions'), { recursive: true });

  for (const f of CONFIG_FILES) {
    const src = join(codexDir, f);
    if (existsSync(src)) {
      forceSymlink(src, join(codexHome, f));
    }
  }

  for (const d of CONFIG_DIRS) {
    const src = join(codexDir, d);
    if (existsSync(src) && statSync(src).isDirectory()) {
      forceSymlink(src, join(codexHome, d));
    }
  }
}

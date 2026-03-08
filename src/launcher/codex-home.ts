/**
 * CODEX_HOME overlay setup.
 * Ported from lib/codex-home.sh.
 */

import { mkdirSync, existsSync, symlinkSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

const CONFIG_FILES = ['auth.json', 'config.toml', 'version.json'];
const CONFIG_DIRS = ['rules', 'skills'];

function forceSymlink(target: string, linkPath: string): void {
  try { unlinkSync(linkPath); } catch {}
  symlinkSync(target, linkPath);
}

export function setupCodexHome(codexHome: string, homeDir?: string): void {
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

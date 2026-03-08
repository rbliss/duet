import type { BindingsManifest } from '../types/runtime.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export let STATE_DIR: string | null = process.env.DUET_STATE_DIR || null;

let bindingsCache: BindingsManifest | null = null;

export function setStateDir(dir: string): void { STATE_DIR = dir; bindingsCache = null; }

function loadBindings(): BindingsManifest | null {
  if (bindingsCache !== null) {
    // Re-read if any tool is still pending (binder may have updated it)
    const hasPending = (['claude', 'codex'] as const).some(t =>
      bindingsCache !== null && bindingsCache[t]?.status === 'pending');
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

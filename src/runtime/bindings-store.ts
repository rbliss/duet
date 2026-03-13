import type { BindingsManifest, BindingEntry, ToolName } from '../types/runtime.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
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

/**
 * Update a single tool's binding entry in bindings.json.
 * Used by late discovery to persist the binding so it survives restarts.
 */
export function updateBinding(tool: ToolName, entry: BindingEntry): void {
  if (!STATE_DIR) return;
  const manifestPath = join(STATE_DIR, 'bindings.json');
  let manifest: BindingsManifest | null = null;
  try {
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    }
  } catch {}
  if (!manifest) return;
  manifest[tool] = entry;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  bindingsCache = manifest;
}

export { loadBindings };

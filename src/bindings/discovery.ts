/**
 * Shared session discovery helpers.
 * Used by both the binding reconciler (background process) and
 * the router (for late discovery of pending tools).
 */

import { readdirSync } from 'fs';
import { join, basename } from 'path';

/**
 * Recursively find all .jsonl files under a directory.
 */
export function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  walkDir(dir, results);
  return results;
}

function walkDir(dir: string, results: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
}

/**
 * Find a Claude session file by UUID in the projects directory tree.
 */
export function discoverClaudeSession(claudeSessionId: string, claudeProjects: string): string | null {
  const target = `${claudeSessionId}.jsonl`;
  return findJsonlFiles(claudeProjects).find(f => basename(f) === target) || null;
}

/**
 * Find a Codex session file in an isolated sessions directory.
 * Returns the first .jsonl found (isolation guarantees it belongs to this run).
 */
export function discoverCodexSession(codexSessions: string): string | null {
  const files = findJsonlFiles(codexSessions);
  return files.length > 0 ? files[0] : null;
}

/**
 * Workspace and run management helpers.
 * Ported from duet.sh's bash+python utilities.
 */

import type { ResolveRunResult, WorkspaceIndex, RunListEntry } from '../types/runtime.js';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

// ─── cwdHash ─────────────────────────────────────────────────────────────────
// Matches: echo -n "$1" | md5sum | cut -d' ' -f1

export function cwdHash(cwd: string): string {
  return createHash('md5').update(cwd).digest('hex');
}

// ─── nowIso ──────────────────────────────────────────────────────────────────
// Matches: date -u +%Y-%m-%dT%H:%M:%SZ

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─── readRunField ────────────────────────────────────────────────────────────
// Matches: run_field() in duet.sh — reads a dotted key from run.json.
// Returns empty string for null, missing, or dict values.

export function readRunField(runJsonPath: string, key: string): string {
  try {
    const data = JSON.parse(readFileSync(runJsonPath, 'utf8'));
    const val = key.split('.').reduce(
      (obj: unknown, k: string): unknown => (obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>)[k] : undefined),
      data
    );
    if (val === undefined || val === null) return '';
    if (typeof val === 'object') return '';
    return String(val);
  } catch {
    return '';
  }
}

// ─── writeRunJson ────────────────────────────────────────────────────────────
// Matches: write_run_json() in duet.sh — merges key-value pairs into a JSON file.
// Empty string values are stored as null (matching the Python behavior).

export function writeRunJson(path: string, kvPairs: Record<string, string>): void {
  let data: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      data = JSON.parse(readFileSync(path, 'utf8'));
    }
  } catch {}
  for (const [key, val] of Object.entries(kvPairs)) {
    const normalized = val === '' ? null : val;
    if (key.includes('.')) {
      const [parent, child] = key.split('.', 2);
      if (!data[parent] || typeof data[parent] !== 'object') data[parent] = {};
      (data[parent] as Record<string, unknown>)[child] = normalized;
    } else {
      data[key] = normalized;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ─── findActiveRun ───────────────────────────────────────────────────────────
// Matches: find_active_run() in duet.sh — finds the active run for a workspace.

export function findActiveRun(cwd: string, runsDir: string, workspacesDir: string): string | null {
  const hash = cwdHash(cwd);
  const idxPath = join(workspacesDir, `${hash}.json`);
  if (!existsSync(idxPath)) return null;

  try {
    const idx: WorkspaceIndex = JSON.parse(readFileSync(idxPath, 'utf8'));
    const runId = idx.active;
    if (!runId) return null;

    const runJson = join(runsDir, runId, 'run.json');
    if (!existsSync(runJson)) return null;

    const status = readRunField(runJson, 'status');
    if (status !== 'active') return null;

    return runId;
  } catch {
    return null;
  }
}

// ─── updateWorkspaceIndex ────────────────────────────────────────────────────
// Matches: update_workspace_index() in duet.sh.

export function updateWorkspaceIndex(cwd: string, runId: string, active: boolean | string, workspacesDir: string): void {
  const hash = cwdHash(cwd);
  mkdirSync(workspacesDir, { recursive: true });
  const idxPath = join(workspacesDir, `${hash}.json`);

  let data: WorkspaceIndex = { cwd, runs: [], active: null };
  try {
    if (existsSync(idxPath)) {
      data = JSON.parse(readFileSync(idxPath, 'utf8'));
    }
  } catch {}

  if (!data.runs) data.runs = [];
  if (!data.runs.includes(runId)) {
    data.runs.push(runId);
  }

  if (active === true || active === 'true') {
    data.active = runId;
  } else if ((active === 'clear') && data.active === runId) {
    data.active = null;
  }

  writeFileSync(idxPath, JSON.stringify(data, null, 2));
}

// ─── resolveRunId ────────────────────────────────────────────────────────────
// Matches: resolve_run_id() in duet.sh.
// Returns { runId, error } — error is set on ambiguous prefix.

export function resolveRunId(ref: string | null | undefined, runsDir: string): ResolveRunResult {
  if (!ref || ref === 'last') {
    let latest: string | null = null;
    let latestTime = '';
    try {
      for (const entry of readdirSync(runsDir)) {
        const rj = join(runsDir, entry, 'run.json');
        if (!existsSync(rj)) continue;
        const t = readRunField(rj, 'updated_at');
        if (!latestTime || t > latestTime) {
          latestTime = t;
          latest = readRunField(rj, 'run_id') || entry;
        }
      }
    } catch {}
    return { runId: latest || '', error: null };
  }

  // Exact match
  if (existsSync(join(runsDir, ref, 'run.json'))) {
    return { runId: ref, error: null };
  }

  // Prefix match — require exactly one result
  const matches: string[] = [];
  try {
    for (const entry of readdirSync(runsDir)) {
      if (entry.startsWith(ref) && existsSync(join(runsDir, entry, 'run.json'))) {
        matches.push(entry);
      }
    }
  } catch {}

  if (matches.length === 1) {
    return { runId: matches[0], error: null };
  }
  if (matches.length > 1) {
    return {
      runId: '',
      error: `ambiguous prefix '${ref}' matches ${matches.length} runs: ${matches.map(m => m.slice(0, 8)).join(', ')}`,
    };
  }
  return { runId: '', error: null };
}

// ─── buildToolPrompt ─────────────────────────────────────────────────────────
// Matches: build_tool_prompt() in duet.sh.

export function buildToolPrompt(tool: string, workdir: string, outputPath: string, duetMdPath: string): void {
  const duetMd = readFileSync(duetMdPath, 'utf8');
  let content = duetMd;

  const roleFile = tool === 'claude'
    ? join(workdir, 'CLAUDE_ROLE.md')
    : join(workdir, 'CODEX_ROLE.md');

  if (existsSync(roleFile)) {
    const displayName = tool === 'claude' ? 'Claude' : 'Codex';
    const roleBasename = tool === 'claude' ? 'CLAUDE_ROLE.md' : 'CODEX_ROLE.md';
    const roleContent = readFileSync(roleFile, 'utf8');
    content += `\n\n## Project-specific ${displayName} role\n\nThe following instructions come from \`${roleBasename}\` in the project root.\n\n${roleContent}`;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
}

// ─── getCodexTitle ───────────────────────────────────────────────────────────
// Extract conversation title from Codex SQLite, with fallbacks.
// Uses python3 for the SQLite query (avoids native module dependency).

export function getCodexTitle(codexHome: string | null | undefined, codexSid: string | null | undefined): string | null {
  if (!codexHome || !codexSid) return null;
  const dbPath = join(codexHome, 'state_5.sqlite');
  if (!existsSync(dbPath)) return null;
  try {
    const result = execSync(
      `python3 -c "
import sqlite3, sys, json
db = sqlite3.connect(sys.argv[1])
cur = db.cursor()
cur.execute('SELECT title, first_user_message FROM threads WHERE id = ?', (sys.argv[2],))
row = cur.fetchone()
db.close()
if row:
    print(json.dumps(row[0] or row[1] or None))
else:
    print('null')
" ${JSON.stringify(dbPath)} ${JSON.stringify(codexSid)}`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const title = JSON.parse(result);
    if (!title) return null;
    const MAX_TITLE = 72;
    return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE - 1) + '\u2026' : title;
  } catch {
    return null;
  }
}

// ─── listRuns ────────────────────────────────────────────────────────────────
// Matches: cmd_list() inline Python in duet.sh.
// Returns formatted string output.

export function listRuns(runsDir: string, progName: string): string {
  const runs: RunListEntry[] = [];
  try {
    for (const entry of readdirSync(runsDir)) {
      const rj = join(runsDir, entry, 'run.json');
      if (!existsSync(rj)) continue;
      try {
        const data: Record<string, unknown> = JSON.parse(readFileSync(rj, 'utf8'));
        const rid = (data.run_id as string) || entry;
        const claude = (data.claude as Record<string, string>) || {};
        const codex = (data.codex as Record<string, string>) || {};
        const cSid = claude.session_id || '';
        const xSid = codex.session_id || '';
        const status = (data.status as string) || '?';
        const title = getCodexTitle(data.codex_home as string, xSid);
        runs.push({
          rid,
          short: rid.slice(0, 8),
          status,
          mode: (data.mode as string) || '?',
          cwd: (data.cwd as string) || '?',
          updated: (data.updated_at as string) || '?',
          claude: cSid ? cSid.slice(0, 8) + '\u2026' : 'missing',
          codex: xSid ? xSid.slice(0, 8) + '\u2026' : 'missing',
          tmux: (data.tmux_session as string) || '',
          title,
          resumable: status === 'stopped' || status === 'detached',
        });
      } catch {}
    }
  } catch {}

  // Active runs first, then most-recently-updated first within each group
  const active = runs.filter(r => r.status === 'active')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const rest = runs.filter(r => r.status !== 'active')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const sorted = [...active, ...rest];

  const lines = ['DUET RUNS', '========='];

  if (sorted.length === 0) {
    lines.push('  (no runs found)');
    return lines.join('\n') + '\n';
  }

  for (const run of sorted) {
    lines.push('');
    lines.push(`${run.short}  ${run.status}  ${run.mode}`);
    if (run.title) {
      lines.push(`  title:   ${run.title}`);
    }
    lines.push(`  cwd:     ${run.cwd}`);
    lines.push(`  updated: ${run.updated}`);
    lines.push(`  claude:  ${run.claude}   codex: ${run.codex}`);
    if (run.tmux) {
      lines.push(`  tmux:    ${run.tmux}`);
    }
    if (run.resumable) {
      lines.push(`  resume:  ${progName} resume ${run.short}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ─── destroyRun ──────────────────────────────────────────────────────────────
// Matches: cmd_destroy() in duet.sh.

export function destroyRun(runId: string, runsDir: string, workspacesDir: string, tmuxSocket: string | null | undefined): void {
  const runDir = join(runsDir, runId);
  const runJson = join(runDir, 'run.json');

  if (existsSync(runJson)) {
    const tmuxSession = readRunField(runJson, 'tmux_session');
    const cwd = readRunField(runJson, 'cwd');

    if (tmuxSession) {
      try {
        const tmuxCmd = tmuxSocket
          ? `tmux -S ${JSON.stringify(tmuxSocket)} kill-session -t ${JSON.stringify(tmuxSession)}`
          : `tmux kill-session -t ${JSON.stringify(tmuxSession)}`;
        execSync(tmuxCmd, { stdio: 'ignore' });
      } catch {}
    }

    if (cwd) {
      updateWorkspaceIndex(cwd, runId, 'clear', workspacesDir);
    }
  }

  rmSync(runDir, { recursive: true, force: true });
}

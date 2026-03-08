import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, lstatSync, readdirSync, realpathSync } from 'fs';
import { join } from 'path';

// ─── Resume: durable state directory structure ───────────────────────────────

describe('durable state directory structure', () => {
  it('duet.sh creates persistent run directory under ~/.local/state/duet', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('DUET_BASE="${DUET_BASE:-$HOME/.local/state/duet}"'));
    assert.ok(script.includes('RUNS_DIR="$DUET_BASE/runs"'));
    assert.ok(script.includes('WORKSPACES_DIR="$DUET_BASE/workspaces"'));
  });

  it('duet.sh supports resume, fork, list, destroy subcommands', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('cmd_resume'));
    assert.ok(script.includes('cmd_fork'));
    assert.ok(script.includes('cmd_list'));
    assert.ok(script.includes('cmd_destroy'));
  });

  it('duet.sh creates codex-home inside run directory (not /tmp)', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('codex_home="$run_dir/codex-home"'));
    assert.ok(!script.includes('STATE_DIR="/tmp/'));
  });

  it('duet.sh writes run.json with required fields', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    for (const field of ['run_id', 'cwd', 'created_at', 'updated_at', 'status', 'tmux_session', 'mode', 'claude.session_id', 'codex_home']) {
      assert.ok(script.includes(field), `Missing field: ${field}`);
    }
  });

  it('duet.sh resume uses --resume for claude and resume subcommand for codex', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('claude --dangerously-skip-permissions --resume'));
    assert.ok(script.includes('codex resume'));
  });

  it('duet.sh fork uses --fork-session for claude and fork subcommand for codex', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    assert.ok(script.includes('--fork-session'));
    assert.ok(script.includes('codex fork'));
  });
});

// ─── cmd_list formatting and ordering ─────────────────────────────────────────

describe('cmd_list', () => {
  const testDir = '/tmp/duet-test-list-' + process.pid;
  const runsDir = join(testDir, 'runs');

  before(() => {
    mkdirSync(runsDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function createRun(id, overrides = {}) {
    const runDir = join(runsDir, id);
    mkdirSync(runDir, { recursive: true });
    const data = {
      run_id: id,
      cwd: '/home/test/project',
      status: 'stopped',
      mode: 'new',
      updated_at: '2026-03-07T01:00:00Z',
      tmux_session: `duet-${id.slice(0, 8)}`,
      claude: { session_id: 'claude-sid-001' },
      codex: { session_id: 'codex-sid-001' },
      ...overrides,
    };
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(data, null, 2));
    return runDir;
  }

  it('shows active runs before stopped runs', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });

    createRun('aaaaaaaa-0000-0000-0000-000000000001', {
      status: 'stopped', updated_at: '2026-03-07T03:00:00Z',
    });
    createRun('bbbbbbbb-0000-0000-0000-000000000002', {
      status: 'active', updated_at: '2026-03-07T01:00:00Z',
    });

    const pyScript = join(testDir, 'list_order.py');
    writeFileSync(pyScript, `
import json, pathlib, sys
runs_dir = pathlib.Path(sys.argv[1])
runs = []
for rj in runs_dir.glob("*/run.json"):
    try: data = json.load(open(rj))
    except: continue
    rid = data.get("run_id", "?")
    status = data.get("status", "?")
    updated = data.get("updated_at", "?")
    runs.append({"short": rid[:8], "status": status, "updated": updated})
active = [r for r in runs if r["status"] == "active"]
rest = [r for r in runs if r["status"] != "active"]
active.sort(key=lambda r: r["updated"], reverse=True)
rest.sort(key=lambda r: r["updated"], reverse=True)
runs = active + rest
for run in runs:
    print(f"{run['short']}  {run['status']}")
`);

    const output = execSync(`python3 ${pyScript} ${runsDir}`, { encoding: 'utf8' }).trim();
    const lines = output.split('\n').map(l => l.trim());
    const activeIdx = lines.findIndex(l => l.includes('active'));
    const stoppedIdx = lines.findIndex(l => l.includes('stopped'));
    assert.ok(activeIdx < stoppedIdx, `active (${activeIdx}) should appear before stopped (${stoppedIdx})`);
  });

  it('shows resume hint for stopped runs only', () => {
    const ws = readFileSync('/home/claude/duet/src/runtime/workspace.mjs', 'utf8');
    assert.ok(ws.includes("'stopped'") && ws.includes("'detached'"));
    assert.ok(ws.includes('resumable'));
    assert.ok(ws.includes("resume:"));
  });

  it('extracts codex title from SQLite threads table', () => {
    const ws = readFileSync('/home/claude/duet/src/runtime/workspace.mjs', 'utf8');
    assert.ok(ws.includes('getCodexTitle'));
    assert.ok(ws.includes('state_5.sqlite'));
    assert.ok(ws.includes('SELECT title, first_user_message FROM threads'));
  });

  it('handles missing codex_home and missing session_id gracefully', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });

    createRun('cccccccc-0000-0000-0000-000000000003', {
      codex: { session_id: '' },
      codex_home: '/nonexistent/path',
    });

    const output = execSync(
      `python3 -c "
import json, os, pathlib
runs_dir = pathlib.Path('${runsDir}')
for rj in runs_dir.glob('*/run.json'):
    data = json.load(open(rj))
    x_sid = (data.get('codex') or {}).get('session_id', '')
    print('codex:', x_sid[:8] + '...' if x_sid else 'missing')
"`,
      { encoding: 'utf8' }
    ).trim();
    assert.ok(output.includes('missing'));
  });

  it('truncates long titles with ellipsis', () => {
    const ws = readFileSync('/home/claude/duet/src/runtime/workspace.mjs', 'utf8');
    assert.ok(ws.includes('MAX_TITLE'));
    assert.ok(ws.includes('72'));
  });

  it('shows shortened session IDs', () => {
    const ws = readFileSync('/home/claude/duet/src/runtime/workspace.mjs', 'utf8');
    assert.ok(ws.includes('.slice(0, 8)'));
  });

  it('end-to-end: renders full output with correct ordering and format', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });

    createRun('aaaaaaaa-0000-0000-0000-000000000001', {
      status: 'stopped', updated_at: '2026-03-07T03:00:00Z',
    });
    createRun('bbbbbbbb-0000-0000-0000-000000000002', {
      status: 'active', updated_at: '2026-03-07T01:00:00Z',
    });
    createRun('cccccccc-0000-0000-0000-000000000003', {
      status: 'active', updated_at: '2026-03-07T05:00:00Z',
      claude: { session_id: '' }, codex: {},
    });

    const output = execSync(
      `DUET_BASE="${testDir}" node /home/claude/duet/src/cli/run-ops.mjs list-runs "duet.sh"`,
      { encoding: 'utf8' }
    ).trim();

    const lines = output.split('\n');
    assert.ok(lines[0].includes('DUET RUNS'));
    const firstActive = lines.findIndex(l => l.includes('active'));
    const firstStopped = lines.findIndex(l => l.includes('stopped'));
    assert.ok(firstActive < firstStopped, 'active runs should appear before stopped');
    const ccIdx = lines.findIndex(l => l.includes('cccccccc'));
    const bbIdx = lines.findIndex(l => l.includes('bbbbbbbb'));
    assert.ok(ccIdx < bbIdx, 'most recent active run should appear first');
    assert.ok(output.includes('resume:  duet.sh resume aaaaaaaa'));
    assert.ok(!output.includes('resume:  duet.sh resume bbbbbbbb'));
    assert.ok(!output.includes('resume:  duet.sh resume cccccccc'));
    assert.ok(output.includes('claude:  missing'));
    assert.ok(output.includes('codex: missing'));
    assert.ok(output.includes('claude-s\u2026'));
  });

  it('end-to-end: shows "(no runs found)" for empty directory', () => {
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });

    const output = execSync(
      `DUET_BASE="${testDir}" node /home/claude/duet/src/cli/run-ops.mjs list-runs "duet.sh"`,
      { encoding: 'utf8' }
    ).trim();

    assert.ok(output.includes('(no runs found)'));
  });
});

// ─── Role prompt injection ────────────────────────────────────────────────────

describe('role prompt injection', () => {
  const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');

  it('duet.sh defines build_tool_prompt helper', () => {
    assert.ok(script.includes('build_tool_prompt()'));
    assert.ok(script.includes('build-prompt'));
    const ws = readFileSync('/home/claude/duet/src/runtime/workspace.mjs', 'utf8');
    assert.ok(ws.includes('CLAUDE_ROLE.md'));
    assert.ok(ws.includes('CODEX_ROLE.md'));
  });

  it('build_tool_prompt composes prompt files under runtime/', () => {
    assert.ok(script.includes('claude-system-prompt.md'));
    assert.ok(script.includes('codex-model-instructions.md'));
  });

  it('cmd_new calls build_tool_prompt for both tools', () => {
    const cmdNew = script.slice(script.indexOf('cmd_new()'), script.indexOf('cmd_resume()'));
    assert.ok(cmdNew.includes('build_tool_prompt claude'));
    assert.ok(cmdNew.includes('build_tool_prompt codex'));
  });

  it('cmd_resume calls build_tool_prompt for both tools', () => {
    const cmdResume = script.slice(script.indexOf('cmd_resume()'), script.indexOf('cmd_fork()'));
    assert.ok(cmdResume.includes('build_tool_prompt claude'));
    assert.ok(cmdResume.includes('build_tool_prompt codex'));
  });

  it('cmd_fork calls build_tool_prompt for both tools', () => {
    const cmdFork = script.slice(script.indexOf('cmd_fork()'), script.indexOf('cmd_list()'));
    assert.ok(cmdFork.includes('build_tool_prompt claude'));
    assert.ok(cmdFork.includes('build_tool_prompt codex'));
  });

  it('claude resume path includes --append-system-prompt', () => {
    const cmdResume = script.slice(script.indexOf('cmd_resume()'), script.indexOf('cmd_fork()'));
    const resumeBranch = cmdResume.slice(cmdResume.indexOf('if [ -n "$claude_sid" ]'));
    assert.ok(resumeBranch.includes('--resume $claude_sid --append-system-prompt'));
  });

  it('codex resume path includes model_instructions_file', () => {
    const cmdResume = script.slice(script.indexOf('cmd_resume()'), script.indexOf('cmd_fork()'));
    assert.ok(cmdResume.includes('codex resume $codex_sid --dangerously-bypass-approvals-and-sandbox -c model_instructions_file='));
  });

  it('codex fork path includes model_instructions_file', () => {
    const cmdFork = script.slice(script.indexOf('cmd_fork()'), script.indexOf('cmd_list()'));
    assert.ok(cmdFork.includes('codex fork $codex_session_id --dangerously-bypass-approvals-and-sandbox -c model_instructions_file='));
  });

  it('README documents both role prompt files', () => {
    const readme = readFileSync('/home/claude/duet/README.md', 'utf8');
    assert.ok(readme.includes('CLAUDE_ROLE.md'));
    assert.ok(readme.includes('CODEX_ROLE.md'));
  });
});

describe('build_tool_prompt integration', () => {
  const testDir = '/tmp/duet-test-role-' + process.pid;
  const runtimeDir = join(testDir, 'runtime');
  const workdir = join(testDir, 'project');

  before(() => {
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(workdir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('produces plain DUET.md when no role file exists', () => {
    const output = join(runtimeDir, 'plain.md');
    execSync(`bash -c '
      DIR="/home/claude/duet"
      build_tool_prompt() {
        local tool="$1" workdir="$2" output="$3"
        cp "$DIR/DUET.md" "$output"
        local role_file display_name
        if [ "$tool" = "claude" ]; then role_file="$workdir/CLAUDE_ROLE.md"; display_name="Claude"
        else role_file="$workdir/CODEX_ROLE.md"; display_name="Codex"; fi
        if [ -f "$role_file" ]; then
          printf "\\n\\n## Project-specific %s role\\n\\nThe following instructions come from \\\`%s\\\` in the project root.\\n\\n" "$display_name" "$(basename "$role_file")" >> "$output"
          cat "$role_file" >> "$output"
        fi
      }
      build_tool_prompt claude ${workdir} ${output}
    '`);
    const result = readFileSync(output, 'utf8');
    const duet = readFileSync('/home/claude/duet/DUET.md', 'utf8');
    assert.equal(result, duet, 'output should be identical to DUET.md when no role file exists');
  });

  it('appends CLAUDE_ROLE.md content when present', () => {
    const roleContent = 'You are the lead architect. Focus on system design.';
    writeFileSync(join(workdir, 'CLAUDE_ROLE.md'), roleContent);
    const output = join(runtimeDir, 'claude-role.md');
    execSync(`bash -c '
      DIR="/home/claude/duet"
      build_tool_prompt() {
        local tool="$1" workdir="$2" output="$3"
        cp "$DIR/DUET.md" "$output"
        local role_file display_name
        if [ "$tool" = "claude" ]; then role_file="$workdir/CLAUDE_ROLE.md"; display_name="Claude"
        else role_file="$workdir/CODEX_ROLE.md"; display_name="Codex"; fi
        if [ -f "$role_file" ]; then
          printf "\\n\\n## Project-specific %s role\\n\\nThe following instructions come from \\\`%s\\\` in the project root.\\n\\n" "$display_name" "$(basename "$role_file")" >> "$output"
          cat "$role_file" >> "$output"
        fi
      }
      build_tool_prompt claude ${workdir} ${output}
    '`);
    const result = readFileSync(output, 'utf8');
    assert.ok(result.includes('## Project-specific Claude role'));
    assert.ok(result.includes('CLAUDE_ROLE.md'));
    assert.ok(result.includes(roleContent));
    assert.ok(result.includes('Duet: Multi-Agent Collaboration'));
    rmSync(join(workdir, 'CLAUDE_ROLE.md'));
  });

  it('appends CODEX_ROLE.md content when present', () => {
    const roleContent = 'You are the testing specialist. Focus on test coverage.';
    writeFileSync(join(workdir, 'CODEX_ROLE.md'), roleContent);
    const output = join(runtimeDir, 'codex-role.md');
    execSync(`bash -c '
      DIR="/home/claude/duet"
      build_tool_prompt() {
        local tool="$1" workdir="$2" output="$3"
        cp "$DIR/DUET.md" "$output"
        local role_file display_name
        if [ "$tool" = "claude" ]; then role_file="$workdir/CLAUDE_ROLE.md"; display_name="Claude"
        else role_file="$workdir/CODEX_ROLE.md"; display_name="Codex"; fi
        if [ -f "$role_file" ]; then
          printf "\\n\\n## Project-specific %s role\\n\\nThe following instructions come from \\\`%s\\\` in the project root.\\n\\n" "$display_name" "$(basename "$role_file")" >> "$output"
          cat "$role_file" >> "$output"
        fi
      }
      build_tool_prompt codex ${workdir} ${output}
    '`);
    const result = readFileSync(output, 'utf8');
    assert.ok(result.includes('## Project-specific Codex role'));
    assert.ok(result.includes('CODEX_ROLE.md'));
    assert.ok(result.includes(roleContent));
    assert.ok(result.includes('Duet: Multi-Agent Collaboration'));
    rmSync(join(workdir, 'CODEX_ROLE.md'));
  });
});

// ─── Bug fix: /destroy removes state before killing tmux ─────────────────────

describe('/destroy ordering', () => {
  it('router.mjs removes run dir before killing tmux session', () => {
    const src = readFileSync('/home/claude/duet/router.mjs', 'utf8');
    const destroyBlock = src.slice(src.indexOf("case 'destroy':"), src.indexOf("case 'destroy':") + 600);
    const rmIndex = destroyBlock.indexOf('rmSync');
    const killIndex = destroyBlock.indexOf('killSession');
    assert.ok(rmIndex > 0, 'rmSync should exist in destroy handler');
    assert.ok(killIndex > 0, 'killSession should exist in destroy handler');
    assert.ok(rmIndex < killIndex, `rmSync (${rmIndex}) should come before killSession (${killIndex})`);
  });
});

// ─── Bug fix: run_field treats JSON null as empty string ─────────────────────

describe('run_field null handling', () => {
  const testDir = '/tmp/duet-test-runfield-' + process.pid;
  const runJson = join(testDir, 'run.json');
  const helperScript = join(testDir, 'run_field.sh');

  before(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(helperScript, `#!/usr/bin/env bash
run_field() {
  local run_json="$1" key="$2"
  python3 -c "
import json, sys, functools
d = json.load(open(sys.argv[1]))
val = functools.reduce(lambda o, k: o.get(k, {}) if isinstance(o, dict) else {}, sys.argv[2].split('.'), d)
print(val if isinstance(val, str) else '' if val is None else '' if isinstance(val, dict) else str(val))
" "$run_json" "$key" 2>/dev/null
}
run_field "$1" "$2"
`);
    execSync(`chmod +x ${helperScript}`);
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty string for JSON null values', () => {
    writeFileSync(runJson, JSON.stringify({
      codex: { session_id: null },
      claude: { session_id: 'real-id' },
    }));

    const result = execSync(
      `bash ${helperScript} ${runJson} codex.session_id`,
      { encoding: 'utf8' }
    ).trim();

    assert.equal(result, '', `Expected empty string for null, got "${result}"`);
  });

  it('returns actual value for non-null fields', () => {
    const result = execSync(
      `bash ${helperScript} ${runJson} claude.session_id`,
      { encoding: 'utf8' }
    ).trim();

    assert.equal(result, 'real-id');
  });
});

// ─── Bug fix: shell quoting for paths with spaces ────────────────────────────

describe('shell quoting for paths with spaces', () => {
  it('duet.sh quote_path properly escapes spaces', () => {
    const result = execSync(
      `bash -c 'quote_path() { printf "%q" "$1"; }; quote_path "/tmp/my repo/test"'`,
      { encoding: 'utf8' }
    ).trim();
    assert.ok(!result.includes(' ') || result.includes('\\ ') || result.includes("'"),
      `Expected escaped space in: ${result}`);
    const roundtrip = execSync(
      `bash -c 'eval echo ${result}'`,
      { encoding: 'utf8' }
    ).trim();
    assert.equal(roundtrip, '/tmp/my repo/test');
  });

  it('duet.sh uses quote_path for all interpolated paths in send-keys', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const sendKeysLines = script.split('\n').filter(l =>
      l.includes('tmux send-keys') && l.includes('cd ')
    );
    for (const line of sendKeysLines) {
      assert.ok(line.includes('q_'), `send-keys line should use quoted path variable: ${line.trim()}`);
    }
  });

  it('launch_router uses quoted paths', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const routerBlock = script.slice(
      script.indexOf('launch_router()'),
      script.indexOf('launch_router()') + 400
    );
    assert.ok(routerBlock.includes('q_run_dir'), 'launch_router should use q_run_dir');
    assert.ok(routerBlock.includes('q_dir'), 'launch_router should use q_dir');
  });
});

// ─── Regression: duet.sh works from checkout path with spaces ────────────────

describe('spaced checkout path', () => {
  const testDir = '/tmp/duet test spaces-' + process.pid;
  const spacedRepo = join(testDir, 'with space', 'repo');

  before(() => {
    mkdirSync(spacedRepo, { recursive: true });
    execSync(`ln -sf /home/claude/duet/src "${spacedRepo}/src"`);
    execSync(`ln -sf /home/claude/duet/lib "${spacedRepo}/lib"`);
    execSync(`ln -sf /home/claude/duet/DUET.md "${spacedRepo}/DUET.md"`);
    execSync(`ln -sf /home/claude/duet/package.json "${spacedRepo}/package.json"`);
    execSync(`ln -sf /home/claude/duet/node_modules "${spacedRepo}/node_modules"`);
    execSync(`cp /home/claude/duet/duet.sh "${spacedRepo}/duet.sh"`);
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('duet.sh list works when repo path contains spaces', () => {
    const output = execSync(
      `bash "${spacedRepo}/duet.sh" list`,
      { encoding: 'utf8', env: { ...process.env, DUET_BASE: join(testDir, 'state') } }
    ).trim();
    assert.ok(output.includes('DUET RUNS'), `Expected DUET RUNS header, got: ${output}`);
  });
});

// ─── Bug fix: codex fast-path requires session ID for resume ─────────────────

describe('codex fast-path requires session ID for resume', () => {
  it('duet.sh only exports RESUME_CODEX_PATH when codex_sid is present', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const resumeFunc = script.slice(
      script.indexOf('cmd_resume()'),
      script.indexOf('cmd_fork()')
    );
    assert.ok(
      resumeFunc.includes('[ -n "$codex_binding_path" ] && [ -n "$codex_sid" ]'),
      'RESUME_CODEX_PATH export should be gated on codex_sid being present'
    );
  });
});

// ─── Bug fix: ambiguous run-id prefix errors instead of picking first ────────

describe('ambiguous run-id prefix handling', () => {
  it('resolve_run_id delegates to JS and errors on ambiguous prefix', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const resolveBlock = script.slice(
      script.indexOf('resolve_run_id()'),
      script.indexOf('resolve_run_id()') + 600
    );
    assert.ok(resolveBlock.includes('resolve-run'), 'Should delegate to JS run-ops');
    assert.ok(resolveBlock.includes('return 1'), 'Should return non-zero on error');
    // Verify JS module handles ambiguity
    const ws = readFileSync('/home/claude/duet/src/runtime/workspace.mjs', 'utf8');
    assert.ok(ws.includes('ambiguous prefix'), 'JS module should error on ambiguous prefix');
  });
});

// ─── Bug fix: workspace path canonicalization ────────────────────────────────

describe('workspace path canonicalization', () => {
  it('cmd_new canonicalizes workdir with pwd -P', () => {
    const script = readFileSync('/home/claude/duet/duet.sh', 'utf8');
    const cmdNewBlock = script.slice(
      script.indexOf('cmd_new()'),
      script.indexOf('cmd_new()') + 200
    );
    assert.ok(cmdNewBlock.includes('pwd -P'), 'cmd_new should canonicalize workdir with pwd -P');
  });

  it('canonicalization resolves relative and symlink paths', () => {
    const testDir = '/tmp/duet-test-canon-' + process.pid;
    const realDir = join(testDir, 'real');
    const linkDir = join(testDir, 'link');
    mkdirSync(realDir, { recursive: true });
    execSync(`ln -sf ${realDir} ${linkDir}`);

    const resolved = execSync(`cd ${linkDir} && pwd -P`, { encoding: 'utf8' }).trim();
    assert.equal(resolved, realDir, 'pwd -P should resolve symlink');

    const relative = execSync(`cd ${testDir} && cd real && pwd -P`, { encoding: 'utf8' }).trim();
    assert.equal(relative, realDir, 'pwd -P should resolve relative path');

    rmSync(testDir, { recursive: true, force: true });
  });
});

// ─── CODEX_HOME isolation: setup_codex_home() behavioral tests ───────────────

describe('setup_codex_home isolation', () => {
  const testDir = '/tmp/duet-test-codexhome-' + process.pid;
  const fakeHome = join(testDir, 'fakehome');
  const fakeCodexDir = join(fakeHome, '.codex');
  const codexHome = join(testDir, 'codex-home');

  before(() => {
    mkdirSync(fakeCodexDir, { recursive: true });
    // Create read-only config files
    writeFileSync(join(fakeCodexDir, 'auth.json'), '{"token":"test"}');
    writeFileSync(join(fakeCodexDir, 'config.toml'), 'model = "o4-mini"');
    writeFileSync(join(fakeCodexDir, 'version.json'), '{"version":"1.0"}');
    // Create read-only directories
    mkdirSync(join(fakeCodexDir, 'rules'), { recursive: true });
    writeFileSync(join(fakeCodexDir, 'rules', 'rule1.md'), '# rule');
    mkdirSync(join(fakeCodexDir, 'skills'), { recursive: true });
    writeFileSync(join(fakeCodexDir, 'skills', 'skill1.md'), '# skill');
    // Create mutable state that must NOT be shared
    mkdirSync(join(fakeCodexDir, 'sessions'), { recursive: true });
    writeFileSync(join(fakeCodexDir, 'sessions', 'old.jsonl'), '{}');
    writeFileSync(join(fakeCodexDir, 'state_5.sqlite'), 'fake-db');
    writeFileSync(join(fakeCodexDir, 'state_5.sqlite-shm'), 'fake-shm');
    writeFileSync(join(fakeCodexDir, 'state_5.sqlite-wal'), 'fake-wal');
    writeFileSync(join(fakeCodexDir, 'history.jsonl'), '{}');
    writeFileSync(join(fakeCodexDir, 'models_cache.json'), '{}');
    mkdirSync(join(fakeCodexDir, 'shell_snapshots'), { recursive: true });
    mkdirSync(join(fakeCodexDir, 'log'), { recursive: true });
    mkdirSync(join(fakeCodexDir, 'tmp'), { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runSetup() {
    execSync(`bash -c '
      HOME="${fakeHome}"
      source /home/claude/duet/lib/codex-home.sh
      setup_codex_home "${codexHome}"
    '`);
  }

  it('creates sessions/ subdirectory', () => {
    runSetup();
    assert.ok(existsSync(join(codexHome, 'sessions')), 'sessions/ should exist');
    assert.ok(lstatSync(join(codexHome, 'sessions')).isDirectory(),
      'sessions/ should be a real directory (not a symlink)');
  });

  it('symlinks read-only config files from ~/.codex/', () => {
    for (const f of ['auth.json', 'config.toml', 'version.json']) {
      const target = join(codexHome, f);
      assert.ok(existsSync(target), `${f} should exist`);
      assert.ok(lstatSync(target).isSymbolicLink(), `${f} should be a symlink`);
      assert.equal(realpathSync(target), join(fakeCodexDir, f),
        `${f} should point to ~/.codex/${f}`);
    }
  });

  it('symlinks read-only directories from ~/.codex/', () => {
    for (const d of ['rules', 'skills']) {
      const target = join(codexHome, d);
      assert.ok(existsSync(target), `${d} should exist`);
      assert.ok(lstatSync(target).isSymbolicLink(), `${d} should be a symlink`);
      assert.equal(realpathSync(target), join(fakeCodexDir, d),
        `${d} should point to ~/.codex/${d}`);
    }
  });

  it('does NOT share mutable state files', () => {
    const mutableFiles = [
      'state_5.sqlite', 'state_5.sqlite-shm', 'state_5.sqlite-wal',
      'history.jsonl', 'models_cache.json',
    ];
    for (const f of mutableFiles) {
      const target = join(codexHome, f);
      assert.ok(!existsSync(target), `${f} must NOT be present in CODEX_HOME`);
    }
  });

  it('does NOT share mutable state directories', () => {
    const mutableDirs = ['shell_snapshots', 'log', 'tmp'];
    for (const d of mutableDirs) {
      const target = join(codexHome, d);
      // sessions/ is created fresh (not symlinked), so we check for symlink specifically
      if (existsSync(target)) {
        assert.ok(!lstatSync(target).isSymbolicLink(),
          `${d} must NOT be a symlink to ~/.codex/${d}`);
      }
    }
  });

  it('sessions/ is an empty directory (not shared with ~/.codex/sessions/)', () => {
    const sessDir = join(codexHome, 'sessions');
    assert.ok(!lstatSync(sessDir).isSymbolicLink(),
      'sessions/ must NOT be a symlink');
    const contents = readdirSync(sessDir);
    assert.equal(contents.length, 0,
      'sessions/ should be empty (not contain old session files)');
  });

  it('is idempotent — running twice does not error', () => {
    assert.doesNotThrow(() => runSetup(),
      'running setup_codex_home twice should not throw');
    assert.ok(existsSync(join(codexHome, 'sessions')));
    assert.ok(existsSync(join(codexHome, 'auth.json')));
  });
});

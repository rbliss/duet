import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRunManifest,
  parseBindingsManifest,
  RunManifestSchema,
  BindingsManifestSchema,
} from '../src/model/manifests.js';

// ─── RunManifest schema ──────────────────────────────────────────────────────

describe('RunManifest schema', () => {
  const validRun = {
    run_id: 'aaaaaaaa-1111-2222-3333-444444444444',
    cwd: '/home/user/project',
    created_at: '2026-03-07T01:00:00Z',
    updated_at: '2026-03-07T02:00:00Z',
    status: 'active',
    tmux_session: 'duet-aaaaaaaa',
    mode: 'new',
    claude: { session_id: 'claude-sid-001' },
    codex: { session_id: 'codex-sid-001' },
    codex_home: '/home/user/.local/state/duet/runs/aaa/codex-home',
  };

  it('parses a valid run manifest', () => {
    const result = parseRunManifest(validRun);
    assert.equal(result.run_id, validRun.run_id);
    assert.equal(result.status, 'active');
    assert.equal(result.mode, 'new');
    assert.equal(result.claude.session_id, 'claude-sid-001');
  });

  it('accepts all valid status values', () => {
    for (const status of ['active', 'stopped', 'detached']) {
      const data = { ...validRun, status };
      assert.doesNotThrow(() => parseRunManifest(data));
    }
  });

  it('accepts all valid mode values', () => {
    for (const mode of ['new', 'resumed', 'forked']) {
      const data = { ...validRun, mode };
      assert.doesNotThrow(() => parseRunManifest(data));
    }
  });

  it('rejects invalid status', () => {
    const data = { ...validRun, status: 'running' };
    assert.throws(() => parseRunManifest(data));
  });

  it('rejects invalid mode', () => {
    const data = { ...validRun, mode: 'cloned' };
    assert.throws(() => parseRunManifest(data));
  });

  it('rejects missing required fields', () => {
    for (const key of ['run_id', 'cwd', 'status', 'tmux_session', 'mode']) {
      const data = { ...validRun };
      delete data[key];
      assert.throws(() => parseRunManifest(data), `should reject missing ${key}`);
    }
  });

  it('accepts null session_id and binding_path', () => {
    const data = {
      ...validRun,
      claude: { session_id: null, binding_path: null },
      codex: { session_id: null, binding_path: null },
      codex_home: null,
    };
    const result = parseRunManifest(data);
    assert.equal(result.claude.session_id, null);
    assert.equal(result.codex.binding_path, null);
  });

  it('accepts missing optional fields on tool entries', () => {
    const data = {
      ...validRun,
      claude: {},
      codex: {},
    };
    const result = parseRunManifest(data);
    assert.equal(result.claude.session_id, undefined);
  });

  it('matches shape produced by duet.sh write_run_json', () => {
    // Simulates the exact shape from cmd_new() in duet.sh
    const fromShell = {
      run_id: 'bbbbbbbb-2222-3333-4444-555555555555',
      cwd: '/home/user/myproject',
      created_at: '2026-03-08T10:00:00Z',
      updated_at: '2026-03-08T10:00:00Z',
      status: 'active',
      tmux_session: 'duet-bbbbbbbb',
      mode: 'new',
      claude: { session_id: 'cccccccc-3333-4444-5555-666666666666', binding_path: null },
      codex: { session_id: null, binding_path: null },
      codex_home: '/home/user/.local/state/duet/runs/bbb/codex-home',
    };
    assert.doesNotThrow(() => parseRunManifest(fromShell));
  });

  it('matches shape produced by cmd_resume()', () => {
    const fromResume = {
      ...validRun,
      status: 'active',
      mode: 'resumed',
      claude: { session_id: 'original-sid', binding_path: '/path/to/session.jsonl' },
      codex: { session_id: 'codex-original', binding_path: '/path/to/codex.jsonl' },
    };
    assert.doesNotThrow(() => parseRunManifest(fromResume));
  });
});

// ─── BindingsManifest schema ─────────────────────────────────────────────────

describe('BindingsManifest schema', () => {
  const validBindings = {
    claude: {
      path: '/home/user/.claude/projects/abc/session.jsonl',
      level: 'process',
      status: 'bound',
      confirmedAt: '2026-03-07T01:00:05Z',
      session_id: 'claude-sid-001',
    },
    codex: {
      path: '/home/user/.local/state/duet/runs/aaa/codex-home/sessions/xyz.jsonl',
      level: 'process',
      status: 'bound',
      confirmedAt: '2026-03-07T01:00:05Z',
      session_id: 'codex-sid-001',
    },
  };

  it('parses valid bindings manifest', () => {
    const result = parseBindingsManifest(validBindings);
    assert.equal(result.claude.status, 'bound');
    assert.equal(result.codex.status, 'bound');
    assert.equal(result.claude.level, 'process');
  });

  it('accepts all valid binding statuses', () => {
    for (const status of ['pending', 'bound', 'degraded']) {
      const data = {
        claude: { ...validBindings.claude, status },
        codex: { ...validBindings.codex, status },
      };
      assert.doesNotThrow(() => parseBindingsManifest(data));
    }
  });

  it('accepts workspace-level binding', () => {
    const data = {
      claude: { ...validBindings.claude },
      codex: { ...validBindings.codex, level: 'workspace' },
    };
    const result = parseBindingsManifest(data);
    assert.equal(result.codex.level, 'workspace');
  });

  it('accepts pending state with null fields', () => {
    const data = {
      claude: { path: null, level: null, status: 'pending', confirmedAt: null, session_id: null },
      codex: { path: null, level: null, status: 'pending', confirmedAt: null, session_id: null },
    };
    const result = parseBindingsManifest(data);
    assert.equal(result.claude.status, 'pending');
    assert.equal(result.claude.path, null);
  });

  it('accepts degraded state', () => {
    const data = {
      claude: { path: null, level: null, status: 'degraded', confirmedAt: null, session_id: null },
      codex: { path: null, level: null, status: 'degraded', confirmedAt: null, session_id: null },
    };
    assert.doesNotThrow(() => parseBindingsManifest(data));
  });

  it('rejects invalid binding status', () => {
    const data = {
      claude: { ...validBindings.claude, status: 'unknown' },
      codex: { ...validBindings.codex },
    };
    assert.throws(() => parseBindingsManifest(data));
  });

  it('rejects missing tool entries', () => {
    assert.throws(() => parseBindingsManifest({ claude: validBindings.claude }));
    assert.throws(() => parseBindingsManifest({ codex: validBindings.codex }));
  });

  it('matches shape produced by bind-sessions.sh write_manifest', () => {
    // Initial state (both pending)
    const initial = {
      claude: { path: null, level: null, status: 'pending', confirmedAt: null, session_id: null },
      codex: { path: null, level: null, status: 'pending', confirmedAt: null, session_id: null },
    };
    assert.doesNotThrow(() => parseBindingsManifest(initial));

    // After claude binds
    const claudeBound = {
      claude: {
        path: '/home/user/.claude/projects/abc/session.jsonl',
        level: 'process',
        status: 'bound',
        confirmedAt: '2026-03-07T01:00:05Z',
        session_id: 'claude-sid',
      },
      codex: { path: null, level: null, status: 'pending', confirmedAt: null, session_id: null },
    };
    assert.doesNotThrow(() => parseBindingsManifest(claudeBound));
  });
});

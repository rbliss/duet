import { z } from 'zod';

// ─── Run manifest (run.json) ─────────────────────────────────────────────────

export const RunStatus = z.enum(['active', 'stopped', 'detached']);
export const RunMode = z.enum(['new', 'resumed', 'forked']);

export const ToolEntry = z.object({
  session_id: z.string().nullable().optional(),
  binding_path: z.string().nullable().optional(),
});

export const RunManifestSchema = z.object({
  run_id: z.string(),
  cwd: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  status: RunStatus,
  tmux_session: z.string(),
  mode: RunMode,
  claude: ToolEntry,
  codex: ToolEntry,
  codex_home: z.string().nullable().optional(),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;
export type RunStatusType = z.infer<typeof RunStatus>;
export type RunModeType = z.infer<typeof RunMode>;

export function parseRunManifest(data: unknown): RunManifest {
  return RunManifestSchema.parse(data);
}

// ─── Bindings manifest (bindings.json) ───────────────────────────────────────

export const BindingStatus = z.enum(['pending', 'bound', 'degraded']);
export const BindingLevel = z.enum(['process', 'workspace']).nullable().optional();

export const ToolBindingSchema = z.object({
  path: z.string().nullable().optional(),
  level: BindingLevel,
  status: BindingStatus,
  confirmedAt: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
});

export const BindingsManifestSchema = z.object({
  claude: ToolBindingSchema,
  codex: ToolBindingSchema,
});

export type BindingsManifest = z.infer<typeof BindingsManifestSchema>;
export type BindingStatusType = z.infer<typeof BindingStatus>;
export type ToolBindingType = z.infer<typeof ToolBindingSchema>;

export function parseBindingsManifest(data: unknown): BindingsManifest {
  return BindingsManifestSchema.parse(data);
}

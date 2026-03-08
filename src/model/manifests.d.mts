import { z } from 'zod';

export declare const RunStatus: z.ZodEnum<['active', 'stopped', 'detached']>;
export declare const RunMode: z.ZodEnum<['new', 'resumed', 'forked']>;

export declare const ToolEntry: z.ZodObject<{
  session_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  binding_path: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}>;

export declare const RunManifestSchema: z.ZodObject<{
  run_id: z.ZodString;
  cwd: z.ZodString;
  created_at: z.ZodString;
  updated_at: z.ZodString;
  status: typeof RunStatus;
  tmux_session: z.ZodString;
  mode: typeof RunMode;
  claude: typeof ToolEntry;
  codex: typeof ToolEntry;
  codex_home: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}>;

export declare function parseRunManifest(data: unknown): z.infer<typeof RunManifestSchema>;

export declare const BindingStatus: z.ZodEnum<['pending', 'bound', 'degraded']>;
export declare const BindingLevel: z.ZodOptional<z.ZodNullable<z.ZodEnum<['process', 'workspace']>>>;

export declare const ToolBindingSchema: z.ZodObject<{
  path: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  level: typeof BindingLevel;
  status: typeof BindingStatus;
  confirmedAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  session_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}>;

export declare const BindingsManifestSchema: z.ZodObject<{
  claude: typeof ToolBindingSchema;
  codex: typeof ToolBindingSchema;
}>;

export declare function parseBindingsManifest(data: unknown): z.infer<typeof BindingsManifestSchema>;

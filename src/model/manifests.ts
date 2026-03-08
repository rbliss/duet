// Type layer over the runtime schemas defined in manifests.mjs.
// Tests and current .mjs runtime code import manifests.mjs directly.
// Future .ts runtime code imports this file for full type safety.

export {
  RunManifestSchema,
  BindingsManifestSchema,
  ToolBindingSchema,
  RunStatus,
  RunMode,
  BindingStatus,
  BindingLevel,
  ToolEntry,
  parseRunManifest,
  parseBindingsManifest,
} from './manifests.mjs';

import type { z } from 'zod';
import type {
  RunManifestSchema,
  BindingsManifestSchema,
  ToolBindingSchema,
  RunStatus,
  RunMode,
  BindingStatus,
} from './manifests.mjs';

export type RunManifest = z.infer<typeof RunManifestSchema>;
export type RunStatusType = z.infer<typeof RunStatus>;
export type RunModeType = z.infer<typeof RunMode>;
export type BindingsManifest = z.infer<typeof BindingsManifestSchema>;
export type BindingStatusType = z.infer<typeof BindingStatus>;
export type ToolBindingType = z.infer<typeof ToolBindingSchema>;

import type { ConfigV1, ProjectOverride } from './schema.js';

/** Strip keys whose value is undefined so they don't overwrite required fields. */
function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export function mergeConfigs(global: ConfigV1, override: ProjectOverride | null): ConfigV1 {
  if (!override) return global;
  return {
    version: 1,
    learner: { ...global.learner, ...defined(override.learner ?? {}) },
    scrubber: { ...global.scrubber, ...defined(override.scrubber ?? {}) },
    license: { ...global.license, ...defined(override.license ?? {}) },
  } as ConfigV1;
}

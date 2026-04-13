/**
 * YAML rule pack loader.
 * Uses `yaml` (eemeli) for parsing and Zod for strict shape validation.
 * Invalid regex patterns are caught eagerly — the rule id is included in the error.
 */
import { promises as fs } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { RulePack } from './types.js';

/** Strict Zod schema for a YAML rule pack. Unknown keys are rejected. */
export const rulePackSchema = z
  .object({
    version: z.literal(1),
    rules: z.array(
      z
        .object({
          id: z.string().min(1),
          description: z.string(),
          pattern: z.string().min(1),
          flags: z.string().optional(),
          replacement: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Load and validate a YAML rule pack from disk.
 * Throws on malformed YAML, schema violations, or invalid regex patterns.
 */
export async function loadRulePack(path: string): Promise<RulePack> {
  const raw = await fs.readFile(path, 'utf8');
  const doc: unknown = parse(raw);
  const validated = rulePackSchema.parse(doc);

  // Eagerly compile every regex to catch invalid patterns at load time.
  for (const r of validated.rules) {
    try {
      new RegExp(r.pattern, r.flags ?? 'g');
    } catch (e) {
      throw new Error(`Rule "${r.id}" has invalid regex: ${(e as Error).message}`);
    }
  }

  return validated;
}

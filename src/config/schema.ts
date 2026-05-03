import { z } from 'zod';

export const learnerSchema = z
  .object({
    model: z.string().default('claude-sonnet-4'),
    maxCapturesPerRun: z.number().int().positive().default(50),
    timeoutSeconds: z.number().int().positive().default(600),
  })
  .strict();

export const scrubberSchema = z
  .object({
    entropyThreshold: z.number().min(0).max(8).default(4.5),
    minTokenLen: z.number().int().positive().default(20),
    rulePackPath: z.string().optional(),
  })
  .strict();

// RESERVED for Phase 6 — Phase 0 must accept this namespace from day one.
// All fields optional so Phase 0 install can leave it as defaults {}.
export const licenseSchema = z
  .object({
    keyRef: z.string().optional(),
    trialStartedAt: z.number().int().optional(),
    lastValidated: z.number().int().optional(),
    offlineGraceDays: z.number().int().positive().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    learner: learnerSchema.default({}),
    scrubber: scrubberSchema.default({}),
    license: licenseSchema.default({}),
  })
  .strict();

export type ConfigV1 = z.infer<typeof configSchema>;

// Project overrides: outer object is partial, but each present nested object is still strict
export const projectOverrideSchema = z
  .object({
    version: z.literal(1).optional(),
    learner: learnerSchema.partial().optional(),
    scrubber: scrubberSchema.partial().optional(),
    license: licenseSchema.partial().optional(),
  })
  .strict();

export type ProjectOverride = z.infer<typeof projectOverrideSchema>;

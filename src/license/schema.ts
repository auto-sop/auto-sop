import { z } from 'zod';

export const secretsPayloadV1Schema = z.object({
  schema_version: z.literal(1),
  license: z.object({
    key: z.string().min(1),
    kind: z.enum(['dev', 'user']),
    captured_at: z.number().int().nonnegative(),
  }),
  trial: z.object({
    started_at: z.number().int().nonnegative(),
    duration_days: z.number().int().positive(),
  }),
  install: z.object({
    version: z.string().min(1),
    installed_at: z.number().int().nonnegative(),
    machine_id_prefix: z.string().length(8),
  }),
});

export type SecretsPayloadV1 = z.infer<typeof secretsPayloadV1Schema>;

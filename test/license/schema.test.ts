import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { secretsPayloadV1Schema } from '../../src/license/schema.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

function validPayload() {
  return {
    schema_version: 1,
    license: { key: '123', kind: 'dev', captured_at: 1700000000 },
    trial: { started_at: 1700000000, duration_days: 14 },
    install: {
      version: '1.0.0',
      installed_at: 1700000000,
      machine_id_prefix: 'abcdef12',
    },
  };
}

describe('secretsPayloadV1Schema', () => {
  it('accepts a valid payload', () => {
    const result = secretsPayloadV1Schema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it('rejects schema_version: 2', () => {
    const result = secretsPayloadV1Schema.safeParse({
      ...validPayload(),
      schema_version: 2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty license key', () => {
    const p = validPayload();
    p.license.key = '';
    const result = secretsPayloadV1Schema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it('rejects kind outside enum', () => {
    const p = validPayload();
    (p.license as Record<string, unknown>).kind = 'enterprise';
    const result = secretsPayloadV1Schema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it('rejects machine_id_prefix of wrong length', () => {
    const p = validPayload();
    p.install.machine_id_prefix = 'abc';
    const result = secretsPayloadV1Schema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it('rejects negative duration_days', () => {
    const p = validPayload();
    p.trial.duration_days = -1;
    const result = secretsPayloadV1Schema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it('rejects zero duration_days', () => {
    const p = validPayload();
    p.trial.duration_days = 0;
    const result = secretsPayloadV1Schema.safeParse(p);
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    const result = secretsPayloadV1Schema.safeParse({ schema_version: 1 });
    expect(result.success).toBe(false);
  });

  it('accepts kind "user"', () => {
    const p = validPayload();
    p.license.kind = 'user';
    const result = secretsPayloadV1Schema.safeParse(p);
    expect(result.success).toBe(true);
  });
});

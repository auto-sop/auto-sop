import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { trialStatus, TRIAL_DURATION_DAYS } from '../../src/license/trial.js';
import type { SecretsPayloadV1 } from '../../src/license/schema.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

const DAY_MS = 1000 * 60 * 60 * 24;

function makePayload(
  overrides: {
    kind?: 'dev' | 'user';
    started_at?: number;
    duration_days?: number;
  } = {},
): SecretsPayloadV1 {
  return {
    schema_version: 1,
    license: {
      key: overrides.kind === 'dev' ? '123' : 'real-key',
      kind: overrides.kind ?? 'user',
      captured_at: 1700000000000,
    },
    trial: {
      started_at: overrides.started_at ?? 1700000000000,
      duration_days: overrides.duration_days ?? TRIAL_DURATION_DAYS,
    },
    install: {
      version: '1.0.0',
      installed_at: 1700000000000,
      machine_id_prefix: 'deadbeef',
    },
  };
}

describe('trialStatus', () => {
  it('dev key returns dev-key with Infinity daysRemaining', () => {
    const payload = makePayload({ kind: 'dev' });
    const result = trialStatus(payload, payload.trial.started_at + 999 * DAY_MS);
    expect(result.status).toBe('dev-key');
    expect(result.daysRemaining).toBe(Infinity);
  });

  it('trial just started (now === startedAt) → trial with ~14 days remaining', () => {
    const payload = makePayload();
    const result = trialStatus(payload, payload.trial.started_at);
    expect(result.status).toBe('trial');
    expect(result.daysRemaining).toBeCloseTo(14, 5);
  });

  it('trial 7 days in → ~7 days remaining', () => {
    const payload = makePayload();
    const result = trialStatus(payload, payload.trial.started_at + 7 * DAY_MS);
    expect(result.status).toBe('trial');
    expect(result.daysRemaining).toBeCloseTo(7, 5);
  });

  it('trial 14 days + 1ms in → expired, daysRemaining slightly negative', () => {
    const payload = makePayload();
    const result = trialStatus(payload, payload.trial.started_at + 14 * DAY_MS + 1);
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBeLessThan(0);
    expect(result.daysRemaining).toBeGreaterThan(-0.001);
  });

  it('trial 30 days in → expired, daysRemaining ≈ -16', () => {
    const payload = makePayload();
    const result = trialStatus(payload, payload.trial.started_at + 30 * DAY_MS);
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBeCloseTo(-16, 5);
  });

  it('custom duration_days=7 expires at day 7', () => {
    const payload = makePayload({ duration_days: 7 });
    // At day 6: still trial
    const atDay6 = trialStatus(payload, payload.trial.started_at + 6 * DAY_MS);
    expect(atDay6.status).toBe('trial');
    expect(atDay6.daysRemaining).toBeCloseTo(1, 5);

    // At day 7 + 1ms: expired
    const atDay7 = trialStatus(payload, payload.trial.started_at + 7 * DAY_MS + 1);
    expect(atDay7.status).toBe('expired');
  });

  it('startedAt in the future → daysRemaining > duration_days, still trial', () => {
    const futureStart = Date.now() + 10 * DAY_MS;
    const payload = makePayload({ started_at: futureStart });
    const result = trialStatus(payload, Date.now());
    expect(result.status).toBe('trial');
    expect(result.daysRemaining).toBeGreaterThan(14);
  });

  it('TRIAL_DURATION_DAYS is 14', () => {
    expect(TRIAL_DURATION_DAYS).toBe(14);
  });
});

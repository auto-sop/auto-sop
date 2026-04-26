import { describe, it, expect } from 'vitest';
import { toCloudSyncFormat, isValidSyncPayload } from '../../src/metrics/sync-format.js';
import type { MetricsState } from '../../src/metrics/state.js';

function makeState(overrides: Partial<MetricsState> = {}): MetricsState {
  return {
    v: 1,
    project_slug: 'test-project',
    total_tokens_saved: 1500,
    total_errors_prevented: 3,
    total_time_saved_minutes: 45,
    per_directive_attribution: [
      { directive_id: 'dir-1', tokens_saved: 800, errors_prevented: 2, time_saved_minutes: 25 },
      { directive_id: 'dir-2', tokens_saved: 700, errors_prevented: 1, time_saved_minutes: 20 },
    ],
    last_computed_at: '2026-04-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('toCloudSyncFormat', () => {
  it('returns null for null state', () => {
    expect(toCloudSyncFormat(null)).toBeNull();
  });

  it('serializes state to cloud format', () => {
    const state = makeState();
    const now = new Date('2026-04-20T15:00:00.000Z');
    const payload = toCloudSyncFormat(state, now)!;

    expect(payload).not.toBeNull();
    expect(payload.v).toBe(1);
    expect(payload.project_slug).toBe('test-project');
    expect(payload.period).toBe('2026-04');
    expect(payload.token_savings).toBe(1500);
    expect(payload.errors_prevented).toBe(3);
    expect(payload.time_saved_minutes).toBe(45);
    expect(payload.directive_count).toBe(2);
    expect(payload.generated_at).toBe('2026-04-20T15:00:00.000Z');
  });

  it('formats period as YYYY-MM', () => {
    const state = makeState();
    const jan = new Date('2026-01-15T10:00:00.000Z');
    const payload = toCloudSyncFormat(state, jan)!;
    expect(payload.period).toBe('2026-01');

    const dec = new Date('2026-12-31T23:59:59.000Z');
    const payload2 = toCloudSyncFormat(state, dec)!;
    expect(payload2.period).toBe('2026-12');
  });

  it('handles zero metrics', () => {
    const state = makeState({
      total_tokens_saved: 0,
      total_errors_prevented: 0,
      total_time_saved_minutes: 0,
      per_directive_attribution: [],
    });
    const payload = toCloudSyncFormat(state)!;

    expect(payload.token_savings).toBe(0);
    expect(payload.errors_prevented).toBe(0);
    expect(payload.time_saved_minutes).toBe(0);
    expect(payload.directive_count).toBe(0);
  });

  it('produces valid JSON when serialized', () => {
    const state = makeState();
    const payload = toCloudSyncFormat(state, new Date('2026-04-20T10:00:00Z'))!;
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json);

    expect(parsed.v).toBe(1);
    expect(parsed.project_slug).toBe('test-project');
  });
});

describe('isValidSyncPayload', () => {
  it('validates correct payload', () => {
    const payload = toCloudSyncFormat(makeState(), new Date('2026-04-20T10:00:00Z'));
    expect(isValidSyncPayload(payload)).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidSyncPayload(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isValidSyncPayload('string')).toBe(false);
    expect(isValidSyncPayload(42)).toBe(false);
  });

  it('rejects wrong version', () => {
    const payload = { ...toCloudSyncFormat(makeState(), new Date('2026-04-20T10:00:00Z'))!, v: 2 };
    expect(isValidSyncPayload(payload)).toBe(false);
  });

  it('rejects empty project_slug', () => {
    const payload = { ...toCloudSyncFormat(makeState(), new Date('2026-04-20T10:00:00Z'))!, project_slug: '' };
    expect(isValidSyncPayload(payload)).toBe(false);
  });

  it('rejects invalid period format', () => {
    const payload = { ...toCloudSyncFormat(makeState(), new Date('2026-04-20T10:00:00Z'))!, period: '2026/04' };
    expect(isValidSyncPayload(payload)).toBe(false);
  });

  it('rejects NaN token_savings', () => {
    const payload = { ...toCloudSyncFormat(makeState(), new Date('2026-04-20T10:00:00Z'))!, token_savings: NaN };
    expect(isValidSyncPayload(payload)).toBe(false);
  });

  it('rejects Infinity errors_prevented', () => {
    const payload = { ...toCloudSyncFormat(makeState(), new Date('2026-04-20T10:00:00Z'))!, errors_prevented: Infinity };
    expect(isValidSyncPayload(payload)).toBe(false);
  });

  it('rejects missing generated_at', () => {
    const payload = { ...toCloudSyncFormat(makeState(), new Date('2026-04-20T10:00:00Z'))!, generated_at: '' };
    expect(isValidSyncPayload(payload)).toBe(false);
  });
});

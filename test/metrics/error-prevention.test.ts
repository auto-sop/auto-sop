import { describe, it, expect } from 'vitest';
import {
  computeErrorPreventionMetrics,
  countPreventedSince,
} from '../../src/metrics/error-prevention.js';
import type { PreventedError } from '../../src/learner/error-prevention.js';

function makePreventedError(overrides: Partial<PreventedError> = {}): PreventedError {
  return {
    t: '2026-04-15T10:00:00.000Z',
    directive_id: 'dir-1',
    source_fingerprint: 'npm test',
    session_id: 'sess-001',
    command_preview: 'npm test',
    ...overrides,
  };
}

describe('computeErrorPreventionMetrics', () => {
  it('returns zeros for empty input', () => {
    const result = computeErrorPreventionMetrics([]);
    expect(result.total_prevented).toBe(0);
    expect(result.this_month).toBe(0);
    expect(result.this_week).toBe(0);
    expect(result.by_directive).toEqual({});
  });

  it('counts total prevented errors', () => {
    const events = [
      makePreventedError({ directive_id: 'dir-1' }),
      makePreventedError({ directive_id: 'dir-1' }),
      makePreventedError({ directive_id: 'dir-2' }),
    ];
    const now = new Date('2026-04-15T12:00:00.000Z');
    const result = computeErrorPreventionMetrics(events, now);

    expect(result.total_prevented).toBe(3);
  });

  it('groups by directive_id', () => {
    const events = [
      makePreventedError({ directive_id: 'dir-1' }),
      makePreventedError({ directive_id: 'dir-1' }),
      makePreventedError({ directive_id: 'dir-2' }),
    ];
    const now = new Date('2026-04-15T12:00:00.000Z');
    const result = computeErrorPreventionMetrics(events, now);

    expect(result.by_directive['dir-1']).toBe(2);
    expect(result.by_directive['dir-2']).toBe(1);
  });

  it('filters by this_month (30 days)', () => {
    const events = [
      makePreventedError({ t: '2026-04-10T10:00:00.000Z' }), // within 30 days
      makePreventedError({ t: '2026-03-01T10:00:00.000Z' }), // > 30 days ago
    ];
    const now = new Date('2026-04-20T12:00:00.000Z');
    const result = computeErrorPreventionMetrics(events, now);

    expect(result.total_prevented).toBe(2);
    expect(result.this_month).toBe(1); // only the April event
  });

  it('filters by this_week (7 days)', () => {
    const events = [
      makePreventedError({ t: '2026-04-19T10:00:00.000Z' }), // within 7 days
      makePreventedError({ t: '2026-04-10T10:00:00.000Z' }), // > 7 days ago
    ];
    const now = new Date('2026-04-20T12:00:00.000Z');
    const result = computeErrorPreventionMetrics(events, now);

    expect(result.this_week).toBe(1);
  });

  it('skips events with invalid timestamps', () => {
    const events = [
      makePreventedError({ t: 'not-a-date' }),
      makePreventedError({ t: '2026-04-15T10:00:00.000Z' }),
    ];
    const now = new Date('2026-04-20T12:00:00.000Z');
    const result = computeErrorPreventionMetrics(events, now);

    expect(result.total_prevented).toBe(1);
  });
});

describe('countPreventedSince', () => {
  it('returns 0 for empty events', () => {
    expect(countPreventedSince([], '2026-04-01T00:00:00.000Z')).toBe(0);
  });

  it('returns 0 for invalid since date', () => {
    const events = [makePreventedError()];
    expect(countPreventedSince(events, 'not-a-date')).toBe(0);
  });

  it('counts events after the since date', () => {
    const events = [
      makePreventedError({ t: '2026-04-10T10:00:00.000Z' }),
      makePreventedError({ t: '2026-04-15T10:00:00.000Z' }),
      makePreventedError({ t: '2026-03-15T10:00:00.000Z' }),
    ];
    const count = countPreventedSince(events, '2026-04-01T00:00:00.000Z');
    expect(count).toBe(2);
  });

  it('includes events exactly at the since date', () => {
    const events = [makePreventedError({ t: '2026-04-01T00:00:00.000Z' })];
    const count = countPreventedSince(events, '2026-04-01T00:00:00.000Z');
    expect(count).toBe(1);
  });

  it('skips events with invalid timestamps', () => {
    const events = [
      makePreventedError({ t: 'invalid' }),
      makePreventedError({ t: '2026-04-15T10:00:00.000Z' }),
    ];
    const count = countPreventedSince(events, '2026-04-01T00:00:00.000Z');
    expect(count).toBe(1);
  });
});

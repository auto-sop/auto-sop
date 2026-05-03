import { describe, it, expect } from 'vitest';
import {
  calculateTimeSavings,
  computePerDirectiveTimeSavings,
} from '../../src/metrics/time-savings.js';
import type { BeforeAfterComparison, SessionSummary } from '../../src/learner/session-metrics.js';

function makeComparison(
  beforeAvgMin: number,
  afterAvgMin: number,
  beforeSessions: number = 5,
  afterSessions: number = 5,
): BeforeAfterComparison {
  return {
    cutoff: '2026-04-22T00:00:00Z',
    before: {
      sessions: beforeSessions,
      avg_duration_min: beforeAvgMin,
      avg_tool_calls: 20,
      avg_bash_failures: 2,
      avg_input_bytes: 0,
      avg_output_bytes: 0,
    },
    after: {
      sessions: afterSessions,
      avg_duration_min: afterAvgMin,
      avg_tool_calls: 10,
      avg_bash_failures: 1,
      avg_input_bytes: 0,
      avg_output_bytes: 0,
    },
    improvement: { duration_pct: -50, tool_calls_pct: -50, bash_failures_pct: -50 },
  };
}

function makeSummary(sessionId: string, startedAt: string, durationMs: number): SessionSummary {
  return {
    session_id: sessionId,
    started_at: startedAt,
    ended_at: startedAt,
    duration_ms: durationMs,
    turn_count: 5,
    tool_call_count: 20,
    files_changed_count: 3,
    bash_failure_count: 1,
    total_input_bytes: 0,
    total_output_bytes: 0,
  };
}

describe('calculateTimeSavings', () => {
  it('returns null for null comparison', () => {
    expect(calculateTimeSavings(null)).toBeNull();
  });

  it('returns null when before has fewer than 2 sessions', () => {
    const comp = makeComparison(20, 10, 1, 5);
    expect(calculateTimeSavings(comp)).toBeNull();
  });

  it('returns null when after has fewer than 2 sessions', () => {
    const comp = makeComparison(20, 10, 5, 1);
    expect(calculateTimeSavings(comp)).toBeNull();
  });

  it('calculates positive time savings', () => {
    // before: 20 min avg, after: 10 min avg, 5 after sessions
    const comp = makeComparison(20, 10);
    const result = calculateTimeSavings(comp)!;

    expect(result).not.toBeNull();
    expect(result.method).toBe('duration_comparison');
    expect(result.per_session_minutes).toBe(10);
    expect(result.total_minutes_saved).toBe(50); // 10 * 5
    expect(result.sessions_after).toBe(5);
  });

  it('clamps negative savings to 0 (conservative)', () => {
    // after is LONGER — no savings claimed
    const comp = makeComparison(10, 20);
    const result = calculateTimeSavings(comp)!;

    expect(result.per_session_minutes).toBe(0);
    expect(result.total_minutes_saved).toBe(0);
  });

  it('handles zero duration in both buckets', () => {
    const comp = makeComparison(0, 0);
    const result = calculateTimeSavings(comp)!;

    expect(result.per_session_minutes).toBe(0);
    expect(result.total_minutes_saved).toBe(0);
  });

  it('handles fractional minutes', () => {
    const comp = makeComparison(10.5, 7.3, 4, 4);
    const result = calculateTimeSavings(comp)!;

    expect(result.per_session_minutes).toBe(3.2);
    expect(result.total_minutes_saved).toBe(12.8); // 3.2 * 4
  });
});

describe('computePerDirectiveTimeSavings', () => {
  it('returns empty for fewer than 4 sessions', () => {
    const sessions = [
      makeSummary('s1', '2026-04-20T10:00:00Z', 600_000),
      makeSummary('s2', '2026-04-21T10:00:00Z', 600_000),
      makeSummary('s3', '2026-04-22T10:00:00Z', 300_000),
    ];
    const directives = [{ directive_id: 'dir-1', first_seen: '2026-04-21T12:00:00Z' }];
    expect(computePerDirectiveTimeSavings(sessions, directives)).toEqual([]);
  });

  it('computes per-directive savings with sufficient data', () => {
    const sessions = [
      makeSummary('s1', '2026-04-20T10:00:00Z', 1_200_000), // 20 min
      makeSummary('s2', '2026-04-21T10:00:00Z', 1_200_000), // 20 min
      makeSummary('s3', '2026-04-22T10:00:00Z', 600_000), // 10 min
      makeSummary('s4', '2026-04-23T10:00:00Z', 600_000), // 10 min
    ];
    const directives = [{ directive_id: 'dir-1', first_seen: '2026-04-22T00:00:00Z' }];
    const result = computePerDirectiveTimeSavings(sessions, directives);

    expect(result).toHaveLength(1);
    expect(result[0]!.directive_id).toBe('dir-1');
    expect(result[0]!.minutes_saved).toBe(10); // 20 - 10
    expect(result[0]!.sessions_compared).toBe(4);
  });

  it('excludes directives with no improvement', () => {
    const sessions = [
      makeSummary('s1', '2026-04-20T10:00:00Z', 600_000), // 10 min
      makeSummary('s2', '2026-04-21T10:00:00Z', 600_000), // 10 min
      makeSummary('s3', '2026-04-22T10:00:00Z', 1_200_000), // 20 min (worse)
      makeSummary('s4', '2026-04-23T10:00:00Z', 1_200_000), // 20 min (worse)
    ];
    const directives = [{ directive_id: 'dir-1', first_seen: '2026-04-22T00:00:00Z' }];
    const result = computePerDirectiveTimeSavings(sessions, directives);

    expect(result).toEqual([]); // no positive savings
  });

  it('skips directives with invalid first_seen', () => {
    const sessions = [
      makeSummary('s1', '2026-04-20T10:00:00Z', 1_200_000),
      makeSummary('s2', '2026-04-21T10:00:00Z', 1_200_000),
      makeSummary('s3', '2026-04-22T10:00:00Z', 600_000),
      makeSummary('s4', '2026-04-23T10:00:00Z', 600_000),
    ];
    const directives = [{ directive_id: 'dir-1', first_seen: 'invalid-date' }];
    const result = computePerDirectiveTimeSavings(sessions, directives);

    expect(result).toEqual([]);
  });

  it('handles multiple directives', () => {
    const sessions = [
      makeSummary('s1', '2026-04-18T10:00:00Z', 1_800_000), // 30 min
      makeSummary('s2', '2026-04-19T10:00:00Z', 1_800_000), // 30 min
      makeSummary('s3', '2026-04-20T10:00:00Z', 1_200_000), // 20 min
      makeSummary('s4', '2026-04-21T10:00:00Z', 1_200_000), // 20 min
      makeSummary('s5', '2026-04-22T10:00:00Z', 600_000), // 10 min
      makeSummary('s6', '2026-04-23T10:00:00Z', 600_000), // 10 min
    ];
    const directives = [
      { directive_id: 'dir-1', first_seen: '2026-04-20T00:00:00Z' },
      { directive_id: 'dir-2', first_seen: '2026-04-22T00:00:00Z' },
    ];
    const result = computePerDirectiveTimeSavings(sessions, directives);

    expect(result.length).toBeGreaterThanOrEqual(1);
    // Both directives should show savings (all sessions get shorter over time)
    for (const r of result) {
      expect(r.minutes_saved).toBeGreaterThan(0);
    }
  });
});

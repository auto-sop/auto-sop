import { describe, it, expect } from 'vitest';
import {
  extractTokenSavings,
  computePerDirectiveTokenDelta,
} from '../../src/metrics/token-extractor.js';
import { TOKENS_PER_CALL } from '../../src/learner/session-metrics.js';
import type { BeforeAfterComparison, SessionSummary } from '../../src/learner/session-metrics.js';

function makeComparison(
  beforeAvgCalls: number,
  afterAvgCalls: number,
  beforeSessions: number = 5,
  afterSessions: number = 5,
): BeforeAfterComparison {
  return {
    cutoff: '2026-04-22T00:00:00Z',
    before: {
      sessions: beforeSessions,
      avg_duration_min: 10,
      avg_tool_calls: beforeAvgCalls,
      avg_bash_failures: 2,
      avg_input_bytes: 0,
      avg_output_bytes: 0,
    },
    after: {
      sessions: afterSessions,
      avg_duration_min: 8,
      avg_tool_calls: afterAvgCalls,
      avg_bash_failures: 1,
      avg_input_bytes: 0,
      avg_output_bytes: 0,
    },
    improvement: { duration_pct: -20, tool_calls_pct: -40, bash_failures_pct: -50 },
  };
}

function makeSummary(
  sessionId: string,
  startedAt: string,
  toolCalls: number,
  turnCount: number = 5,
  durationMs: number = 600_000,
): SessionSummary {
  return {
    session_id: sessionId,
    started_at: startedAt,
    ended_at: startedAt,
    duration_ms: durationMs,
    turn_count: turnCount,
    tool_call_count: toolCalls,
    files_changed_count: 2,
    bash_failure_count: 1,
    total_input_bytes: 0,
    total_output_bytes: 0,
  };
}

describe('extractTokenSavings', () => {
  it('returns null for null comparison', () => {
    expect(extractTokenSavings(null)).toBeNull();
  });

  it('returns null when before has fewer than 2 sessions', () => {
    const comp = makeComparison(20, 10, 1, 5);
    expect(extractTokenSavings(comp)).toBeNull();
  });

  it('returns null when after has fewer than 2 sessions', () => {
    const comp = makeComparison(20, 10, 5, 1);
    expect(extractTokenSavings(comp)).toBeNull();
  });

  it('calculates positive token savings correctly', () => {
    // before: 20 calls * 200 = 4000; after: 12 calls * 200 = 2400
    const comp = makeComparison(20, 12);
    const result = extractTokenSavings(comp)!;

    expect(result).not.toBeNull();
    expect(result.method).toBe('session_comparison');
    expect(result.tokens_per_call).toBe(TOKENS_PER_CALL);
    expect(result.total_before_avg).toBe(4000);
    expect(result.total_after_avg).toBe(2400);
    expect(result.total_savings_per_session).toBe(1600);
    expect(result.total_savings_pct).toBe(40);
  });

  it('clamps negative savings to 0', () => {
    // after has MORE tool calls — no savings
    const comp = makeComparison(10, 15);
    const result = extractTokenSavings(comp)!;

    expect(result.total_savings_per_session).toBe(0);
    expect(result.total_savings_pct).toBe(0);
  });

  it('handles zero tool calls in both buckets', () => {
    const comp = makeComparison(0, 0);
    const result = extractTokenSavings(comp)!;

    expect(result.total_savings_per_session).toBe(0);
    expect(result.total_savings_pct).toBe(0);
  });

  it('handles zero before tool calls gracefully', () => {
    const comp = makeComparison(0, 10);
    const result = extractTokenSavings(comp)!;

    expect(result.total_savings_per_session).toBe(0);
    expect(result.total_savings_pct).toBe(0);
  });
});

describe('computePerDirectiveTokenDelta', () => {
  it('returns null with fewer than 2 before sessions', () => {
    const before = [makeSummary('s1', '2026-04-20T10:00:00Z', 20)];
    const after = [
      makeSummary('s3', '2026-04-22T10:00:00Z', 10),
      makeSummary('s4', '2026-04-23T10:00:00Z', 10),
    ];
    expect(computePerDirectiveTokenDelta(before, after, 'dir-1')).toBeNull();
  });

  it('returns null with fewer than 2 after sessions', () => {
    const before = [
      makeSummary('s1', '2026-04-20T10:00:00Z', 20),
      makeSummary('s2', '2026-04-21T10:00:00Z', 20),
    ];
    const after = [makeSummary('s3', '2026-04-22T10:00:00Z', 10)];
    expect(computePerDirectiveTokenDelta(before, after, 'dir-1')).toBeNull();
  });

  it('computes token delta from sessions', () => {
    const before = [
      makeSummary('s1', '2026-04-20T10:00:00Z', 20, 5),
      makeSummary('s2', '2026-04-21T10:00:00Z', 30, 5),
    ];
    const after = [
      makeSummary('s3', '2026-04-22T10:00:00Z', 10, 5),
      makeSummary('s4', '2026-04-23T10:00:00Z', 10, 5),
    ];

    const result = computePerDirectiveTokenDelta(before, after, 'dir-1')!;
    expect(result.directive_id).toBe('dir-1');
    // before avg: ((20*200 + 5*800) + (30*200 + 5*800)) / 2 = (8000 + 10000) / 2 = 9000
    // after avg: ((10*200 + 5*800) + (10*200 + 5*800)) / 2 = (6000 + 6000) / 2 = 6000
    expect(result.before_avg_tokens).toBe(9000);
    expect(result.after_avg_tokens).toBe(6000);
    expect(result.savings_per_session).toBe(3000);
  });

  it('clamps negative savings to 0', () => {
    const before = [
      makeSummary('s1', '2026-04-20T10:00:00Z', 5, 2),
      makeSummary('s2', '2026-04-21T10:00:00Z', 5, 2),
    ];
    const after = [
      makeSummary('s3', '2026-04-22T10:00:00Z', 20, 10),
      makeSummary('s4', '2026-04-23T10:00:00Z', 20, 10),
    ];

    const result = computePerDirectiveTokenDelta(before, after, 'dir-1')!;
    expect(result.savings_per_session).toBe(0);
    expect(result.savings_pct).toBe(0);
  });
});

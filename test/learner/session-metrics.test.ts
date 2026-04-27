/**
 * Unit tests for src/learner/session-metrics.ts
 *
 * Covers:
 * - buildSessionSummaries: grouping, bash failure counting, sorting
 * - compareBeforeAfter: splitting, averaging, percentage calculation, edge cases
 */
import { describe, it, expect } from 'vitest';
import {
  buildSessionSummaries,
  compareBeforeAfter,
  estimateTokenSavings,
  estimateTokenSavingsByBytes,
  TOKENS_PER_CALL,
  CHARS_PER_TOKEN,
} from '../../src/learner/session-metrics.js';
import type { SessionSummary, BeforeAfterComparison } from '../../src/learner/session-metrics.js';
import type { TurnData, ToolCall } from '../../src/learner/turn-loader.js';

// ── Fixture helpers ──────────────────────────────────────

function makeTurn(
  turnId: string,
  sessionId: string,
  finalizedAt: string,
  toolCalls: ToolCall[] = [],
): TurnData {
  return {
    turn_id: turnId,
    session_id: sessionId,
    agent: 'main',
    finalized_at: finalizedAt,
    tool_calls: toolCalls,
  };
}

function makeBashCallPair(
  useId: string,
  command: string,
  success: boolean,
  t: string,
): ToolCall[] {
  return [
    {
      event: 'pre',
      tool_use_id: useId,
      tool: 'Bash',
      input: { command },
      t,
    },
    {
      event: 'post',
      tool_use_id: useId,
      tool: 'Bash',
      output: { __untrusted: true, exitCode: success ? 0 : 1 },
      success,
      t,
    },
  ];
}

function makeEditCallPair(useId: string, t: string): ToolCall[] {
  return [
    {
      event: 'pre',
      tool_use_id: useId,
      tool: 'Edit',
      input: { file_path: '/tmp/a.ts' },
      t,
    },
    {
      event: 'post',
      tool_use_id: useId,
      tool: 'Edit',
      output: { __untrusted: true },
      success: true,
      t,
    },
  ];
}

// ─── buildSessionSummaries ──────────────────────────────

describe('buildSessionSummaries', () => {
  it('groups turns by session_id', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z'),
      makeTurn('t2', 's1', '2026-04-25T10:05:00Z'),
      makeTurn('t3', 's2', '2026-04-25T11:00:00Z'),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.session_id).toBe('s1');
    expect(summaries[0]!.turn_count).toBe(2);
    expect(summaries[1]!.session_id).toBe('s2');
    expect(summaries[1]!.turn_count).toBe(1);
  });

  it('computes duration from first to last turn', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z'),
      makeTurn('t2', 's1', '2026-04-25T10:10:00Z'),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.duration_ms).toBe(10 * 60 * 1000); // 10 minutes
  });

  it('single-turn session has 0 duration', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z'),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.duration_ms).toBe(0);
  });

  it('counts bash failures via pre/post join', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        ...makeBashCallPair('tu1', 'npm test', false, '2026-04-25T10:00:00Z'),
        ...makeBashCallPair('tu2', 'npm run build', true, '2026-04-25T10:01:00Z'),
        ...makeBashCallPair('tu3', 'git status', false, '2026-04-25T10:02:00Z'),
      ]),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.bash_failure_count).toBe(2);
  });

  it('counts tool calls (pre events)', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        ...makeBashCallPair('tu1', 'npm test', true, '2026-04-25T10:00:00Z'),
        ...makeEditCallPair('tu2', '2026-04-25T10:01:00Z'),
      ]),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.tool_call_count).toBe(2);
  });

  it('counts files changed from Edit/Write pre events', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        ...makeEditCallPair('tu1', '2026-04-25T10:00:00Z'),
        ...makeEditCallPair('tu2', '2026-04-25T10:01:00Z'),
        {
          event: 'pre',
          tool_use_id: 'tu3',
          tool: 'Write',
          input: { file_path: '/tmp/b.ts' },
          t: '2026-04-25T10:02:00Z',
        },
        {
          event: 'post',
          tool_use_id: 'tu3',
          tool: 'Write',
          output: { __untrusted: true },
          success: true,
          t: '2026-04-25T10:02:00Z',
        },
      ]),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.files_changed_count).toBe(3);
  });

  it('sorts sessions by started_at ascending', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's2', '2026-04-25T12:00:00Z'),
      makeTurn('t2', 's1', '2026-04-25T10:00:00Z'),
      makeTurn('t3', 's3', '2026-04-25T14:00:00Z'),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries.map((s) => s.session_id)).toEqual(['s1', 's2', 's3']);
  });

  it('returns empty array for empty input', () => {
    expect(buildSessionSummaries([])).toEqual([]);
  });

  it('does not count non-Bash failures as bash failures', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        ...makeEditCallPair('tu1', '2026-04-25T10:00:00Z'),
        // Override success to false
      ]),
    ];
    // Manually set Edit post to failure
    turns[0]!.tool_calls[1]!.success = false;

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.bash_failure_count).toBe(0);
  });
});

// ─── compareBeforeAfter ─────────────────────────────────

describe('compareBeforeAfter', () => {
  function makeSummary(
    sessionId: string,
    startedAt: string,
    overrides?: Partial<SessionSummary>,
  ): SessionSummary {
    return {
      session_id: sessionId,
      started_at: startedAt,
      ended_at: startedAt,
      duration_ms: 600_000, // 10 min
      turn_count: 5,
      tool_call_count: 20,
      files_changed_count: 3,
      bash_failure_count: 4,
      total_input_bytes: 0,
      total_output_bytes: 0,
      ...overrides,
    };
  }

  it('splits sessions by cutoff timestamp', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z'),
      makeSummary('s2', '2026-04-21T10:00:00Z'),
      makeSummary('s3', '2026-04-22T10:00:00Z'),
      makeSummary('s4', '2026-04-23T10:00:00Z'),
    ];

    const result = compareBeforeAfter(sessions, '2026-04-22T00:00:00Z');
    expect(result).not.toBeNull();
    expect(result!.before.sessions).toBe(2);
    expect(result!.after.sessions).toBe(2);
  });

  it('calculates averages correctly', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z', { duration_ms: 600_000, tool_call_count: 10, bash_failure_count: 2 }),
      makeSummary('s2', '2026-04-21T10:00:00Z', { duration_ms: 1_200_000, tool_call_count: 30, bash_failure_count: 6 }),
      makeSummary('s3', '2026-04-22T10:00:00Z', { duration_ms: 300_000, tool_call_count: 5, bash_failure_count: 1 }),
      makeSummary('s4', '2026-04-23T10:00:00Z', { duration_ms: 300_000, tool_call_count: 15, bash_failure_count: 1 }),
    ];

    const result = compareBeforeAfter(sessions, '2026-04-22T00:00:00Z')!;

    // Before: avg duration = (10+20)/2 = 15 min, avg tool calls = (10+30)/2 = 20, avg bash failures = (2+6)/2 = 4
    expect(result.before.avg_duration_min).toBe(15);
    expect(result.before.avg_tool_calls).toBe(20);
    expect(result.before.avg_bash_failures).toBe(4);

    // After: avg duration = (5+5)/2 = 5 min, avg tool calls = (5+15)/2 = 10, avg bash failures = (1+1)/2 = 1
    expect(result.after.avg_duration_min).toBe(5);
    expect(result.after.avg_tool_calls).toBe(10);
    expect(result.after.avg_bash_failures).toBe(1);
  });

  it('calculates percentage improvement', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z', { duration_ms: 600_000, tool_call_count: 20, bash_failure_count: 4 }),
      makeSummary('s2', '2026-04-21T10:00:00Z', { duration_ms: 600_000, tool_call_count: 20, bash_failure_count: 4 }),
      makeSummary('s3', '2026-04-22T10:00:00Z', { duration_ms: 300_000, tool_call_count: 10, bash_failure_count: 2 }),
      makeSummary('s4', '2026-04-23T10:00:00Z', { duration_ms: 300_000, tool_call_count: 10, bash_failure_count: 2 }),
    ];

    const result = compareBeforeAfter(sessions, '2026-04-22T00:00:00Z')!;

    // 50% reduction in all metrics
    expect(result.improvement.duration_pct).toBe(-50);
    expect(result.improvement.tool_calls_pct).toBe(-50);
    expect(result.improvement.bash_failures_pct).toBe(-50);
  });

  it('returns null when before bucket has fewer than 2 sessions', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z'),
      makeSummary('s2', '2026-04-22T10:00:00Z'),
      makeSummary('s3', '2026-04-23T10:00:00Z'),
    ];

    const result = compareBeforeAfter(sessions, '2026-04-21T00:00:00Z');
    expect(result).toBeNull();
  });

  it('returns null when after bucket has fewer than 2 sessions', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z'),
      makeSummary('s2', '2026-04-21T10:00:00Z'),
      makeSummary('s3', '2026-04-22T10:00:00Z'),
    ];

    const result = compareBeforeAfter(sessions, '2026-04-22T00:00:00Z');
    expect(result).toBeNull();
  });

  it('returns null for empty sessions array', () => {
    expect(compareBeforeAfter([], '2026-04-22T00:00:00Z')).toBeNull();
  });

  it('returns null for all sessions before cutoff', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z'),
      makeSummary('s2', '2026-04-21T10:00:00Z'),
    ];

    expect(compareBeforeAfter(sessions, '2026-04-30T00:00:00Z')).toBeNull();
  });

  it('returns null for all sessions after cutoff', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z'),
      makeSummary('s2', '2026-04-21T10:00:00Z'),
    ];

    expect(compareBeforeAfter(sessions, '2026-04-10T00:00:00Z')).toBeNull();
  });

  it('handles zero before metrics gracefully', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z', { duration_ms: 0, tool_call_count: 0, bash_failure_count: 0 }),
      makeSummary('s2', '2026-04-21T10:00:00Z', { duration_ms: 0, tool_call_count: 0, bash_failure_count: 0 }),
      makeSummary('s3', '2026-04-22T10:00:00Z', { duration_ms: 600_000, tool_call_count: 10, bash_failure_count: 2 }),
      makeSummary('s4', '2026-04-23T10:00:00Z', { duration_ms: 600_000, tool_call_count: 10, bash_failure_count: 2 }),
    ];

    const result = compareBeforeAfter(sessions, '2026-04-22T00:00:00Z')!;
    // When before is 0 and after is non-zero: 100% increase
    expect(result.improvement.duration_pct).toBe(100);
    expect(result.improvement.tool_calls_pct).toBe(100);
    expect(result.improvement.bash_failures_pct).toBe(100);
  });

  it('returns null for invalid cutoff timestamp', () => {
    const sessions: SessionSummary[] = [
      makeSummary('s1', '2026-04-20T10:00:00Z'),
      makeSummary('s2', '2026-04-21T10:00:00Z'),
    ];

    expect(compareBeforeAfter(sessions, 'not-a-date')).toBeNull();
  });
});

// ─── estimateTokenSavings ─────────────────────────────

describe('estimateTokenSavings', () => {
  function makeComparison(
    beforeAvgToolCalls: number,
    afterAvgToolCalls: number,
    overrides?: Partial<BeforeAfterComparison>,
  ): BeforeAfterComparison {
    return {
      cutoff: '2026-04-22T00:00:00Z',
      before: { sessions: 5, avg_duration_min: 10, avg_tool_calls: beforeAvgToolCalls, avg_bash_failures: 2, avg_input_bytes: 0, avg_output_bytes: 0 },
      after: { sessions: 5, avg_duration_min: 8, avg_tool_calls: afterAvgToolCalls, avg_bash_failures: 1, avg_input_bytes: 0, avg_output_bytes: 0 },
      improvement: { duration_pct: -20, tool_calls_pct: -40, bash_failures_pct: -50 },
      ...overrides,
    };
  }

  it('returns null for null comparison', () => {
    expect(estimateTokenSavings(null)).toBeNull();
  });

  it('returns null if before bucket has 0 sessions', () => {
    const comp = makeComparison(20, 10, {
      before: { sessions: 0, avg_duration_min: 0, avg_tool_calls: 20, avg_bash_failures: 0, avg_input_bytes: 0, avg_output_bytes: 0 },
    });
    expect(estimateTokenSavings(comp)).toBeNull();
  });

  it('returns null if after bucket has 0 sessions', () => {
    const comp = makeComparison(20, 10, {
      after: { sessions: 0, avg_duration_min: 0, avg_tool_calls: 10, avg_bash_failures: 0, avg_input_bytes: 0, avg_output_bytes: 0 },
    });
    expect(estimateTokenSavings(comp)).toBeNull();
  });

  it('calculates token savings correctly', () => {
    // before: 20 tool calls * 200 = 4000 tokens
    // after: 12 tool calls * 200 = 2400 tokens
    // savings: 1600 tokens, 40%
    const comp = makeComparison(20, 12);
    const result = estimateTokenSavings(comp)!;

    expect(result).not.toBeNull();
    expect(result.method).toBe('tool_call_heuristic');
    expect(result.tokens_per_call).toBe(TOKENS_PER_CALL);
    expect(result.before_avg_tokens).toBe(4000);
    expect(result.after_avg_tokens).toBe(2400);
    expect(result.savings_per_session).toBe(1600);
    expect(result.savings_pct).toBe(40);
  });

  it('returns 0 savings when after has more tool calls (negative savings)', () => {
    // before: 10 calls * 200 = 2000 tokens
    // after: 15 calls * 200 = 3000 tokens
    // savings: 0 (clamped, not negative)
    const comp = makeComparison(10, 15);
    const result = estimateTokenSavings(comp)!;

    expect(result.savings_per_session).toBe(0);
    expect(result.savings_pct).toBe(0);
  });

  it('handles zero tool calls in before bucket', () => {
    const comp = makeComparison(0, 10);
    const result = estimateTokenSavings(comp)!;

    expect(result.before_avg_tokens).toBe(0);
    expect(result.after_avg_tokens).toBe(2000);
    expect(result.savings_per_session).toBe(0); // clamped to 0
    expect(result.savings_pct).toBe(0); // can't divide by 0
  });

  it('handles zero tool calls in both buckets', () => {
    const comp = makeComparison(0, 0);
    const result = estimateTokenSavings(comp)!;

    expect(result.before_avg_tokens).toBe(0);
    expect(result.after_avg_tokens).toBe(0);
    expect(result.savings_per_session).toBe(0);
    expect(result.savings_pct).toBe(0);
  });

  it('uses TOKENS_PER_CALL constant (200)', () => {
    expect(TOKENS_PER_CALL).toBe(200);
  });

  it('prefers byte_counted when byte data is available', () => {
    const comp: BeforeAfterComparison = {
      cutoff: '2026-04-22T00:00:00Z',
      before: { sessions: 5, avg_duration_min: 10, avg_tool_calls: 20, avg_bash_failures: 2, avg_input_bytes: 4000, avg_output_bytes: 4000 },
      after: { sessions: 5, avg_duration_min: 8, avg_tool_calls: 12, avg_bash_failures: 1, avg_input_bytes: 2000, avg_output_bytes: 2000 },
      improvement: { duration_pct: -20, tool_calls_pct: -40, bash_failures_pct: -50 },
    };
    const result = estimateTokenSavings(comp)!;
    expect(result.method).toBe('byte_counted');
    // (4000+4000)/4 = 2000 tokens before, (2000+2000)/4 = 1000 tokens after
    expect(result.before_avg_tokens).toBe(2000);
    expect(result.after_avg_tokens).toBe(1000);
    expect(result.savings_per_session).toBe(1000);
  });

  it('falls back to heuristic when no byte data (old sessions)', () => {
    // Both avg_input_bytes and avg_output_bytes are 0 → fallback
    const comp = makeComparison(20, 12);
    const result = estimateTokenSavings(comp)!;
    expect(result.method).toBe('tool_call_heuristic');
  });
});

// ─── buildSessionSummaries byte counting ────────────────

describe('buildSessionSummaries byte counting', () => {
  it('sums input bytes from pre events', () => {
    const input = { command: 'npm test' };
    const expectedBytes = JSON.stringify(input).length;

    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        {
          event: 'pre',
          tool_use_id: 'tu1',
          tool: 'Bash',
          input,
          t: '2026-04-25T10:00:00Z',
        },
      ]),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.total_input_bytes).toBe(expectedBytes);
    expect(summaries[0]!.total_output_bytes).toBe(0);
  });

  it('sums output bytes from post events', () => {
    const output = { __untrusted: true, exitCode: 0, stdout: 'all tests passed' };
    const expectedBytes = JSON.stringify(output).length;

    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        {
          event: 'post',
          tool_use_id: 'tu1',
          tool: 'Bash',
          output,
          success: true,
          t: '2026-04-25T10:00:00Z',
        },
      ]),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.total_input_bytes).toBe(0);
    expect(summaries[0]!.total_output_bytes).toBe(expectedBytes);
  });

  it('sums bytes across multiple tool calls', () => {
    const input1 = { command: 'npm test' };
    const input2 = { file_path: '/tmp/a.ts' };
    const output1 = { __untrusted: true, exitCode: 0 };
    const output2 = { __untrusted: true };

    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        { event: 'pre', tool_use_id: 'tu1', tool: 'Bash', input: input1, t: '2026-04-25T10:00:00Z' },
        { event: 'post', tool_use_id: 'tu1', tool: 'Bash', output: output1, success: true, t: '2026-04-25T10:00:00Z' },
        { event: 'pre', tool_use_id: 'tu2', tool: 'Edit', input: input2, t: '2026-04-25T10:01:00Z' },
        { event: 'post', tool_use_id: 'tu2', tool: 'Edit', output: output2, success: true, t: '2026-04-25T10:01:00Z' },
      ]),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.total_input_bytes).toBe(
      JSON.stringify(input1).length + JSON.stringify(input2).length,
    );
    expect(summaries[0]!.total_output_bytes).toBe(
      JSON.stringify(output1).length + JSON.stringify(output2).length,
    );
  });

  it('handles pre events without input (0 bytes)', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        { event: 'pre', tool_use_id: 'tu1', tool: 'Read', t: '2026-04-25T10:00:00Z' },
      ]),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.total_input_bytes).toBe(0);
  });

  it('handles post events without output (0 bytes)', () => {
    const turns: TurnData[] = [
      makeTurn('t1', 's1', '2026-04-25T10:00:00Z', [
        { event: 'post', tool_use_id: 'tu1', tool: 'Read', success: true, t: '2026-04-25T10:00:00Z' },
      ]),
    ];

    const summaries = buildSessionSummaries(turns);
    expect(summaries[0]!.total_output_bytes).toBe(0);
  });
});

// ─── estimateTokenSavingsByBytes ──────────────────────

describe('estimateTokenSavingsByBytes', () => {
  it('returns null for null comparison', () => {
    expect(estimateTokenSavingsByBytes(null)).toBeNull();
  });

  it('returns null when both buckets have 0 bytes', () => {
    const comp: BeforeAfterComparison = {
      cutoff: '2026-04-22T00:00:00Z',
      before: { sessions: 5, avg_duration_min: 10, avg_tool_calls: 20, avg_bash_failures: 2, avg_input_bytes: 0, avg_output_bytes: 0 },
      after: { sessions: 5, avg_duration_min: 8, avg_tool_calls: 12, avg_bash_failures: 1, avg_input_bytes: 0, avg_output_bytes: 0 },
      improvement: { duration_pct: -20, tool_calls_pct: -40, bash_failures_pct: -50 },
    };
    expect(estimateTokenSavingsByBytes(comp)).toBeNull();
  });

  it('calculates token savings from byte data', () => {
    // before: (8000 + 4000) / 4 = 3000 tokens
    // after: (4000 + 2000) / 4 = 1500 tokens
    // savings: 1500 tokens, 50%
    const comp: BeforeAfterComparison = {
      cutoff: '2026-04-22T00:00:00Z',
      before: { sessions: 5, avg_duration_min: 10, avg_tool_calls: 20, avg_bash_failures: 2, avg_input_bytes: 8000, avg_output_bytes: 4000 },
      after: { sessions: 5, avg_duration_min: 8, avg_tool_calls: 12, avg_bash_failures: 1, avg_input_bytes: 4000, avg_output_bytes: 2000 },
      improvement: { duration_pct: -20, tool_calls_pct: -40, bash_failures_pct: -50 },
    };
    const result = estimateTokenSavingsByBytes(comp)!;

    expect(result.method).toBe('byte_counted');
    // afterAvgTokens=1500, avg_tool_calls=12 → ceil(1500/12)=125
    expect(result.tokens_per_call).toBe(125);
    expect(result.before_avg_tokens).toBe(3000);
    expect(result.after_avg_tokens).toBe(1500);
    expect(result.savings_per_session).toBe(1500);
    expect(result.savings_pct).toBe(50);
  });

  it('clamps negative savings to 0', () => {
    // after has more bytes than before
    const comp: BeforeAfterComparison = {
      cutoff: '2026-04-22T00:00:00Z',
      before: { sessions: 5, avg_duration_min: 10, avg_tool_calls: 10, avg_bash_failures: 2, avg_input_bytes: 1000, avg_output_bytes: 1000 },
      after: { sessions: 5, avg_duration_min: 8, avg_tool_calls: 15, avg_bash_failures: 1, avg_input_bytes: 5000, avg_output_bytes: 5000 },
      improvement: { duration_pct: -20, tool_calls_pct: 50, bash_failures_pct: -50 },
    };
    const result = estimateTokenSavingsByBytes(comp)!;

    expect(result.savings_per_session).toBe(0);
    expect(result.savings_pct).toBe(0);
  });

  it('uses Math.ceil for token conversion', () => {
    // 5 bytes / 4 = 1.25 → ceil → 2 tokens
    const comp: BeforeAfterComparison = {
      cutoff: '2026-04-22T00:00:00Z',
      before: { sessions: 2, avg_duration_min: 10, avg_tool_calls: 1, avg_bash_failures: 0, avg_input_bytes: 5, avg_output_bytes: 0 },
      after: { sessions: 2, avg_duration_min: 8, avg_tool_calls: 1, avg_bash_failures: 0, avg_input_bytes: 1, avg_output_bytes: 0 },
      improvement: { duration_pct: -20, tool_calls_pct: 0, bash_failures_pct: 0 },
    };
    const result = estimateTokenSavingsByBytes(comp)!;
    expect(result.before_avg_tokens).toBe(2); // ceil(5/4)
    expect(result.after_avg_tokens).toBe(1); // ceil(1/4)
  });

  it('produces different results than heuristic for same comparison', () => {
    // Byte-counted: (8000+4000)/4 = 3000, (2000+1000)/4 = 750
    // Heuristic: 20*200 = 4000, 12*200 = 2400
    const comp: BeforeAfterComparison = {
      cutoff: '2026-04-22T00:00:00Z',
      before: { sessions: 5, avg_duration_min: 10, avg_tool_calls: 20, avg_bash_failures: 2, avg_input_bytes: 8000, avg_output_bytes: 4000 },
      after: { sessions: 5, avg_duration_min: 8, avg_tool_calls: 12, avg_bash_failures: 1, avg_input_bytes: 2000, avg_output_bytes: 1000 },
      improvement: { duration_pct: -20, tool_calls_pct: -40, bash_failures_pct: -50 },
    };
    const byteResult = estimateTokenSavingsByBytes(comp)!;
    // Heuristic would give 4000/2400 = 1600 savings
    // Byte-counted gives 3000/750 = 2250 savings
    expect(byteResult.before_avg_tokens).not.toBe(20 * TOKENS_PER_CALL);
    expect(byteResult.method).toBe('byte_counted');
  });
});

// ─── CHARS_PER_TOKEN constant ───────────────────────────

describe('CHARS_PER_TOKEN', () => {
  it('equals 4', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });
});

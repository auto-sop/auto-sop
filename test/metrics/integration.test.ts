import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSessionSummaries, compareBeforeAfter } from '../../src/learner/session-metrics.js';
import { aggregateMetrics, toMetricsState } from '../../src/metrics/aggregator.js';
import { extractTokenSavings } from '../../src/metrics/token-extractor.js';
import { computeErrorPreventionMetrics } from '../../src/metrics/error-prevention.js';
import { calculateTimeSavings } from '../../src/metrics/time-savings.js';
import { toCloudSyncFormat, isValidSyncPayload } from '../../src/metrics/sync-format.js';
import { saveMetricsState, loadMetricsState } from '../../src/metrics/state.js';
import type { TurnData, ToolCall } from '../../src/learner/turn-loader.js';
import type { PreventedError } from '../../src/learner/error-prevention.js';

function makeTurn(
  turnId: string,
  sessionId: string,
  finalizedAt: string,
  toolCalls: ToolCall[] = [],
): TurnData {
  return { turn_id: turnId, session_id: sessionId, agent: 'main', finalized_at: finalizedAt, tool_calls: toolCalls };
}

function makeBashPair(useId: string, command: string, success: boolean, t: string): ToolCall[] {
  return [
    { event: 'pre', tool_use_id: useId, tool: 'Bash', input: { command }, t },
    { event: 'post', tool_use_id: useId, tool: 'Bash', output: { __untrusted: true, exitCode: success ? 0 : 1 }, success, t },
  ];
}

function makeEditPair(useId: string, t: string): ToolCall[] {
  return [
    { event: 'pre', tool_use_id: useId, tool: 'Edit', input: { file_path: '/tmp/a.ts' }, t },
    { event: 'post', tool_use_id: useId, tool: 'Edit', output: { __untrusted: true }, success: true, t },
  ];
}

describe('Full Metrics Pipeline Integration', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'metrics-int-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('end-to-end: captures → session summaries → comparison → metrics → state → sync format', async () => {
    // Step 1: Create "before" captures (long sessions, many tool calls, bash failures)
    const beforeTurns: TurnData[] = [
      makeTurn('t1', 'before-s1', '2026-04-15T10:00:00Z', [
        ...makeBashPair('u1', 'npm test', false, '2026-04-15T10:00:00Z'),
        ...makeBashPair('u2', 'npm test', false, '2026-04-15T10:01:00Z'),
        ...makeEditPair('u3', '2026-04-15T10:02:00Z'),
        ...makeEditPair('u4', '2026-04-15T10:03:00Z'),
        ...makeEditPair('u5', '2026-04-15T10:04:00Z'),
      ]),
      makeTurn('t2', 'before-s1', '2026-04-15T10:30:00Z', [
        ...makeBashPair('u6', 'npm test', true, '2026-04-15T10:30:00Z'),
        ...makeEditPair('u7', '2026-04-15T10:31:00Z'),
      ]),
      makeTurn('t3', 'before-s2', '2026-04-16T10:00:00Z', [
        ...makeBashPair('u8', 'npm test', false, '2026-04-16T10:00:00Z'),
        ...makeBashPair('u9', 'npm run build', false, '2026-04-16T10:01:00Z'),
        ...makeEditPair('u10', '2026-04-16T10:02:00Z'),
        ...makeEditPair('u11', '2026-04-16T10:03:00Z'),
      ]),
      makeTurn('t4', 'before-s2', '2026-04-16T10:25:00Z', [
        ...makeBashPair('u12', 'npm test', true, '2026-04-16T10:25:00Z'),
      ]),
    ];

    // Step 2: Create "after" captures (shorter sessions, fewer tool calls, no bash failures)
    const afterTurns: TurnData[] = [
      makeTurn('t5', 'after-s1', '2026-04-20T10:00:00Z', [
        ...makeBashPair('u13', 'npm test', true, '2026-04-20T10:00:00Z'),
        ...makeEditPair('u14', '2026-04-20T10:01:00Z'),
      ]),
      makeTurn('t6', 'after-s1', '2026-04-20T10:10:00Z', [
        ...makeBashPair('u15', 'npm test', true, '2026-04-20T10:10:00Z'),
      ]),
      makeTurn('t7', 'after-s2', '2026-04-21T10:00:00Z', [
        ...makeBashPair('u16', 'npm test', true, '2026-04-21T10:00:00Z'),
        ...makeEditPair('u17', '2026-04-21T10:01:00Z'),
      ]),
      makeTurn('t8', 'after-s2', '2026-04-21T10:08:00Z', [
        ...makeBashPair('u18', 'npm run build', true, '2026-04-21T10:08:00Z'),
      ]),
    ];

    // Step 3: Build session summaries
    const allTurns = [...beforeTurns, ...afterTurns];
    const sessions = buildSessionSummaries(allTurns);
    expect(sessions.length).toBe(4); // 2 before + 2 after

    // Step 4: Before/after comparison with cutoff at directive creation
    const cutoff = '2026-04-18T00:00:00Z';
    const comparison = compareBeforeAfter(sessions, cutoff);
    expect(comparison).not.toBeNull();
    expect(comparison!.before.sessions).toBe(2);
    expect(comparison!.after.sessions).toBe(2);

    // After sessions should have fewer bash failures than before
    expect(comparison!.after.avg_bash_failures).toBeLessThanOrEqual(comparison!.before.avg_bash_failures);

    // Step 5: Create prevented error events (npm test succeeded after directive)
    const preventedErrors: PreventedError[] = [
      {
        t: '2026-04-20T10:00:00.000Z',
        directive_id: 'dir-bash-npm-test',
        source_fingerprint: 'npm test',
        session_id: 'after-s1',
        command_preview: 'npm test',
      },
      {
        t: '2026-04-21T10:00:00.000Z',
        directive_id: 'dir-bash-npm-test',
        source_fingerprint: 'npm test',
        session_id: 'after-s2',
        command_preview: 'npm test',
      },
    ];

    // Step 6: Run metrics aggregator
    const now = new Date('2026-04-22T12:00:00.000Z');
    const metrics = aggregateMetrics({
      projectSlug: 'integration-test',
      comparison,
      preventedErrors,
      now,
    });

    // Verify token savings
    expect(metrics.tokenSavings).not.toBeNull();
    expect(metrics.tokenSavings!.total_savings_per_session).toBeGreaterThanOrEqual(0);
    // Conservative: never negative
    expect(metrics.tokenSavings!.total_savings_per_session).toBeGreaterThanOrEqual(0);

    // Verify error prevention
    expect(metrics.errorPrevention.total_prevented).toBe(2);
    expect(metrics.errorPrevention.by_directive['dir-bash-npm-test']).toBe(2);
    expect(metrics.errorPrevention.this_month).toBe(2);

    // Verify time savings (conservative)
    expect(metrics.timeSavings).not.toBeNull();
    expect(metrics.timeSavings!.total_minutes_saved).toBeGreaterThanOrEqual(0);

    // Step 7: Convert to state and persist
    const state = toMetricsState('integration-test', metrics, [], now);
    expect(state.v).toBe(1);
    expect(state.project_slug).toBe('integration-test');
    expect(state.total_errors_prevented).toBe(2);

    await saveMetricsState(tmpHome, '/test/project', state);
    const loaded = loadMetricsState(tmpHome, '/test/project');
    expect(loaded).not.toBeNull();
    expect(loaded!.total_errors_prevented).toBe(2);
    expect(loaded!.project_slug).toBe('integration-test');

    // Step 8: Cloud sync format
    const syncPayload = toCloudSyncFormat(loaded, now);
    expect(syncPayload).not.toBeNull();
    expect(isValidSyncPayload(syncPayload)).toBe(true);
    expect(syncPayload!.project_slug).toBe('integration-test');
    expect(syncPayload!.period).toBe('2026-04');
    expect(syncPayload!.errors_prevented).toBe(2);
  });

  it('metrics are conservative: never negative or inflated', () => {
    // Scenario where after is WORSE than before
    const worseTurns: TurnData[] = [
      makeTurn('t1', 'before-s1', '2026-04-15T10:00:00Z', [
        ...makeBashPair('u1', 'npm test', true, '2026-04-15T10:00:00Z'),
      ]),
      makeTurn('t2', 'before-s1', '2026-04-15T10:05:00Z', []),
      makeTurn('t3', 'before-s2', '2026-04-16T10:00:00Z', [
        ...makeBashPair('u2', 'npm test', true, '2026-04-16T10:00:00Z'),
      ]),
      makeTurn('t4', 'before-s2', '2026-04-16T10:05:00Z', []),
      // After: more tool calls, longer sessions
      makeTurn('t5', 'after-s1', '2026-04-20T10:00:00Z', [
        ...makeBashPair('u3', 'npm test', false, '2026-04-20T10:00:00Z'),
        ...makeBashPair('u4', 'npm test', false, '2026-04-20T10:01:00Z'),
        ...makeEditPair('u5', '2026-04-20T10:02:00Z'),
        ...makeEditPair('u6', '2026-04-20T10:03:00Z'),
        ...makeEditPair('u7', '2026-04-20T10:04:00Z'),
      ]),
      makeTurn('t6', 'after-s1', '2026-04-20T10:30:00Z', [
        ...makeBashPair('u8', 'npm test', true, '2026-04-20T10:30:00Z'),
      ]),
      makeTurn('t7', 'after-s2', '2026-04-21T10:00:00Z', [
        ...makeBashPair('u9', 'npm test', false, '2026-04-21T10:00:00Z'),
        ...makeEditPair('u10', '2026-04-21T10:02:00Z'),
        ...makeEditPair('u11', '2026-04-21T10:03:00Z'),
      ]),
      makeTurn('t8', 'after-s2', '2026-04-21T10:25:00Z', []),
    ];

    const sessions = buildSessionSummaries(worseTurns);
    const comparison = compareBeforeAfter(sessions, '2026-04-18T00:00:00Z');
    expect(comparison).not.toBeNull();

    const metrics = aggregateMetrics({
      projectSlug: 'worse-project',
      comparison,
      preventedErrors: [],
    });

    // Token savings must never be negative
    if (metrics.tokenSavings) {
      expect(metrics.tokenSavings.total_savings_per_session).toBeGreaterThanOrEqual(0);
      expect(metrics.tokenSavings.total_savings_pct).toBeGreaterThanOrEqual(0);
    }

    // Time savings must never be negative
    if (metrics.timeSavings) {
      expect(metrics.timeSavings.total_minutes_saved).toBeGreaterThanOrEqual(0);
      expect(metrics.timeSavings.per_session_minutes).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles empty pipeline input', () => {
    const metrics = aggregateMetrics({
      projectSlug: 'empty-project',
      comparison: null,
      preventedErrors: [],
    });

    expect(metrics.tokenSavings).toBeNull();
    expect(metrics.timeSavings).toBeNull();
    expect(metrics.errorPrevention.total_prevented).toBe(0);

    const state = toMetricsState('empty-project', metrics);
    expect(state.total_tokens_saved).toBe(0);
    expect(state.total_errors_prevented).toBe(0);
    expect(state.total_time_saved_minutes).toBe(0);

    const syncPayload = toCloudSyncFormat(state);
    expect(syncPayload).not.toBeNull();
    expect(isValidSyncPayload(syncPayload)).toBe(true);
    expect(syncPayload!.token_savings).toBe(0);
    expect(syncPayload!.errors_prevented).toBe(0);
  });
});

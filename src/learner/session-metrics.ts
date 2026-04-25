/**
 * Session Metrics — computes per-session summaries and before/after
 * comparisons from turn data.
 *
 * Used by the learner tick to track how directive adoption affects
 * session quality (duration, tool calls, bash failures).
 */
import type { TurnData, ToolCall } from './turn-loader.js';
import { isBashFailure } from './command-fingerprint.js';

// ─── Types ───────────────────────────────────────────────

export interface SessionSummary {
  session_id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  turn_count: number;
  tool_call_count: number;
  files_changed_count: number;
  bash_failure_count: number;
}

export interface BucketStats {
  sessions: number;
  avg_duration_min: number;
  avg_tool_calls: number;
  avg_bash_failures: number;
}

export interface BeforeAfterComparison {
  cutoff: string;
  before: BucketStats;
  after: BucketStats;
  improvement: {
    duration_pct: number;
    tool_calls_pct: number;
    bash_failures_pct: number;
  };
}

// ─── Session summaries ──────────────────────────────────

/**
 * Group turns by session_id and compute per-session summaries.
 *
 * For bash failures: match pre/post by tool_use_id, check success === false
 * on post events where the matching pre event has tool === 'Bash'.
 *
 * Returns sessions sorted by started_at ascending.
 */
export function buildSessionSummaries(turns: TurnData[]): SessionSummary[] {
  // Group turns by session_id
  const groups = new Map<string, TurnData[]>();
  for (const turn of turns) {
    const arr = groups.get(turn.session_id) ?? [];
    arr.push(turn);
    groups.set(turn.session_id, arr);
  }

  const summaries: SessionSummary[] = [];

  for (const [sessionId, sessionTurns] of groups) {
    // Sort turns by finalized_at within session
    sessionTurns.sort((a, b) => a.finalized_at.localeCompare(b.finalized_at));

    const startedAt = sessionTurns[0]!.finalized_at;
    const endedAt = sessionTurns[sessionTurns.length - 1]!.finalized_at;
    const durationMs = Date.parse(endedAt) - Date.parse(startedAt);

    let toolCallCount = 0;
    let bashFailureCount = 0;
    let filesChangedCount = 0;

    for (const turn of sessionTurns) {
      // Build pre-event index for this turn
      const preByUseId = new Map<string, ToolCall>();
      for (const call of turn.tool_calls) {
        if (call.event === 'pre') {
          preByUseId.set(call.tool_use_id, call);
        }
      }

      // Count tool calls (pre events = individual tool invocations)
      for (const call of turn.tool_calls) {
        if (call.event === 'pre') {
          toolCallCount++;
        }
      }

      // Count bash failures
      for (const call of turn.tool_calls) {
        if (call.event !== 'post') continue;
        const pre = preByUseId.get(call.tool_use_id);
        if (!pre || pre.tool !== 'Bash') continue;
        if (isBashFailure(call)) {
          bashFailureCount++;
        }
      }

      // Count file changes from Edit/Write pre events
      for (const call of turn.tool_calls) {
        if (call.event === 'pre' && (call.tool === 'Edit' || call.tool === 'Write')) {
          filesChangedCount++;
        }
      }
    }

    summaries.push({
      session_id: sessionId,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Math.max(0, durationMs),
      turn_count: sessionTurns.length,
      tool_call_count: toolCallCount,
      files_changed_count: filesChangedCount,
      bash_failure_count: bashFailureCount,
    });
  }

  // Sort by started_at ascending
  summaries.sort((a, b) => a.started_at.localeCompare(b.started_at));

  return summaries;
}

// ─── Before/after comparison ────────────────────────────

/**
 * Split sessions at a cutoff timestamp and compute before/after averages.
 * Returns null if either bucket has fewer than 2 sessions (not enough data).
 *
 * Improvement percentages: negative = improvement (reduction).
 * E.g. duration_pct = -20 means 20% shorter after the cutoff.
 */
export function compareBeforeAfter(
  sessions: SessionSummary[],
  cutoff: string,
): BeforeAfterComparison | null {
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs)) return null;

  const before: SessionSummary[] = [];
  const after: SessionSummary[] = [];

  for (const s of sessions) {
    const startMs = Date.parse(s.started_at);
    if (startMs < cutoffMs) {
      before.push(s);
    } else {
      after.push(s);
    }
  }

  // Need at least 2 sessions in each bucket for meaningful comparison
  if (before.length < 2 || after.length < 2) return null;

  const beforeStats = computeBucketStats(before);
  const afterStats = computeBucketStats(after);

  return {
    cutoff,
    before: beforeStats,
    after: afterStats,
    improvement: {
      duration_pct: pctChange(beforeStats.avg_duration_min, afterStats.avg_duration_min),
      tool_calls_pct: pctChange(beforeStats.avg_tool_calls, afterStats.avg_tool_calls),
      bash_failures_pct: pctChange(beforeStats.avg_bash_failures, afterStats.avg_bash_failures),
    },
  };
}

// ─── Helpers ────────────────────────────────────────────

function computeBucketStats(sessions: SessionSummary[]): BucketStats {
  const n = sessions.length;
  if (n === 0) return { sessions: 0, avg_duration_min: 0, avg_tool_calls: 0, avg_bash_failures: 0 };

  const totalDurationMin = sessions.reduce((sum, s) => sum + s.duration_ms / 60_000, 0);
  const totalToolCalls = sessions.reduce((sum, s) => sum + s.tool_call_count, 0);
  const totalBashFailures = sessions.reduce((sum, s) => sum + s.bash_failure_count, 0);

  return {
    sessions: n,
    avg_duration_min: round2(totalDurationMin / n),
    avg_tool_calls: round2(totalToolCalls / n),
    avg_bash_failures: round2(totalBashFailures / n),
  };
}

function pctChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : 100;
  return round2(((after - before) / before) * 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

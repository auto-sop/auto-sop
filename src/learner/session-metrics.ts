/**
 * Session Metrics — computes per-session summaries and before/after
 * comparisons from turn data.
 *
 * Used by the learner tick to track how directive adoption affects
 * session quality (duration, tool calls, bash failures).
 */
import type { TurnData, ToolCall } from './turn-loader.js';
import { isBashFailure } from './command-fingerprint.js';

// ─── Constants ──────────────────────────────────────────

/**
 * Conservative estimate of tokens consumed per tool call.
 * Used for M2 heuristic-based token savings estimation.
 * Based on average tool call input+output across typical sessions.
 */
export const TOKENS_PER_CALL = 200;

/**
 * Industry-standard approximation: 1 token ≈ 4 characters.
 * Used by byte_counted token estimation to convert raw byte counts
 * into approximate token counts.
 */
export const CHARS_PER_TOKEN = 4;

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
  total_input_bytes: number;
  total_output_bytes: number;
}

export interface BucketStats {
  sessions: number;
  avg_duration_min: number;
  avg_tool_calls: number;
  avg_bash_failures: number;
  avg_input_bytes: number;
  avg_output_bytes: number;
}

export interface TokenEstimate {
  method: 'tool_call_heuristic' | 'byte_counted' | 'hybrid';
  tokens_per_call: number;
  before_avg_tokens: number;
  after_avg_tokens: number;
  savings_per_session: number;
  savings_pct: number;
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
    let totalInputBytes = 0;
    let totalOutputBytes = 0;

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

      // Sum byte sizes from tool call input/output
      for (const call of turn.tool_calls) {
        if (call.event === 'pre' && call.input) {
          totalInputBytes += JSON.stringify(call.input).length;
        } else if (call.event === 'post' && call.output) {
          totalOutputBytes += JSON.stringify(call.output).length;
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
      total_input_bytes: totalInputBytes,
      total_output_bytes: totalOutputBytes,
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
  if (n === 0) return { sessions: 0, avg_duration_min: 0, avg_tool_calls: 0, avg_bash_failures: 0, avg_input_bytes: 0, avg_output_bytes: 0 };

  const totalDurationMin = sessions.reduce((sum, s) => sum + s.duration_ms / 60_000, 0);
  const totalToolCalls = sessions.reduce((sum, s) => sum + s.tool_call_count, 0);
  const totalBashFailures = sessions.reduce((sum, s) => sum + s.bash_failure_count, 0);
  const totalInputBytes = sessions.reduce((sum, s) => sum + s.total_input_bytes, 0);
  const totalOutputBytes = sessions.reduce((sum, s) => sum + s.total_output_bytes, 0);

  return {
    sessions: n,
    avg_duration_min: round2(totalDurationMin / n),
    avg_tool_calls: round2(totalToolCalls / n),
    avg_bash_failures: round2(totalBashFailures / n),
    avg_input_bytes: round2(totalInputBytes / n),
    avg_output_bytes: round2(totalOutputBytes / n),
  };
}

function pctChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : 100;
  return round2(((after - before) / before) * 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Token estimation ─────────────────────────────────────

/**
 * Estimate token savings using real byte data from session summaries.
 * Uses CHARS_PER_TOKEN to convert byte counts into approximate token counts.
 *
 * Returns null if:
 * - comparison is null or has empty buckets
 * - both buckets have 0 avg bytes (no byte data available — old sessions)
 */
export function estimateTokenSavingsByBytes(
  comparison: BeforeAfterComparison | null,
): TokenEstimate | null {
  if (!comparison) return null;
  if (comparison.before.sessions === 0 || comparison.after.sessions === 0) return null;

  const beforeTotalBytes = comparison.before.avg_input_bytes + comparison.before.avg_output_bytes;
  const afterTotalBytes = comparison.after.avg_input_bytes + comparison.after.avg_output_bytes;

  // No byte data in either bucket — can't use this method
  if (beforeTotalBytes === 0 && afterTotalBytes === 0) return null;

  const beforeAvgTokens = Math.ceil(beforeTotalBytes / CHARS_PER_TOKEN);
  const afterAvgTokens = Math.ceil(afterTotalBytes / CHARS_PER_TOKEN);
  const savingsPerSession = Math.max(0, beforeAvgTokens - afterAvgTokens);
  const savingsPct = beforeAvgTokens === 0 ? 0 : round2((savingsPerSession / beforeAvgTokens) * 100);

  const afterTokensPerCall = comparison.after.avg_tool_calls > 0
    ? Math.ceil(afterAvgTokens / comparison.after.avg_tool_calls)
    : 0;

  return {
    method: 'byte_counted',
    tokens_per_call: afterTokensPerCall,
    before_avg_tokens: beforeAvgTokens,
    after_avg_tokens: afterAvgTokens,
    savings_per_session: savingsPerSession,
    savings_pct: savingsPct,
  };
}

/**
 * Estimate token savings from a before/after comparison.
 *
 * Strategy:
 * 1. Prefer byte_counted when byte data yields positive savings.
 * 2. If byte_counted yields savings_per_session <= 0 but tool calls dropped
 *    by 20%+ (tool_calls_pct < -20), fall back to a hybrid method that
 *    estimates savings from tool-call reduction using byte-derived cost
 *    per call when available.
 * 3. If no byte data at all, fall back to tool_call_heuristic.
 *
 * Returns null if the comparison is null or either bucket has 0 sessions
 * (insufficient data for a meaningful estimate).
 */
export function estimateTokenSavings(
  comparison: BeforeAfterComparison | null,
): TokenEstimate | null {
  if (!comparison) return null;
  if (comparison.before.sessions === 0 || comparison.after.sessions === 0) return null;

  // Prefer byte_counted when byte data is available
  const byteEstimate = estimateTokenSavingsByBytes(comparison);
  if (byteEstimate) {
    // Byte-counted produced a positive result — use it directly
    if (byteEstimate.savings_per_session > 0) return byteEstimate;

    // Byte-counted produced 0 savings (output bytes grew despite improvements).
    // Check if tool calls dropped significantly — if so, use hybrid.
    if (comparison.improvement.tool_calls_pct < -20) {
      return estimateHybridSavings(comparison);
    }
    // Tool calls didn't drop enough — return the zero-savings byte estimate
    return byteEstimate;
  }

  // Fallback: heuristic for old sessions without byte data
  const beforeAvgTokens = round2(comparison.before.avg_tool_calls * TOKENS_PER_CALL);
  const afterAvgTokens = round2(comparison.after.avg_tool_calls * TOKENS_PER_CALL);
  const savingsPerSession = Math.max(0, round2(beforeAvgTokens - afterAvgTokens));
  const savingsPct = beforeAvgTokens === 0 ? 0 : round2((savingsPerSession / beforeAvgTokens) * 100);

  return {
    method: 'tool_call_heuristic',
    tokens_per_call: TOKENS_PER_CALL,
    before_avg_tokens: beforeAvgTokens,
    after_avg_tokens: afterAvgTokens,
    savings_per_session: savingsPerSession,
    savings_pct: savingsPct,
  };
}

/**
 * Hybrid estimation: byte_counted showed 0 savings (output bytes grew),
 * but tool calls dropped significantly. Estimate savings from the
 * tool-call reduction using byte-derived tokens-per-call when possible,
 * falling back to the constant TOKENS_PER_CALL.
 */
function estimateHybridSavings(comparison: BeforeAfterComparison): TokenEstimate {
  const beforeTotalBytes = comparison.before.avg_input_bytes + comparison.before.avg_output_bytes;

  // Derive tokens-per-call from before-bucket byte data when available
  const tokensPerCall = comparison.before.avg_tool_calls > 0 && beforeTotalBytes > 0
    ? Math.ceil(beforeTotalBytes / CHARS_PER_TOKEN / comparison.before.avg_tool_calls)
    : TOKENS_PER_CALL;

  const beforeAvgTokens = Math.round(comparison.before.avg_tool_calls * tokensPerCall);
  const afterAvgTokens = Math.round(comparison.after.avg_tool_calls * tokensPerCall);
  const savingsPerSession = Math.max(0, beforeAvgTokens - afterAvgTokens);
  const savingsPct = beforeAvgTokens === 0 ? 0 : round2((savingsPerSession / beforeAvgTokens) * 100);

  return {
    method: 'hybrid',
    tokens_per_call: tokensPerCall,
    before_avg_tokens: beforeAvgTokens,
    after_avg_tokens: afterAvgTokens,
    savings_per_session: savingsPerSession,
    savings_pct: savingsPct,
  };
}

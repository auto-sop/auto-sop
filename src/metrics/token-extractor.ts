import type { SessionSummary, BeforeAfterComparison } from '../learner/session-metrics.js';
import { TOKENS_PER_CALL } from '../learner/session-metrics.js';

// Conservative estimate of tokens per turn (prompt + response overhead).
const TOKENS_PER_TURN = 800;

export interface TokenDelta {
  directive_id: string;
  before_avg_tokens: number;
  after_avg_tokens: number;
  savings_per_session: number;
  savings_pct: number;
}

export interface TokenExtractionResult {
  total_before_avg: number;
  total_after_avg: number;
  total_savings_per_session: number;
  total_savings_pct: number;
  method: 'session_comparison';
  tokens_per_call: number;
  tokens_per_turn: number;
}

/**
 * Extract token usage estimates from session summaries by comparing
 * before/after directive adoption. Uses tool_call_count * TOKENS_PER_CALL
 * + turn_count * TOKENS_PER_TURN as a conservative proxy.
 *
 * Returns null when the comparison has insufficient data.
 */
export function extractTokenSavings(
  comparison: BeforeAfterComparison | null,
): TokenExtractionResult | null {
  if (!comparison) return null;
  if (comparison.before.sessions < 2 || comparison.after.sessions < 2) return null;

  const beforeAvg = estimateSessionTokens(
    comparison.before.avg_tool_calls,
    0, // turn count not in BucketStats; use tool calls only
  );
  const afterAvg = estimateSessionTokens(comparison.after.avg_tool_calls, 0);

  const savings = Math.max(0, round2(beforeAvg - afterAvg));
  const pct = beforeAvg === 0 ? 0 : round2((savings / beforeAvg) * 100);

  return {
    total_before_avg: round2(beforeAvg),
    total_after_avg: round2(afterAvg),
    total_savings_per_session: savings,
    total_savings_pct: pct,
    method: 'session_comparison',
    tokens_per_call: TOKENS_PER_CALL,
    tokens_per_turn: TOKENS_PER_TURN,
  };
}

/**
 * Compute per-directive token deltas from sessions that were active
 * before/after a specific directive was created.
 */
export function computePerDirectiveTokenDelta(
  beforeSessions: SessionSummary[],
  afterSessions: SessionSummary[],
  directiveId: string,
): TokenDelta | null {
  if (beforeSessions.length < 2 || afterSessions.length < 2) return null;

  const beforeAvg = avgTokensForSessions(beforeSessions);
  const afterAvg = avgTokensForSessions(afterSessions);
  const savings = Math.max(0, round2(beforeAvg - afterAvg));
  const pct = beforeAvg === 0 ? 0 : round2((savings / beforeAvg) * 100);

  return {
    directive_id: directiveId,
    before_avg_tokens: round2(beforeAvg),
    after_avg_tokens: round2(afterAvg),
    savings_per_session: savings,
    savings_pct: pct,
  };
}

function avgTokensForSessions(sessions: SessionSummary[]): number {
  if (sessions.length === 0) return 0;
  const total = sessions.reduce(
    (sum, s) => sum + estimateSessionTokens(s.tool_call_count, s.turn_count),
    0,
  );
  return total / sessions.length;
}

function estimateSessionTokens(toolCalls: number, turns: number): number {
  return toolCalls * TOKENS_PER_CALL + turns * TOKENS_PER_TURN;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

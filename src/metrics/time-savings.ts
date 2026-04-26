import type { SessionSummary, BeforeAfterComparison } from '../learner/session-metrics.js';

export interface TimeSavingsResult {
  total_minutes_saved: number;
  per_session_minutes: number;
  sessions_after: number;
  method: 'duration_comparison';
}

export interface PerDirectiveTimeSavings {
  directive_id: string;
  minutes_saved: number;
  sessions_compared: number;
}

/**
 * Calculate conservative time savings from before/after session comparison.
 *
 * Formula: time_saved = (avg_before_duration - avg_after_duration) * sessions_after
 * Only reports positive savings (never claims negative time saved).
 *
 * Returns null when comparison is null or either bucket has < 2 sessions.
 */
export function calculateTimeSavings(
  comparison: BeforeAfterComparison | null,
): TimeSavingsResult | null {
  if (!comparison) return null;
  if (comparison.before.sessions < 2 || comparison.after.sessions < 2) return null;

  const beforeAvgMin = comparison.before.avg_duration_min;
  const afterAvgMin = comparison.after.avg_duration_min;

  // Conservative: only count savings when after is shorter
  const perSessionSavings = Math.max(0, round2(beforeAvgMin - afterAvgMin));
  const totalSaved = round2(perSessionSavings * comparison.after.sessions);

  return {
    total_minutes_saved: totalSaved,
    per_session_minutes: perSessionSavings,
    sessions_after: comparison.after.sessions,
    method: 'duration_comparison',
  };
}

/**
 * Compute per-directive time savings by splitting sessions at each
 * directive's first_seen timestamp and comparing avg durations.
 *
 * Conservative: only reports non-negative savings. Returns empty array
 * when no directive shows improvement.
 */
export function computePerDirectiveTimeSavings(
  sessions: SessionSummary[],
  directives: Array<{ directive_id: string; first_seen: string }>,
): PerDirectiveTimeSavings[] {
  if (sessions.length < 4) return []; // need >= 2 before + 2 after

  const results: PerDirectiveTimeSavings[] = [];

  for (const directive of directives) {
    const cutoffMs = Date.parse(directive.first_seen);
    if (!Number.isFinite(cutoffMs)) continue;

    const before = sessions.filter((s) => Date.parse(s.started_at) < cutoffMs);
    const after = sessions.filter((s) => Date.parse(s.started_at) >= cutoffMs);

    if (before.length < 2 || after.length < 2) continue;

    const beforeAvg = avgDurationMin(before);
    const afterAvg = avgDurationMin(after);
    const saved = Math.max(0, round2(beforeAvg - afterAvg));

    if (saved > 0) {
      results.push({
        directive_id: directive.directive_id,
        minutes_saved: saved,
        sessions_compared: before.length + after.length,
      });
    }
  }

  return results;
}

function avgDurationMin(sessions: SessionSummary[]): number {
  if (sessions.length === 0) return 0;
  const total = sessions.reduce((sum, s) => sum + s.duration_ms / 60_000, 0);
  return total / sessions.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

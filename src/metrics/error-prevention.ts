import type { PreventedError } from '../learner/error-prevention.js';

export interface ErrorPreventionMetrics {
  total_prevented: number;
  by_directive: Record<string, number>;
  this_month: number;
  this_week: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute error prevention metrics from prevented-error events.
 *
 * Counts total prevented errors, per-directive breakdown, and
 * period-filtered counts (this month, this week). Only counts
 * events whose timestamps are valid ISO strings.
 */
export function computeErrorPreventionMetrics(
  events: PreventedError[],
  now: Date = new Date(),
): ErrorPreventionMetrics {
  const nowMs = now.getTime();
  const weekAgoMs = nowMs - 7 * MS_PER_DAY;
  const monthAgoMs = nowMs - 30 * MS_PER_DAY;

  let total = 0;
  let thisMonth = 0;
  let thisWeek = 0;
  const byDirective: Record<string, number> = Object.create(null) as Record<string, number>;

  for (const event of events) {
    const eventMs = Date.parse(event.t);
    if (!Number.isFinite(eventMs)) continue;

    total++;

    if (byDirective[event.directive_id] === undefined) {
      byDirective[event.directive_id] = 0;
    }
    byDirective[event.directive_id]!++;

    if (eventMs >= monthAgoMs) thisMonth++;
    if (eventMs >= weekAgoMs) thisWeek++;
  }

  return {
    total_prevented: total,
    by_directive: byDirective,
    this_month: thisMonth,
    this_week: thisWeek,
  };
}

/**
 * Count prevented errors since a given cutoff date.
 * Returns 0 for empty input or when no events pass the filter.
 */
export function countPreventedSince(events: PreventedError[], since: string): number {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return 0;

  let count = 0;
  for (const event of events) {
    const eventMs = Date.parse(event.t);
    if (Number.isFinite(eventMs) && eventMs >= sinceMs) {
      count++;
    }
  }
  return count;
}

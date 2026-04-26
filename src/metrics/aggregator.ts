import type { BeforeAfterComparison } from '../learner/session-metrics.js';
import type { PreventedError } from '../learner/error-prevention.js';
import { extractTokenSavings, type TokenExtractionResult } from './token-extractor.js';
import { computeErrorPreventionMetrics, type ErrorPreventionMetrics } from './error-prevention.js';
import { calculateTimeSavings, type TimeSavingsResult } from './time-savings.js';
import type { MetricsState, DirectiveAttribution } from './state.js';

export interface AggregateMetricsInput {
  projectSlug: string;
  comparison: BeforeAfterComparison | null;
  preventedErrors: PreventedError[];
  directiveAttributions?: DirectiveAttribution[];
  now?: Date;
}

export interface AggregatedMetrics {
  tokenSavings: TokenExtractionResult | null;
  errorPrevention: ErrorPreventionMetrics;
  timeSavings: TimeSavingsResult | null;
}

/**
 * Run the full metrics pipeline: extract token savings, compute error
 * prevention metrics, and calculate time savings from a single input.
 *
 * Pure function — no I/O. Callers handle persistence via state.ts.
 */
export function aggregateMetrics(input: AggregateMetricsInput): AggregatedMetrics {
  const now = input.now ?? new Date();

  const tokenSavings = extractTokenSavings(input.comparison);
  const errorPrevention = computeErrorPreventionMetrics(input.preventedErrors, now);
  const timeSavings = calculateTimeSavings(input.comparison);

  return { tokenSavings, errorPrevention, timeSavings };
}

/**
 * Convert aggregated metrics to a MetricsState for persistence.
 * Merges with existing per-directive attributions if provided.
 */
export function toMetricsState(
  projectSlug: string,
  metrics: AggregatedMetrics,
  existingAttributions?: DirectiveAttribution[],
  now?: Date,
): MetricsState {
  const timestamp = (now ?? new Date()).toISOString();

  return {
    v: 1,
    project_slug: projectSlug,
    total_tokens_saved: metrics.tokenSavings?.total_savings_per_session ?? 0,
    total_errors_prevented: metrics.errorPrevention.total_prevented,
    total_time_saved_minutes: metrics.timeSavings?.total_minutes_saved ?? 0,
    per_directive_attribution: existingAttributions ?? [],
    last_computed_at: timestamp,
  };
}

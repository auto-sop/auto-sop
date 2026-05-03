import type { MetricsState } from './state.js';

export interface CloudSyncPayload {
  v: 1;
  project_slug: string;
  period: string;
  token_savings: number;
  errors_prevented: number;
  time_saved_minutes: number;
  directive_count: number;
  generated_at: string;
}

/**
 * Serialize local metrics state into cloud API format.
 *
 * No actual network calls — this is pure format preparation.
 * The period is a YYYY-MM string (e.g. "2026-04").
 *
 * Returns null if the metrics state is null.
 */
export function toCloudSyncFormat(state: MetricsState | null, now?: Date): CloudSyncPayload | null {
  if (!state) return null;

  const date = now ?? new Date();
  const period = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

  return {
    v: 1,
    project_slug: state.project_slug,
    period,
    token_savings: state.total_tokens_saved,
    errors_prevented: state.total_errors_prevented,
    time_saved_minutes: state.total_time_saved_minutes,
    directive_count: state.per_directive_attribution.length,
    generated_at: date.toISOString(),
  };
}

/**
 * Validate that a CloudSyncPayload has all required fields and valid types.
 * Returns true if the payload is ready for cloud upload.
 */
export function isValidSyncPayload(payload: unknown): payload is CloudSyncPayload {
  if (payload === null || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;

  return (
    p.v === 1 &&
    typeof p.project_slug === 'string' &&
    p.project_slug.length > 0 &&
    typeof p.period === 'string' &&
    /^\d{4}-\d{2}$/.test(p.period) &&
    typeof p.token_savings === 'number' &&
    Number.isFinite(p.token_savings) &&
    typeof p.errors_prevented === 'number' &&
    Number.isFinite(p.errors_prevented) &&
    typeof p.time_saved_minutes === 'number' &&
    Number.isFinite(p.time_saved_minutes) &&
    typeof p.directive_count === 'number' &&
    Number.isFinite(p.directive_count) &&
    typeof p.generated_at === 'string' &&
    p.generated_at.length > 0
  );
}

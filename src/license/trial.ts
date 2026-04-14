import type { SecretsPayloadV1 } from './schema.js';

export const TRIAL_DURATION_DAYS = 14;

export type TrialStatusKind = 'dev-key' | 'trial' | 'expired' | 'user';

export interface TrialStatusResult {
  status: TrialStatusKind;
  /** Float; negative if expired; Infinity for dev-key */
  daysRemaining: number;
  startedAt: number;
  durationDays: number;
}

export function trialStatus(
  payload: SecretsPayloadV1,
  now: number = Date.now(),
): TrialStatusResult {
  const { license, trial } = payload;
  if (license.kind === 'dev') {
    return {
      status: 'dev-key',
      daysRemaining: Infinity,
      startedAt: trial.started_at,
      durationDays: trial.duration_days,
    };
  }
  const elapsedMs = now - trial.started_at;
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  const daysRemaining = trial.duration_days - elapsedDays;
  if (daysRemaining > 0) {
    return {
      status: 'trial',
      daysRemaining,
      startedAt: trial.started_at,
      durationDays: trial.duration_days,
    };
  }
  return {
    status: 'expired',
    daysRemaining,
    startedAt: trial.started_at,
    durationDays: trial.duration_days,
  };
}

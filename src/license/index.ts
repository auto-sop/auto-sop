export { secretsPayloadV1Schema, type SecretsPayloadV1 } from './schema.js';
export { readSecrets, writeSecrets, recordLicenseOnInstall } from './storage.js';
export type { RecordLicenseOpts } from './storage.js';
export {
  trialStatus,
  TRIAL_DURATION_DAYS,
  type TrialStatusKind,
  type TrialStatusResult,
} from './trial.js';

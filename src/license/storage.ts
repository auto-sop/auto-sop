import {
  encryptSecrets,
  decryptSecrets,
  readSecretsFile,
  writeSecretsFile,
} from '../config/secrets.js';
import { secretsPayloadV1Schema, type SecretsPayloadV1 } from './schema.js';
import { TRIAL_DURATION_DAYS } from './trial.js';

/**
 * Read and decrypt secrets.enc, returning a validated SecretsPayloadV1 or null if file is missing.
 */
export async function readSecrets(secretsEncPath: string): Promise<SecretsPayloadV1 | null> {
  const file = await readSecretsFile(secretsEncPath);
  if (file === null) return null;
  const plaintext = await decryptSecrets(file);
  const parsed: unknown = JSON.parse(plaintext);
  const result = secretsPayloadV1Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`secrets.enc payload validation failed: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Validate, encrypt, and atomically write the payload to secrets.enc.
 */
export async function writeSecrets(
  secretsEncPath: string,
  payload: SecretsPayloadV1,
): Promise<void> {
  // Validate before writing — crash early on bad data
  secretsPayloadV1Schema.parse(payload);
  const plaintext = JSON.stringify(payload);
  const file = await encryptSecrets(plaintext);
  await writeSecretsFile(secretsEncPath, file);
}

export interface RecordLicenseOpts {
  secretsEncPath: string;
  licenseKey: string;
  kind: 'dev' | 'user';
  packageVersion: string;
  machineIdFull: string;
  now?: number | undefined;
}

/**
 * Record (or update) license data in secrets.enc.
 *
 * Critical invariant (LIC-02): `trial.started_at` is written ONCE on first
 * install and **never** overwritten on subsequent re-installs.
 */
export async function recordLicenseOnInstall(opts: RecordLicenseOpts): Promise<SecretsPayloadV1> {
  const now = opts.now ?? Date.now();
  const machineIdPrefix = opts.machineIdFull.slice(0, 8);
  const existing = await readSecrets(opts.secretsEncPath);

  let payload: SecretsPayloadV1;

  if (existing === null) {
    // Fresh install — build from scratch
    payload = {
      schema_version: 1,
      license: {
        key: opts.licenseKey,
        kind: opts.kind,
        captured_at: now,
      },
      trial: {
        started_at: now,
        duration_days: TRIAL_DURATION_DAYS,
      },
      install: {
        version: opts.packageVersion,
        installed_at: now,
        machine_id_prefix: machineIdPrefix,
      },
    };
  } else {
    // Re-install — PRESERVE trial.started_at and trial.duration_days
    payload = {
      schema_version: 1,
      license: {
        key: opts.licenseKey,
        kind: opts.kind,
        captured_at: now,
      },
      trial: {
        started_at: existing.trial.started_at,
        duration_days: existing.trial.duration_days,
      },
      install: {
        version: opts.packageVersion,
        installed_at: now,
        machine_id_prefix: existing.install.machine_id_prefix,
      },
    };
  }

  await writeSecrets(opts.secretsEncPath, payload);
  return payload;
}

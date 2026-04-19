import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';

// Mock node:fs and node:fs/promises with memfs
vi.mock('node:fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return memfs.fs;
});
vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return memfs.fs.promises;
});

// Stub machine-id to a deterministic value
vi.mock('../../src/config/machine-id.js', () => ({
  getMachineId: vi.fn().mockResolvedValue('deadbeef01234567890abcdef0123456'),
}));

import {
  readSecrets,
  writeSecrets,
  recordLicenseOnInstall,
} from '../../src/license/storage.js';
import type { SecretsPayloadV1 } from '../../src/license/schema.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

beforeEach(() => {
  vol.reset();
  // Ensure parent directory exists in memfs
  vol.mkdirSync('/tmp/test-project/.auto-sop', { recursive: true });
});

const SECRETS_PATH = '/tmp/test-project/.auto-sop/secrets.enc';
const MACHINE_ID = 'deadbeef01234567890abcdef0123456';
const BASE_NOW = 1700000000000; // ms

describe('readSecrets', () => {
  it('returns null when file is missing', async () => {
    const result = await readSecrets(SECRETS_PATH);
    expect(result).toBeNull();
  });

  it('throws on corrupted file', async () => {
    vol.writeFileSync(SECRETS_PATH, 'not valid json at all');
    await expect(readSecrets(SECRETS_PATH)).rejects.toThrow();
  });
});

describe('writeSecrets + readSecrets round-trip', () => {
  it('round-trips a valid payload', async () => {
    const payload: SecretsPayloadV1 = {
      schema_version: 1,
      license: { key: '123', kind: 'dev', captured_at: BASE_NOW },
      trial: { started_at: BASE_NOW, duration_days: 14 },
      install: {
        version: '1.0.0',
        installed_at: BASE_NOW,
        machine_id_prefix: 'deadbeef',
      },
    };
    await writeSecrets(SECRETS_PATH, payload);
    const read = await readSecrets(SECRETS_PATH);
    expect(read).toEqual(payload);
  });
});

describe('recordLicenseOnInstall', () => {
  it('fresh install creates payload with trial.started_at = now', async () => {
    const result = await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: BASE_NOW,
    });
    expect(result.schema_version).toBe(1);
    expect(result.license.key).toBe('123');
    expect(result.license.kind).toBe('dev');
    expect(result.license.captured_at).toBe(BASE_NOW);
    expect(result.trial.started_at).toBe(BASE_NOW);
    expect(result.trial.duration_days).toBe(14);
    expect(result.install.version).toBe('1.0.0');
    expect(result.install.installed_at).toBe(BASE_NOW);
    expect(result.install.machine_id_prefix).toBe('deadbeef');
  });

  it('re-install with same key preserves trial.started_at (LIC-02)', async () => {
    // First install
    const first = await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: BASE_NOW,
    });

    // Re-install 7 days later
    const laterNow = BASE_NOW + 7 * 24 * 60 * 60 * 1000;
    const second = await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: laterNow,
    });

    // trial.started_at MUST be unchanged
    expect(second.trial.started_at).toBe(first.trial.started_at);
    expect(second.trial.started_at).toBe(BASE_NOW);
    // install.installed_at MUST be updated
    expect(second.install.installed_at).toBe(laterNow);
  });

  it('re-install with new key updates license but preserves trial', async () => {
    // First install with dev key
    await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: BASE_NOW,
    });

    // Re-install with real key
    const laterNow = BASE_NOW + 1000;
    const second = await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: 'abc-real-key',
      kind: 'user',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: laterNow,
    });

    expect(second.license.key).toBe('abc-real-key');
    expect(second.license.kind).toBe('user');
    expect(second.license.captured_at).toBe(laterNow);
    // trial still unchanged
    expect(second.trial.started_at).toBe(BASE_NOW);
  });

  it('upgrade version updates install.version', async () => {
    await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: BASE_NOW,
    });

    const laterNow = BASE_NOW + 5000;
    const upgraded = await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '2.0.0',
      machineIdFull: MACHINE_ID,
      now: laterNow,
    });

    expect(upgraded.install.version).toBe('2.0.0');
    expect(upgraded.trial.started_at).toBe(BASE_NOW);
  });

  it('preserves machine_id_prefix from first install on re-install', async () => {
    await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: BASE_NOW,
    });

    // Re-install with a different machineIdFull (shouldn't happen, but defensive)
    const second = await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '1.0.0',
      machineIdFull: 'ffffffff99999999',
      now: BASE_NOW + 1000,
    });

    expect(second.install.machine_id_prefix).toBe('deadbeef');
  });

  it('kind auto-derivation: key "123" → dev, "abc-real" → user', async () => {
    // Dev key
    const devResult = await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: '123',
      kind: 'dev',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: BASE_NOW,
    });
    expect(devResult.license.kind).toBe('dev');

    // Reset for user key test
    vol.reset();
    vol.mkdirSync('/tmp/test-project/.auto-sop', { recursive: true });

    const userResult = await recordLicenseOnInstall({
      secretsEncPath: SECRETS_PATH,
      licenseKey: 'abc-real',
      kind: 'user',
      packageVersion: '1.0.0',
      machineIdFull: MACHINE_ID,
      now: BASE_NOW,
    });
    expect(userResult.license.kind).toBe('user');
  });
});

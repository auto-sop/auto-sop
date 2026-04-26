import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import {
  GRACE_PERIOD_DAYS,
  readCache,
  writeCache,
  isCacheValid,
  isGraceExpired,
  incrementFailure,
  resetFailures,
  type LicenseCache,
} from '../../src/license/cache.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

const DAY_MS = 24 * 60 * 60 * 1000;

function makeCache(overrides: Partial<LicenseCache> = {}): LicenseCache {
  return {
    validated_at: new Date().toISOString(),
    last_nonce: 'nonce-abc',
    payload: {
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      status: 'active',
    },
    signature: 'deadbeef'.repeat(8),
    consecutive_failures: 0,
    ...overrides,
  };
}

/* ─── isCacheValid ─── */

describe('isCacheValid', () => {
  const now = new Date('2026-06-15T12:00:00Z').getTime();

  it('returns true when expires_at is in the future', () => {
    const c = makeCache({
      payload: { expires_at: new Date(now + DAY_MS).toISOString() },
    });
    expect(isCacheValid(c, now)).toBe(true);
  });

  it('returns false when expires_at is in the past', () => {
    const c = makeCache({
      payload: { expires_at: new Date(now - 1000).toISOString() },
    });
    expect(isCacheValid(c, now)).toBe(false);
  });

  it('returns false when expires_at equals now', () => {
    const c = makeCache({
      payload: { expires_at: new Date(now).toISOString() },
    });
    expect(isCacheValid(c, now)).toBe(false);
  });

  it('returns false for invalid date string', () => {
    const c = makeCache({
      payload: { expires_at: 'garbage-date' },
    });
    expect(isCacheValid(c, now)).toBe(false);
  });
});

/* ─── isGraceExpired ─── */

describe('isGraceExpired', () => {
  const now = new Date('2026-06-15T12:00:00Z').getTime();

  it('returns false when consecutive_failures is 0', () => {
    const c = makeCache({ consecutive_failures: 0 });
    expect(isGraceExpired(c, now)).toBe(false);
  });

  it('returns false when first failure was 6 days ago', () => {
    const c = makeCache({
      consecutive_failures: 10,
      first_failure_at: new Date(now - 6 * DAY_MS).toISOString(),
    });
    expect(isGraceExpired(c, now)).toBe(false);
  });

  it('returns true when first failure was 8 days ago', () => {
    const c = makeCache({
      consecutive_failures: 5,
      first_failure_at: new Date(now - 8 * DAY_MS).toISOString(),
    });
    expect(isGraceExpired(c, now)).toBe(true);
  });

  it('returns true when first failure was exactly 7 days + 1ms ago', () => {
    const c = makeCache({
      consecutive_failures: 1,
      first_failure_at: new Date(now - 7 * DAY_MS - 1).toISOString(),
    });
    expect(isGraceExpired(c, now)).toBe(true);
  });

  it('returns false when first failure is exactly 7 days ago (boundary)', () => {
    const c = makeCache({
      consecutive_failures: 1,
      first_failure_at: new Date(now - 7 * DAY_MS).toISOString(),
    });
    expect(isGraceExpired(c, now)).toBe(false);
  });

  it('returns false when first_failure_at is undefined', () => {
    const c = makeCache({
      consecutive_failures: 3,
      first_failure_at: undefined,
    });
    expect(isGraceExpired(c, now)).toBe(false);
  });

  it('GRACE_PERIOD_DAYS is 7', () => {
    expect(GRACE_PERIOD_DAYS).toBe(7);
  });
});

/* ─── incrementFailure ─── */

describe('incrementFailure', () => {
  const now = new Date('2026-06-15T12:00:00Z').getTime();

  it('increments counter from 0 to 1 and sets first_failure_at', () => {
    const c = makeCache({ consecutive_failures: 0, first_failure_at: undefined });
    const result = incrementFailure(c, now);
    expect(result.consecutive_failures).toBe(1);
    expect(result.first_failure_at).toBe(new Date(now).toISOString());
  });

  it('increments from 3 to 4 without changing first_failure_at', () => {
    const firstFailure = new Date(now - 2 * DAY_MS).toISOString();
    const c = makeCache({
      consecutive_failures: 3,
      first_failure_at: firstFailure,
    });
    const result = incrementFailure(c, now);
    expect(result.consecutive_failures).toBe(4);
    expect(result.first_failure_at).toBe(firstFailure);
  });

  it('does not mutate the original', () => {
    const c = makeCache({ consecutive_failures: 1 });
    const result = incrementFailure(c, now);
    expect(c.consecutive_failures).toBe(1);
    expect(result.consecutive_failures).toBe(2);
  });
});

/* ─── resetFailures ─── */

describe('resetFailures', () => {
  it('resets consecutive_failures to 0 and clears first_failure_at', () => {
    const c = makeCache({
      consecutive_failures: 5,
      first_failure_at: new Date().toISOString(),
    });
    const result = resetFailures(c);
    expect(result.consecutive_failures).toBe(0);
    expect(result.first_failure_at).toBeUndefined();
  });

  it('does not mutate the original', () => {
    const c = makeCache({ consecutive_failures: 3 });
    resetFailures(c);
    expect(c.consecutive_failures).toBe(3);
  });
});

/* ─── readCache / writeCache (disk) ─── */

describe('readCache / writeCache', () => {
  let testDir: string;
  let cachePath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `cache-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
    cachePath = join(testDir, 'license-cache.json');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('round-trips a cache object', async () => {
    const c = makeCache();
    await writeCache(c, cachePath);
    const read = await readCache(cachePath);
    expect(read).toEqual(c);
  });

  it('returns null for missing file', async () => {
    const result = await readCache(join(testDir, 'no-such-file.json'));
    expect(result).toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    await fs.writeFile(cachePath, '{{not json');
    const result = await readCache(cachePath);
    expect(result).toBeNull();
  });

  it('returns null for JSON missing required fields', async () => {
    await fs.writeFile(cachePath, '{"foo": "bar"}');
    const result = await readCache(cachePath);
    expect(result).toBeNull();
  });

  it('creates parent directories', async () => {
    const deep = join(testDir, 'a', 'b', 'c', 'cache.json');
    const c = makeCache();
    await writeCache(c, deep);
    const read = await readCache(deep);
    expect(read).toEqual(c);
  });

  it('file has mode 0o600', async () => {
    const c = makeCache();
    await writeCache(c, cachePath);
    const stat = await fs.stat(cachePath);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});

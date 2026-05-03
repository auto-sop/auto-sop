import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LicenseCache } from '../../src/license/cache.js';

/* ─── module mocks (hoisted by vitest) ─── */

vi.mock('../../src/license/cache.js', () => ({
  readCache: vi.fn(),
  writeCache: vi.fn(),
  isCacheValid: vi.fn(),
  isGraceExpired: vi.fn(),
  incrementFailure: vi.fn(),
  resetFailures: vi.fn((c: unknown) => c),
  GRACE_PERIOD_DAYS: 7,
  GRACE_PERIOD_MS: 7 * 24 * 60 * 60 * 1000,
  defaultCachePath: vi.fn(() => '/tmp/test-cache.json'),
}));

vi.mock('../../src/license/ed25519-verify.js', () => ({
  verifyServerSignature: vi.fn(),
  validateResponseFreshness: vi.fn(),
}));

vi.mock('../../src/license/x25519-encrypt.js', () => ({
  encryptRequest: vi.fn(() => {
    throw new Error('mock: skip encryption for unit tests');
  }),
}));

import { validateLicense, getValidationStatus } from '../../src/license/server-client.js';
import {
  readCache,
  writeCache,
  isGraceExpired,
  incrementFailure,
} from '../../src/license/cache.js';
import {
  verifyServerSignature,
  validateResponseFreshness,
} from '../../src/license/ed25519-verify.js';

/* ─── typed mock refs ─── */

const mockedReadCache = vi.mocked(readCache);
const mockedWriteCache = vi.mocked(writeCache);
const mockedIsGraceExpired = vi.mocked(isGraceExpired);
const mockedIncrementFailure = vi.mocked(incrementFailure);
const mockedVerifySignature = vi.mocked(verifyServerSignature);
const mockedValidateFreshness = vi.mocked(validateResponseFreshness);

/* ─── helpers ─── */

const DAY_MS = 24 * 60 * 60 * 1000;

const OPTS = {
  key: 'test-key-abc123',
  machineId: 'machine-xyz',
  boundProjects: ['/proj/a'],
};

function serverPayload(overrides: Record<string, unknown> = {}) {
  return {
    nonce: 'nonce-fresh',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + DAY_MS).toISOString(),
    plan: 'pro',
    max_projects: 10,
    ...overrides,
  };
}

function serverBody(data = serverPayload(), signature = 'sig-valid') {
  return { data, signature };
}

function mockFetchResponse(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makeCache(overrides: Partial<LicenseCache> = {}): LicenseCache {
  return {
    validated_at: new Date().toISOString(),
    last_nonce: 'old-nonce',
    payload: {
      expires_at: new Date(Date.now() + DAY_MS).toISOString(),
      plan: 'pro',
      max_projects: 5,
    },
    signature: 'cached-sig',
    consecutive_failures: 0,
    first_failure_at: undefined,
    ...overrides,
  };
}

/* ─── per-test setup ─── */

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  mockedWriteCache.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ─── validateLicense ─── */

describe('validateLicense', () => {
  it('returns success and updates cache on valid server response', async () => {
    const body = serverBody();
    mockFetch.mockResolvedValue(mockFetchResponse(200, body));
    mockedVerifySignature.mockReturnValue(true);
    mockedValidateFreshness.mockReturnValue(true);
    mockedReadCache.mockResolvedValue(null);

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(true);
    expect(result.payload).toBeDefined();
    expect(result.payload!['plan']).toBe('pro');
    expect(result.fromCache).toBeUndefined();
    expect(mockedWriteCache).toHaveBeenCalledOnce();

    const written = mockedWriteCache.mock.calls[0]![0] as LicenseCache;
    expect(written.consecutive_failures).toBe(0);
    expect(written.last_nonce).toBe('nonce-fresh');
    expect(written.first_failure_at).toBeUndefined();
  });

  it('falls back to correct plain JSON body when encryption unavailable', async () => {
    const body = serverBody();
    mockFetch.mockResolvedValue(mockFetchResponse(200, body));
    mockedVerifySignature.mockReturnValue(true);
    mockedValidateFreshness.mockReturnValue(true);
    mockedReadCache.mockResolvedValue(null);

    await validateLicense({
      key: 'my-key',
      machineId: 'my-machine',
      boundProjects: ['/a', '/b'],
      cliVersion: '1.2.3',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/license/validate');
    const sent = JSON.parse(init.body as string);
    expect(sent.key).toBe('my-key');
    expect(sent.machine_id).toBe('my-machine');
    expect(sent.bound_projects).toEqual(['/a', '/b']);
    expect(sent.cli_version).toBe('1.2.3');
  });

  it('falls back to valid cache on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const cache = makeCache();
    mockedReadCache.mockResolvedValue(cache);
    mockedIncrementFailure.mockReturnValue(
      makeCache({ consecutive_failures: 1, first_failure_at: new Date().toISOString() }),
    );
    mockedIsGraceExpired.mockReturnValue(false);

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(result.payload).toEqual(cache.payload);
    expect(mockedIncrementFailure).toHaveBeenCalledOnce();
    expect(mockedWriteCache).toHaveBeenCalledOnce();
  });

  it('returns grace_expired when network fails and grace is exhausted', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const cache = makeCache({
      consecutive_failures: 100,
      first_failure_at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    });
    mockedReadCache.mockResolvedValue(cache);
    mockedIncrementFailure.mockReturnValue(makeCache({ consecutive_failures: 101 }));
    mockedIsGraceExpired.mockReturnValue(true);

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('grace_expired');
  });

  it('returns no_cache when network fails and no cache exists', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    mockedReadCache.mockResolvedValue(null);

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('no_cache');
  });

  it('rejects response with invalid signature', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(200, serverBody()));
    mockedVerifySignature.mockReturnValue(false);

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(mockedWriteCache).not.toHaveBeenCalled();
  });

  it('rejects replayed nonce', async () => {
    const body = serverBody(serverPayload({ nonce: 'replayed-nonce' }));
    mockFetch.mockResolvedValue(mockFetchResponse(200, body));
    mockedVerifySignature.mockReturnValue(true);
    mockedValidateFreshness.mockReturnValue(false);
    mockedReadCache.mockResolvedValue(makeCache({ last_nonce: 'replayed-nonce' }));

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('replay_detected');
    expect(mockedWriteCache).not.toHaveBeenCalled();
  });

  it('falls back to cache on 429 without incrementing failure', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(429));
    const cache = makeCache();
    mockedReadCache.mockResolvedValue(cache);
    mockedIsGraceExpired.mockReturnValue(false);

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(mockedIncrementFailure).not.toHaveBeenCalled();
    expect(mockedWriteCache).not.toHaveBeenCalled();
  });

  it('returns invalid_key on 401 without cache interaction', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(401));

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_key');
    expect(mockedReadCache).not.toHaveBeenCalled();
    expect(mockedWriteCache).not.toHaveBeenCalled();
  });

  it('falls back to cache on 500 with failure increment', async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(500));
    const cache = makeCache();
    mockedReadCache.mockResolvedValue(cache);
    mockedIncrementFailure.mockReturnValue(makeCache({ consecutive_failures: 1 }));
    mockedIsGraceExpired.mockReturnValue(false);

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(mockedIncrementFailure).toHaveBeenCalledOnce();
    expect(mockedWriteCache).toHaveBeenCalledOnce();
  });

  it('passes the existing nonce to freshness check', async () => {
    const body = serverBody();
    mockFetch.mockResolvedValue(mockFetchResponse(200, body));
    mockedVerifySignature.mockReturnValue(true);
    mockedValidateFreshness.mockReturnValue(true);
    const existingCache = makeCache({ last_nonce: 'prev-nonce-42' });
    mockedReadCache.mockResolvedValue(existingCache);

    await validateLicense(OPTS);

    expect(mockedValidateFreshness).toHaveBeenCalledWith(body.data, 'prev-nonce-42');
  });

  it('returns tampered_client error when server signals tamper', async () => {
    const data = serverPayload({ valid: false, reason: 'tampered_client' });
    const body = serverBody(data);
    mockFetch.mockResolvedValue(mockFetchResponse(200, body));
    mockedVerifySignature.mockReturnValue(true);
    mockedValidateFreshness.mockReturnValue(true);
    mockedReadCache.mockResolvedValue(null);

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(false);
    expect(result.error).toBe('tampered_client');
    expect(result.message).toContain('reinstall');
    // Must NOT write to cache — tamper is not cacheable
    expect(mockedWriteCache).not.toHaveBeenCalled();
  });

  it('does not treat normal valid:false as tampered', async () => {
    const data = serverPayload({ valid: false, reason: 'project_limit' });
    const body = serverBody(data);
    mockFetch.mockResolvedValue(mockFetchResponse(200, body));
    mockedVerifySignature.mockReturnValue(true);
    mockedValidateFreshness.mockReturnValue(true);
    mockedReadCache.mockResolvedValue(null);

    const result = await validateLicense(OPTS);

    // Should proceed to success path (write cache) since reason isn't tampered_client
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

/* ─── getValidationStatus ─── */

describe('getValidationStatus', () => {
  it('returns null values when no cache exists', async () => {
    mockedReadCache.mockResolvedValue(null);

    const status = await getValidationStatus();

    expect(status.lastValidated).toBeNull();
    expect(status.graceRemaining).toBeNull();
    expect(status.isOnline).toBe(false);
    expect(status.plan).toBeNull();
    expect(status.maxProjects).toBeNull();
  });

  it('returns online status with no failures', async () => {
    const cache = makeCache({ consecutive_failures: 0 });
    mockedReadCache.mockResolvedValue(cache);

    const status = await getValidationStatus();

    expect(status.lastValidated).toBe(cache.validated_at);
    expect(status.isOnline).toBe(true);
    expect(status.graceRemaining).toBeNull();
    expect(status.plan).toBe('pro');
    expect(status.maxProjects).toBe(5);
  });

  it('returns grace remaining when failures exist', async () => {
    const firstFailure = new Date(Date.now() - 3 * DAY_MS).toISOString();
    const cache = makeCache({
      consecutive_failures: 5,
      first_failure_at: firstFailure,
    });
    mockedReadCache.mockResolvedValue(cache);

    const status = await getValidationStatus();

    expect(status.isOnline).toBe(false);
    expect(status.graceRemaining).not.toBeNull();
    // 7 days - 3 days ≈ 4 days remaining (allow 1s tolerance for execution time)
    expect(status.graceRemaining!).toBeGreaterThan(4 * DAY_MS - 1000);
    expect(status.graceRemaining!).toBeLessThanOrEqual(4 * DAY_MS);
  });

  it('returns zero grace remaining when grace is exhausted', async () => {
    const firstFailure = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const cache = makeCache({
      consecutive_failures: 50,
      first_failure_at: firstFailure,
    });
    mockedReadCache.mockResolvedValue(cache);

    const status = await getValidationStatus();

    expect(status.graceRemaining).toBe(0);
  });

  it('returns null plan and maxProjects when payload lacks them', async () => {
    const cache = makeCache();
    // Override payload to not have plan/max_projects
    cache.payload = { expires_at: new Date(Date.now() + DAY_MS).toISOString() };
    mockedReadCache.mockResolvedValue(cache);

    const status = await getValidationStatus();

    expect(status.plan).toBeNull();
    expect(status.maxProjects).toBeNull();
  });
});

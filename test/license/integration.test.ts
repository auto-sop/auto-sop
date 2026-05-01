import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/* ─── hoisted key pair (shared between mock factory and test code) ─── */

const testKeys = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pemPublic = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const b64Public = Buffer.from(pemPublic).toString('base64');
  return { publicKey, privateKey, b64Public };
});

/* ─── mock filesystem-dependent modules ─── */

vi.mock('../../src/license/storage.js', () => ({
  readSecrets: vi.fn(),
}));

vi.mock('../../src/learner/project-registry.js', () => ({
  readRegistry: vi.fn(),
}));

vi.mock('../../src/config/machine-id.js', () => ({
  getMachineId: vi.fn(),
}));

vi.mock('../../src/license/cache.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/license/cache.js')>();
  return {
    ...real,
    readCache: vi.fn(),
    writeCache: vi.fn(),
    defaultCachePath: vi.fn(() => '/tmp/test-license-cache.json'),
  };
});

vi.mock('../../src/license/binding.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/license/binding.js')>();
  return {
    ...real,
    readBindingFile: vi.fn(),
    writeBindingFile: vi.fn(),
  };
});

vi.mock('../../src/license/server-public-key.js', () => ({
  SERVER_PUBLIC_KEY_B64: testKeys.b64Public,
}));

vi.mock('../../src/config/environment.js', () => ({
  API_BASE_URL: 'https://test.auto-sop.com/api/v1',
  APP_BASE_URL: 'https://test.auto-sop.com',
}));

/* ─── imports (after mocks are declared) ─── */

import {
  verifyServerSignature,
  validateResponseFreshness,
} from '../../src/license/ed25519-verify.js';
import {
  createBindingToken,
  createBindingFile,
  verifyBindingToken,
  readBindingFile,
  writeBindingFile,
} from '../../src/license/binding.js';
import {
  readCache,
  writeCache,
  isCacheValid,
  isGraceExpired,
  incrementFailure,
  type LicenseCache,
} from '../../src/license/cache.js';
import { validateLicense } from '../../src/license/server-client.js';
import {
  checkLicenseBeforeTick,
  shouldProjectRun,
  isProjectActive,
} from '../../src/license/enforcement.js';
import { readSecrets } from '../../src/license/storage.js';
import { readRegistry } from '../../src/learner/project-registry.js';
import { getMachineId } from '../../src/config/machine-id.js';

/* ─── typed mock refs ─── */

const mockedReadSecrets = vi.mocked(readSecrets);
const mockedReadRegistry = vi.mocked(readRegistry);
const mockedGetMachineId = vi.mocked(getMachineId);
const mockedReadCache = vi.mocked(readCache);
const mockedWriteCache = vi.mocked(writeCache);
const mockedReadBindingFile = vi.mocked(readBindingFile);
const mockedWriteBindingFile = vi.mocked(writeBindingFile);

/* ─── test key refs ─── */

const TEST_PUBLIC_KEY_B64 = testKeys.b64Public;

/* ─── helpers ─── */

const DAY_MS = 24 * 60 * 60 * 1000;
const LICENSE_KEY = 'pro-license-key-integration-test';
const DEV_KEY = 'dev-license-key-for-tests';
const MACHINE_ID = 'test-machine-id-abc123';
const PROJECT_PATH = '/home/user/project-alpha';
const HOME = '/home/user';

function signPayload(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  return sign(null, data, testKeys.privateKey as KeyObject).toString('hex');
}

function makeServerPayload(overrides: Record<string, unknown> = {}) {
  return {
    nonce: `nonce-${Date.now()}-${Math.random()}`,
    issued_at: new Date(Date.now() - 30_000).toISOString(),
    expires_at: new Date(Date.now() + DAY_MS).toISOString(),
    valid: true,
    plan: 'pro',
    max_projects: 5,
    ...overrides,
  };
}

function makeSignedResponse(payload?: Record<string, unknown>) {
  const data = payload ?? makeServerPayload();
  return { data, signature: signPayload(data) };
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
    last_nonce: 'cached-nonce-old',
    payload: {
      expires_at: new Date(Date.now() + DAY_MS).toISOString(),
      plan: 'pro',
      max_projects: 5,
      valid: true,
    },
    signature: 'cached-sig-hex',
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
  mockedWriteBindingFile.mockResolvedValue(undefined);
  mockedGetMachineId.mockResolvedValue(MACHINE_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ═══════════════════════════════════════════════════════════════
   Install Flow Integration Tests
   ═══════════════════════════════════════════════════════════════ */

describe('Integration: Install Flow', () => {
  describe('1. Install with valid key → binding created, cache populated', () => {
    it('creates binding and caches valid server response', async () => {
      const serverBody = makeSignedResponse();
      mockFetch.mockResolvedValue(mockFetchResponse(200, serverBody));
      mockedReadCache.mockResolvedValue(null);

      // Step 1: Create binding for the project
      const binding = createBindingFile({
        licenseKey: LICENSE_KEY,
        projectPath: PROJECT_PATH,
        machineId: MACHINE_ID,
      });

      // Binding was created with proper HMAC
      expect(binding.token).toMatch(/^[0-9a-f]{64}$/);
      expect(binding.machine_id).toBe(MACHINE_ID);
      expect(binding.license_key_hash).toHaveLength(16);

      // Step 2: Validate license with server
      const result = await validateLicense({
        key: LICENSE_KEY,
        machineId: MACHINE_ID,
        boundProjects: [PROJECT_PATH],
        bindingHashes: [binding.token],
      });

      // Server accepted — cache populated
      expect(result.success).toBe(true);
      expect(result.payload).toBeDefined();
      expect(result.payload!['plan']).toBe('pro');
      expect(result.payload!['max_projects']).toBe(5);
      expect(mockedWriteCache).toHaveBeenCalledOnce();

      const written = mockedWriteCache.mock.calls[0]![0] as LicenseCache;
      expect(written.consecutive_failures).toBe(0);
      expect(written.last_nonce).toBe(serverBody.data.nonce);
    });

    it('binding token verifies against same key/project/machine', () => {
      const binding = createBindingFile({
        licenseKey: LICENSE_KEY,
        projectPath: PROJECT_PATH,
        machineId: MACHINE_ID,
      });

      expect(verifyBindingToken(binding, LICENSE_KEY, PROJECT_PATH, MACHINE_ID)).toBe(true);
    });
  });

  describe('2. Install with invalid key → install aborted', () => {
    it('returns invalid_key when server responds 401', async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(401));

      const result = await validateLicense({
        key: 'bad-key-invalid',
        machineId: MACHINE_ID,
        boundProjects: [PROJECT_PATH],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_key');
      // No cache interaction on invalid key
      expect(mockedWriteCache).not.toHaveBeenCalled();
    });
  });

  describe('3. Install offline → grace period starts', () => {
    it('starts grace period on first network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const existingCache = makeCache({ consecutive_failures: 0 });
      mockedReadCache.mockResolvedValue(existingCache);

      const result = await validateLicense({
        key: LICENSE_KEY,
        machineId: MACHINE_ID,
        boundProjects: [PROJECT_PATH],
      });

      // Falls back to cache
      expect(result.success).toBe(true);
      expect(result.fromCache).toBe(true);

      // Cache was updated with incremented failure
      expect(mockedWriteCache).toHaveBeenCalledOnce();
      const written = mockedWriteCache.mock.calls[0]![0] as LicenseCache;
      expect(written.consecutive_failures).toBe(1);
      expect(written.first_failure_at).toBeDefined();
    });

    it('returns no_cache when offline with no prior cache', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      mockedReadCache.mockResolvedValue(null);

      const result = await validateLicense({
        key: LICENSE_KEY,
        machineId: MACHINE_ID,
        boundProjects: [PROJECT_PATH],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('no_cache');
    });
  });
});

/* ═══════════════════════════════════════════════════════════════
   Tick Flow Integration Tests
   ═══════════════════════════════════════════════════════════════ */

describe('Integration: Tick Flow', () => {
  describe('4. Tick with valid license → learner proceeds', () => {
    it('checkLicenseBeforeTick returns allowed:true on valid response', async () => {
      const serverBody = makeSignedResponse();
      mockFetch.mockResolvedValue(mockFetchResponse(200, serverBody));
      mockedReadCache.mockResolvedValue(null);
      mockedReadSecrets.mockResolvedValue({ license: { key: LICENSE_KEY } });
      mockedReadRegistry.mockReturnValue({
        projects: [{ project_root: PROJECT_PATH, installed_at: '2026-01-01T00:00:00Z' }],
      });
      mockedReadBindingFile.mockResolvedValue({
        license_key_hash: 'abcdef0123456789',
        machine_id: MACHINE_ID,
        bound_at: '2026-01-01T00:00:00Z',
        token: createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID),
      });

      const enforcement = await checkLicenseBeforeTick(HOME);

      expect(enforcement.allowed).toBe(true);
      expect(enforcement.plan).toBe('pro');
      expect(enforcement.maxProjects).toBe(5);
    });
  });

  describe('5. Tick with expired grace → learner blocked', () => {
    it('checkLicenseBeforeTick returns allowed:false when grace expired', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const expiredCache = makeCache({
        consecutive_failures: 100,
        first_failure_at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
      });
      mockedReadCache.mockResolvedValue(expiredCache);
      mockedReadSecrets.mockResolvedValue({ license: { key: LICENSE_KEY } });
      mockedReadRegistry.mockReturnValue({
        projects: [{ project_root: PROJECT_PATH, installed_at: '2026-01-01T00:00:00Z' }],
      });
      mockedReadBindingFile.mockResolvedValue({
        license_key_hash: 'abcdef0123456789',
        machine_id: MACHINE_ID,
        bound_at: '2026-01-01T00:00:00Z',
        token: createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID),
      });

      const enforcement = await checkLicenseBeforeTick(HOME);

      expect(enforcement.allowed).toBe(false);
      expect(enforcement.reason).toContain('grace period expired');
    });
  });

  describe('6. Tick with over-quota → excess projects skipped', () => {
    it('shouldProjectRun returns false for projects beyond max', () => {
      const maxProjects = 3;

      // First 3 projects are allowed
      expect(shouldProjectRun(0, maxProjects)).toBe(true);
      expect(shouldProjectRun(1, maxProjects)).toBe(true);
      expect(shouldProjectRun(2, maxProjects)).toBe(true);

      // Projects at index 3+ are blocked
      expect(shouldProjectRun(3, maxProjects)).toBe(false);
      expect(shouldProjectRun(4, maxProjects)).toBe(false);
      expect(shouldProjectRun(10, maxProjects)).toBe(false);
    });

    it('checkLicenseBeforeTick reports over-quota from server', async () => {
      const payload = makeServerPayload({ valid: false, plan: 'free', max_projects: 1 });
      const serverBody = { data: payload, signature: signPayload(payload) };
      mockFetch.mockResolvedValue(mockFetchResponse(200, serverBody));
      mockedReadCache.mockResolvedValue(null);
      mockedReadSecrets.mockResolvedValue({ license: { key: LICENSE_KEY } });
      mockedReadRegistry.mockReturnValue({
        projects: [
          { project_root: '/proj/a', installed_at: '2026-01-01T00:00:00Z' },
          { project_root: '/proj/b', installed_at: '2026-01-02T00:00:00Z' },
        ],
      });
      mockedReadBindingFile.mockResolvedValue({
        license_key_hash: 'abcdef0123456789',
        machine_id: MACHINE_ID,
        bound_at: '2026-01-01T00:00:00Z',
        token: 'fake-token-hash',
      });

      const enforcement = await checkLicenseBeforeTick(HOME);

      expect(enforcement.allowed).toBe(false);
      expect(enforcement.reason).toContain('Project limit exceeded');
      expect(enforcement.plan).toBe('free');
      expect(enforcement.maxProjects).toBe(1);
    });
  });

  describe('7. Tick with dev key → all checks bypassed', () => {
    it('checkLicenseBeforeTick returns allowed:true for dev key', async () => {
      mockedReadSecrets.mockResolvedValue({ license: { key: DEV_KEY } });
      mockedReadRegistry.mockReturnValue({ projects: [] });

      const enforcement = await checkLicenseBeforeTick(HOME);

      expect(enforcement.allowed).toBe(true);
      expect(enforcement.plan).toBe('dev');
      // No network calls made
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

/* ═══════════════════════════════════════════════════════════════
   Security Integration Tests
   ═══════════════════════════════════════════════════════════════ */

describe('Integration: Security Checks', () => {
  describe('8. Binding file tampered → detected as invalid', () => {
    it('verifyBindingToken returns false when token is modified', () => {
      const binding = createBindingFile({
        licenseKey: LICENSE_KEY,
        projectPath: PROJECT_PATH,
        machineId: MACHINE_ID,
      });

      // Tamper: flip a character in the token
      const tampered = { ...binding, token: 'a'.repeat(64) };

      expect(verifyBindingToken(tampered, LICENSE_KEY, PROJECT_PATH, MACHINE_ID)).toBe(false);
    });

    it('verifyBindingToken returns false when project path changed', () => {
      const binding = createBindingFile({
        licenseKey: LICENSE_KEY,
        projectPath: PROJECT_PATH,
        machineId: MACHINE_ID,
      });

      // Binding copied to different project
      expect(verifyBindingToken(binding, LICENSE_KEY, '/different/project', MACHINE_ID)).toBe(false);
    });

    it('verifyBindingToken returns false when machine differs', () => {
      const binding = createBindingFile({
        licenseKey: LICENSE_KEY,
        projectPath: PROJECT_PATH,
        machineId: MACHINE_ID,
      });

      expect(verifyBindingToken(binding, LICENSE_KEY, PROJECT_PATH, 'different-machine')).toBe(false);
    });

    it('verifyBindingToken returns false when license key differs', () => {
      const binding = createBindingFile({
        licenseKey: LICENSE_KEY,
        projectPath: PROJECT_PATH,
        machineId: MACHINE_ID,
      });

      expect(verifyBindingToken(binding, 'stolen-key', PROJECT_PATH, MACHINE_ID)).toBe(false);
    });
  });

  describe('9. Response with bad signature → rejected', () => {
    it('verifyServerSignature returns false for tampered payload', () => {
      const payload = makeServerPayload();
      const sig = signPayload(payload);

      // Tamper with the payload after signing
      const tampered = { ...payload, plan: 'enterprise' };

      expect(verifyServerSignature(tampered, sig, TEST_PUBLIC_KEY_B64)).toBe(false);
    });

    it('verifyServerSignature returns false for wrong signature', () => {
      const payload = makeServerPayload();
      // Use a completely fake signature
      const fakeSig = 'ff'.repeat(64);

      expect(verifyServerSignature(payload, fakeSig, TEST_PUBLIC_KEY_B64)).toBe(false);
    });

    it('validateLicense rejects response with invalid signature via full flow', async () => {
      const payload = makeServerPayload();
      // Sign with correct key but tamper with the response data
      const sig = signPayload(payload);
      const tamperedPayload = { ...payload, max_projects: 9999 };
      const body = { data: tamperedPayload, signature: sig };

      mockFetch.mockResolvedValue(mockFetchResponse(200, body));
      mockedReadCache.mockResolvedValue(null);

      const result = await validateLicense({
        key: LICENSE_KEY,
        machineId: MACHINE_ID,
        boundProjects: [PROJECT_PATH],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_signature');
      expect(mockedWriteCache).not.toHaveBeenCalled();
    });
  });

  describe('10. Response with replayed nonce → rejected', () => {
    it('validateResponseFreshness returns false for same nonce', () => {
      const payload = {
        nonce: 'nonce-replayed',
        issued_at: new Date(Date.now() - 30_000).toISOString(),
        expires_at: new Date(Date.now() + DAY_MS).toISOString(),
      };

      expect(validateResponseFreshness(payload, 'nonce-replayed')).toBe(false);
    });

    it('validateLicense rejects replayed nonce via full flow', async () => {
      const replayedNonce = 'nonce-already-seen';
      const payload = makeServerPayload({ nonce: replayedNonce });
      const body = { data: payload, signature: signPayload(payload) };

      mockFetch.mockResolvedValue(mockFetchResponse(200, body));
      // Cache has this nonce already
      mockedReadCache.mockResolvedValue(makeCache({ last_nonce: replayedNonce }));

      const result = await validateLicense({
        key: LICENSE_KEY,
        machineId: MACHINE_ID,
        boundProjects: [PROJECT_PATH],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('replay_detected');
      expect(mockedWriteCache).not.toHaveBeenCalled();
    });

    it('validateResponseFreshness rejects expired response', () => {
      const payload = {
        nonce: 'nonce-fresh',
        issued_at: new Date(Date.now() - 30_000).toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
      };

      expect(validateResponseFreshness(payload)).toBe(false);
    });

    it('validateResponseFreshness rejects ancient issued_at', () => {
      const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
      const payload = {
        nonce: 'nonce-stale',
        issued_at: new Date(threeHoursAgo).toISOString(),
        expires_at: new Date(Date.now() + DAY_MS).toISOString(),
      };

      expect(validateResponseFreshness(payload)).toBe(false);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════
   Cache Grace Period Integration
   ═══════════════════════════════════════════════════════════════ */

describe('Integration: Cache Grace Period Logic', () => {
  it('grace period is not expired within 7 days', () => {
    const cache = makeCache({
      consecutive_failures: 5,
      first_failure_at: new Date(Date.now() - 6 * DAY_MS).toISOString(),
    });

    expect(isGraceExpired(cache)).toBe(false);
  });

  it('grace period is expired after 7 days', () => {
    const cache = makeCache({
      consecutive_failures: 10,
      first_failure_at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    });

    expect(isGraceExpired(cache)).toBe(true);
  });

  it('incrementFailure sets first_failure_at on first failure', () => {
    const cache = makeCache({ consecutive_failures: 0, first_failure_at: undefined });
    const updated = incrementFailure(cache);

    expect(updated.consecutive_failures).toBe(1);
    expect(updated.first_failure_at).toBeDefined();
  });

  it('incrementFailure preserves first_failure_at on subsequent failures', () => {
    const firstFail = '2026-01-01T00:00:00.000Z';
    const cache = makeCache({ consecutive_failures: 3, first_failure_at: firstFail });
    const updated = incrementFailure(cache);

    expect(updated.consecutive_failures).toBe(4);
    expect(updated.first_failure_at).toBe(firstFail);
  });

  it('cache is valid when expires_at is in the future', () => {
    const cache = makeCache();
    expect(isCacheValid(cache)).toBe(true);
  });

  it('cache is invalid when expires_at is in the past', () => {
    const cache = makeCache();
    cache.payload.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(isCacheValid(cache)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
   V56: isProjectActive — Project Toggle Tests
   ═══════════════════════════════════════════════════════════════ */

describe('Integration: isProjectActive (V56 project toggles)', () => {
  describe('when active_projects is provided and non-empty', () => {
    it('returns true when project slug is in the active list', () => {
      expect(isProjectActive('my-project', ['my-project', 'other-project'], 0, 3)).toBe(true);
    });

    it('returns false when project slug is NOT in the active list', () => {
      expect(isProjectActive('unlisted-project', ['proj-a', 'proj-b'], 0, 3)).toBe(false);
    });

    it('ignores index-based quota when active list is present', () => {
      // Even though index=5 exceeds maxProjects=3, slug is in the list → active
      expect(isProjectActive('proj-a', ['proj-a'], 5, 3)).toBe(true);
    });

    it('respects list even when index is within quota', () => {
      // Index 0 is within quota, but slug is NOT in active list → inactive
      expect(isProjectActive('not-active', ['proj-a', 'proj-b'], 0, 10)).toBe(false);
    });
  });

  describe('when active_projects is undefined or empty (backward compat)', () => {
    it('falls back to index-based quota when active_projects is undefined', () => {
      expect(isProjectActive('any-slug', undefined, 0, 3)).toBe(true);
      expect(isProjectActive('any-slug', undefined, 2, 3)).toBe(true);
      expect(isProjectActive('any-slug', undefined, 3, 3)).toBe(false);
    });

    it('falls back to index-based quota when active_projects is empty array', () => {
      expect(isProjectActive('any-slug', [], 0, 3)).toBe(true);
      expect(isProjectActive('any-slug', [], 3, 3)).toBe(false);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════
   V56: active_projects in validation response
   ═══════════════════════════════════════════════════════════════ */

describe('Integration: active_projects in validation response (V56)', () => {
  it('validateLicense returns active_projects from server response', async () => {
    const payload = makeServerPayload({ active_projects: ['proj-a', 'proj-b'] });
    const serverBody = { data: payload, signature: signPayload(payload) };
    mockFetch.mockResolvedValue(mockFetchResponse(200, serverBody));
    mockedReadCache.mockResolvedValue(null);

    const result = await validateLicense({
      key: LICENSE_KEY,
      machineId: MACHINE_ID,
      boundProjects: [PROJECT_PATH],
    });

    expect(result.success).toBe(true);
    expect(result.active_projects).toEqual(['proj-a', 'proj-b']);
  });

  it('validateLicense returns undefined active_projects when not in response', async () => {
    const payload = makeServerPayload(); // no active_projects field
    const serverBody = { data: payload, signature: signPayload(payload) };
    mockFetch.mockResolvedValue(mockFetchResponse(200, serverBody));
    mockedReadCache.mockResolvedValue(null);

    const result = await validateLicense({
      key: LICENSE_KEY,
      machineId: MACHINE_ID,
      boundProjects: [PROJECT_PATH],
    });

    expect(result.success).toBe(true);
    expect(result.active_projects).toBeUndefined();
  });

  it('validateLicense returns active_projects from cached payload on fallback', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const cachedPayload = makeCache();
    cachedPayload.payload['active_projects'] = ['cached-proj-a'];
    mockedReadCache.mockResolvedValue(cachedPayload);

    const result = await validateLicense({
      key: LICENSE_KEY,
      machineId: MACHINE_ID,
      boundProjects: [PROJECT_PATH],
    });

    expect(result.success).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(result.active_projects).toEqual(['cached-proj-a']);
  });

  it('checkLicenseBeforeTick threads activeProjects to EnforcementResult', async () => {
    const payload = makeServerPayload({ active_projects: ['proj-x'] });
    const serverBody = { data: payload, signature: signPayload(payload) };
    mockFetch.mockResolvedValue(mockFetchResponse(200, serverBody));
    mockedReadCache.mockResolvedValue(null);
    mockedReadSecrets.mockResolvedValue({ license: { key: LICENSE_KEY } });
    mockedReadRegistry.mockReturnValue({
      projects: [{ project_root: PROJECT_PATH, installed_at: '2026-01-01T00:00:00Z' }],
    });
    mockedReadBindingFile.mockResolvedValue({
      license_key_hash: 'abcdef0123456789',
      machine_id: MACHINE_ID,
      bound_at: '2026-01-01T00:00:00Z',
      token: createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID),
    });

    const enforcement = await checkLicenseBeforeTick(HOME);

    expect(enforcement.allowed).toBe(true);
    expect(enforcement.activeProjects).toEqual(['proj-x']);
  });
});

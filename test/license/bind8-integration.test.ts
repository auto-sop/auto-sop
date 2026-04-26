import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LicenseCache } from '../../src/license/cache.js';

/* ─── test X25519 server keypair (vi.hoisted so mock factories can use it) ─── */

const { testServerKP, testServerPubB64 } = vi.hoisted(() => {
  // Must use require() here — vi.hoisted runs before ES imports are resolved
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync: genKP } = require('node:crypto');
  const kp = genKP('x25519');
  const pubB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { testServerKP: kp, testServerPubB64: pubB64 as string };
});

/* ─── module mocks (hoisted by vitest) ─── */

vi.mock('../../src/license/server-public-key.js', () => ({
  API_BASE_URL: 'https://test.auto-sop.com/api/v1',
  SERVER_PUBLIC_KEY_B64: 'unused-ed25519-key',
  SERVER_X25519_PUBLIC_KEY_B64: testServerPubB64,
}));

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
  verifyServerSignature: vi.fn(() => true),
  validateResponseFreshness: vi.fn(() => true),
}));

/* ─── imports (after mocks) ─── */

import { validateLicense } from '../../src/license/server-client.js';
import { readCache, writeCache } from '../../src/license/cache.js';
import {
  verifyServerSignature,
  validateResponseFreshness,
} from '../../src/license/ed25519-verify.js';
import { serverDecrypt } from '../helpers/x25519-test-utils.js';

const mockedReadCache = vi.mocked(readCache);
const mockedWriteCache = vi.mocked(writeCache);
const mockedVerifySignature = vi.mocked(verifyServerSignature);
const mockedValidateFreshness = vi.mocked(validateResponseFreshness);

/* ─── helpers ─── */

const DAY_MS = 24 * 60 * 60 * 1000;

const OPTS = {
  key: 'LIC-BIND8-TEST',
  machineId: 'machine-bind8',
  boundProjects: ['/proj/alpha', '/proj/beta'],
  bindingHashes: ['hash-a', 'hash-b'],
  cliHash: 'cli-hash-test',
  cliVersion: '2.0.0',
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

/* ─── per-test setup ─── */

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockedVerifySignature.mockReturnValue(true);
  mockedValidateFreshness.mockReturnValue(true);
  mockedWriteCache.mockResolvedValue(undefined);
  mockedReadCache.mockResolvedValue(null);
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ─── BIND-8 integration tests ─── */

describe('BIND-8 encrypted validate request', () => {
  it('sends encrypted request with application/x-asop-encrypted content type', async () => {
    const data = serverPayload();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data, signature: 'sig-ok' }),
    });

    await validateLicense(OPTS);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers['Content-Type']).toBe('application/x-asop-encrypted');
  });

  it('body contains ephemeral_public, nonce, ciphertext as hex strings', async () => {
    const data = serverPayload();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data, signature: 'sig-ok' }),
    });

    await validateLicense(OPTS);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.ephemeral_public).toMatch(/^[0-9a-f]{64}$/);
    expect(body.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(body.ciphertext).toMatch(/^[0-9a-f]+$/);
  });

  it('server can decrypt the request body and recover original payload', async () => {
    const data = serverPayload();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data, signature: 'sig-ok' }),
    });

    await validateLicense(OPTS);

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    const decrypted = serverDecrypt(body.ephemeral_public, body.nonce, body.ciphertext, testServerKP.privateKey);
    const payload = JSON.parse(decrypted);

    expect(payload.key).toBe('LIC-BIND8-TEST');
    expect(payload.machine_id).toBe('machine-bind8');
    expect(payload.bound_projects).toEqual(['/proj/alpha', '/proj/beta']);
    expect(payload.binding_hashes).toEqual(['hash-a', 'hash-b']);
    expect(payload.cli_hash).toBe('cli-hash-test');
    expect(payload.cli_version).toBe('2.0.0');
  });

  it('each request uses a different ephemeral key (forward secrecy)', async () => {
    const data = serverPayload();
    const mockResponse = () => ({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data, signature: 'sig-ok' }),
    });
    mockFetch.mockResolvedValueOnce(mockResponse());
    mockFetch.mockResolvedValueOnce(mockResponse());

    await validateLicense(OPTS);
    await validateLicense(OPTS);

    const body1 = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    const body2 = JSON.parse(mockFetch.mock.calls[1]![1].body as string);
    expect(body1.ephemeral_public).not.toBe(body2.ephemeral_public);
  });

  it('falls back to plain JSON when encryption fails', async () => {
    const x25519Mod = await import('../../src/license/x25519-encrypt.js');
    const encryptSpy = vi.spyOn(x25519Mod, 'encryptRequest').mockImplementation(() => {
      throw new Error('crypto unavailable');
    });

    const data = serverPayload();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data, signature: 'sig-ok' }),
    });

    await validateLicense(OPTS);

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.key).toBe('LIC-BIND8-TEST');
    expect(body.machine_id).toBe('machine-bind8');
    expect(body.bound_projects).toEqual(['/proj/alpha', '/proj/beta']);
    // No encryption fields in plain fallback
    expect(body.ephemeral_public).toBeUndefined();
    expect(body.nonce).toBeUndefined();
    expect(body.ciphertext).toBeUndefined();

    encryptSpy.mockRestore();
  });

  it('validate succeeds end-to-end with encrypted request', async () => {
    const data = serverPayload();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data, signature: 'sig-ok' }),
    });

    const result = await validateLicense(OPTS);

    expect(result.success).toBe(true);
    expect(result.payload).toBeDefined();
    expect(result.payload!['plan']).toBe('pro');
    expect(mockedWriteCache).toHaveBeenCalledOnce();
  });
});

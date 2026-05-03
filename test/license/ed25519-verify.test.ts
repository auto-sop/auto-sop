import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import {
  verifyServerSignature,
  validateResponseFreshness,
} from '../../src/license/ed25519-verify.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

/* ─── helpers ─── */

function makeEd25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pemPublic = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const b64Public = Buffer.from(pemPublic).toString('base64');
  return { publicKey, privateKey, b64Public };
}

function signPayload(
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  return sign(null, data, privateKey).toString('hex');
}

/* ─── verifyServerSignature ─── */

describe('verifyServerSignature', () => {
  const { b64Public, privateKey } = makeEd25519KeyPair();

  const payload = {
    license_key_hash: 'abc123',
    status: 'active',
    nonce: 'test-nonce-1',
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2027-01-01T00:00:00Z',
  };

  it('returns true for valid signature', () => {
    const sig = signPayload(payload, privateKey);
    expect(verifyServerSignature(payload, sig, b64Public)).toBe(true);
  });

  it('returns false when payload is tampered', () => {
    const sig = signPayload(payload, privateKey);
    const tampered = { ...payload, status: 'revoked' };
    expect(verifyServerSignature(tampered, sig, b64Public)).toBe(false);
  });

  it('returns false when signature is tampered', () => {
    const sig = signPayload(payload, privateKey);
    // Flip a byte in the middle of the hex string
    const chars = sig.split('');
    const idx = Math.floor(chars.length / 2);
    chars[idx] = chars[idx] === 'a' ? 'b' : 'a';
    const tamperedSig = chars.join('');
    expect(verifyServerSignature(payload, tamperedSig, b64Public)).toBe(false);
  });

  it('returns false for completely invalid signature hex', () => {
    expect(verifyServerSignature(payload, 'not-hex', b64Public)).toBe(false);
  });

  it('returns false for wrong key', () => {
    const otherKp = makeEd25519KeyPair();
    const sig = signPayload(payload, privateKey);
    expect(verifyServerSignature(payload, sig, otherKp.b64Public)).toBe(false);
  });

  it('returns false for invalid public key base64', () => {
    const sig = signPayload(payload, privateKey);
    expect(verifyServerSignature(payload, sig, 'not-a-key')).toBe(false);
  });
});

/* ─── validateResponseFreshness ─── */

describe('validateResponseFreshness', () => {
  const now = new Date('2026-06-15T12:00:00Z').getTime();

  function freshPayload(
    overrides: Partial<{ nonce: string; issued_at: string; expires_at: string }> = {},
  ) {
    return {
      nonce: overrides.nonce ?? 'nonce-abc',
      issued_at: overrides.issued_at ?? new Date(now - 60_000).toISOString(), // 1 min ago
      expires_at: overrides.expires_at ?? new Date(now + 24 * 3600_000).toISOString(), // +24h
    };
  }

  it('accepts a fresh, non-replayed response', () => {
    expect(validateResponseFreshness(freshPayload(), undefined, now)).toBe(true);
  });

  it('rejects replayed nonce', () => {
    const p = freshPayload({ nonce: 'same-nonce' });
    expect(validateResponseFreshness(p, 'same-nonce', now)).toBe(false);
  });

  it('accepts when lastNonce is undefined (first call)', () => {
    expect(validateResponseFreshness(freshPayload(), undefined, now)).toBe(true);
  });

  it('accepts when nonce differs from lastNonce', () => {
    const p = freshPayload({ nonce: 'new-nonce' });
    expect(validateResponseFreshness(p, 'old-nonce', now)).toBe(true);
  });

  it('rejects expired response (expires_at in the past)', () => {
    const p = freshPayload({ expires_at: new Date(now - 1000).toISOString() });
    expect(validateResponseFreshness(p, undefined, now)).toBe(false);
  });

  it('rejects when issued_at is too old (>2 hours)', () => {
    const twoHoursAgo = now - 2 * 3600_000 - 1;
    const p = freshPayload({ issued_at: new Date(twoHoursAgo).toISOString() });
    expect(validateResponseFreshness(p, undefined, now)).toBe(false);
  });

  it('rejects when issued_at is in the future', () => {
    const p = freshPayload({ issued_at: new Date(now + 60_000).toISOString() });
    expect(validateResponseFreshness(p, undefined, now)).toBe(false);
  });

  it('rejects invalid date strings', () => {
    const p = freshPayload({ issued_at: 'not-a-date' });
    expect(validateResponseFreshness(p, undefined, now)).toBe(false);
  });

  it('accepts issued_at exactly at boundary (2 hours ago)', () => {
    const exactlyTwoHours = now - 2 * 3600_000;
    const p = freshPayload({ issued_at: new Date(exactlyTwoHours).toISOString() });
    expect(validateResponseFreshness(p, undefined, now)).toBe(true);
  });

  it('rejects expires_at exactly equal to now', () => {
    const p = freshPayload({ expires_at: new Date(now).toISOString() });
    expect(validateResponseFreshness(p, undefined, now)).toBe(false);
  });
});

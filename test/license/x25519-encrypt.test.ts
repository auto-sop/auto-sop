import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { encryptRequest, type EncryptedPayload } from '../../src/license/x25519-encrypt.js';
import { generateTestX25519Keypair, serverDecrypt } from '../helpers/x25519-test-utils.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

/* ─── encryptRequest ─── */

describe('encryptRequest', () => {
  const { b64, privateKey } = generateTestX25519Keypair();

  function decrypt(payload: EncryptedPayload) {
    return serverDecrypt(payload.ephemeral_public, payload.nonce, payload.ciphertext, privateKey);
  }

  it('roundtrip encrypt/decrypt with test keypair', () => {
    const plaintext = '{"key":"LIC-123","machine_id":"m-abc"}';
    const result = encryptRequest(plaintext, b64);
    expect(decrypt(result)).toBe(plaintext);
  });

  it('generates different ephemeral key per call', () => {
    const a = encryptRequest('hello', b64);
    const b = encryptRequest('hello', b64);
    expect(a.ephemeral_public).not.toBe(b.ephemeral_public);
  });

  it('tampered ciphertext fails decryption', () => {
    const result = encryptRequest('sensitive data', b64);
    const chars = result.ciphertext.split('');
    const idx = Math.floor(chars.length / 2);
    chars[idx] = chars[idx] === 'a' ? 'b' : 'a';
    const tampered = { ...result, ciphertext: chars.join('') };
    expect(() => decrypt(tampered)).toThrow();
  });

  it('output contains hex-encoded ephemeral_public, nonce, ciphertext', () => {
    const result = encryptRequest('test', b64);
    expect(result.ephemeral_public).toMatch(/^[0-9a-f]{88}$/);
    expect(result.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(result.ciphertext).toMatch(/^[0-9a-f]+$/);
    // ciphertext must be at least 32 hex chars (16 bytes auth tag minimum)
    expect(result.ciphertext.length).toBeGreaterThanOrEqual(32);
  });

  it('encrypts empty string', () => {
    const result = encryptRequest('', b64);
    expect(decrypt(result)).toBe('');
  });

  it('encrypts unicode content', () => {
    const plaintext = '{"name":"Ugur Gökdere","emoji":"❤️"}';
    const result = encryptRequest(plaintext, b64);
    expect(decrypt(result)).toBe(plaintext);
  });

  it('wrong server key cannot decrypt', () => {
    const other = generateTestX25519Keypair();
    const result = encryptRequest('secret', b64);
    expect(() => serverDecrypt(result.ephemeral_public, result.nonce, result.ciphertext, other.privateKey)).toThrow();
  });
});

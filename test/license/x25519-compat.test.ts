import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { diffieHellman, createDecipheriv, hkdfSync, generateKeyPairSync } from 'node:crypto';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import {
  encryptRequest,
  HKDF_SALT,
  HKDF_INFO,
  AES_KEY_BYTES,
} from '../../src/license/x25519-encrypt.js';
import { serverDecrypt } from '../helpers/x25519-test-utils.js';
import { createPublicKey } from 'node:crypto';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

/* ─── compatibility tests ─── */

describe('X25519 CLI-to-server compatibility', () => {
  const { publicKey: serverPublic, privateKey: serverPrivate } = generateKeyPairSync('x25519');
  const serverPubB64 = serverPublic.export({ type: 'spki', format: 'der' }).toString('base64');

  it('server decrypts CLI-encrypted payload', () => {
    const plaintext = '{"key":"LIC-BIND8-001","machine_id":"m-test-compat"}';
    const { ephemeral_public, nonce, ciphertext } = encryptRequest(plaintext, serverPubB64);
    const decrypted = serverDecrypt(ephemeral_public, nonce, ciphertext, serverPrivate);
    expect(decrypted).toBe(plaintext);
  });

  it('server decrypts large payload', () => {
    const payload = JSON.stringify({
      key: 'LIC-LARGE-PAYLOAD',
      machine_id: 'machine-id-' + 'x'.repeat(200),
      bound_projects: Array.from({ length: 10 }, (_, i) => `/project-${i}`),
      binding_hashes: Array.from({ length: 10 }, (_, i) => `hash-${i}-${'a'.repeat(64)}`),
    });
    const { ephemeral_public, nonce, ciphertext } = encryptRequest(payload, serverPubB64);
    const decrypted = serverDecrypt(ephemeral_public, nonce, ciphertext, serverPrivate);
    expect(decrypted).toBe(payload);
  });

  it('each encryption uses a unique ephemeral key (forward secrecy)', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { ephemeral_public } = encryptRequest(`msg-${i}`, serverPubB64);
      keys.add(ephemeral_public);
    }
    expect(keys.size).toBe(5);
  });

  it('tampered nonce prevents decryption', () => {
    const encrypted = encryptRequest('secret', serverPubB64);
    const badNonce = 'ff'.repeat(12);
    expect(() =>
      serverDecrypt(encrypted.ephemeral_public, badNonce, encrypted.ciphertext, serverPrivate),
    ).toThrow();
  });

  it('tampered ephemeral key prevents decryption', () => {
    const encrypted = encryptRequest('secret', serverPubB64);
    const badKey = 'ff'.repeat(44); // full SPKI DER length (44 bytes = 88 hex)
    expect(() =>
      serverDecrypt(badKey, encrypted.nonce, encrypted.ciphertext, serverPrivate),
    ).toThrow();
  });

  it('HKDF parameters match exactly (salt and info as UTF-8 strings)', () => {
    const plaintext = 'hkdf-param-check';
    const { ephemeral_public, nonce, ciphertext } = encryptRequest(plaintext, serverPubB64);

    // Reconstruct shared secret manually to verify HKDF params
    const ephDer = Buffer.from(ephemeral_public, 'hex');
    const ephPub = createPublicKey({
      key: ephDer,
      format: 'der',
      type: 'spki',
    });
    const sharedSecret = diffieHellman({ privateKey: serverPrivate, publicKey: ephPub });

    // Derive key with exported constants (must match CLI)
    const aesKey = Buffer.from(
      hkdfSync('sha256', sharedSecret, HKDF_SALT, HKDF_INFO, AES_KEY_BYTES),
    );

    const nonceBuf = Buffer.from(nonce, 'hex');
    const ctBuf = Buffer.from(ciphertext, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonceBuf);
    decipher.setAuthTag(ctBuf.subarray(ctBuf.length - 16));
    const decrypted = Buffer.concat([
      decipher.update(ctBuf.subarray(0, ctBuf.length - 16)),
      decipher.final(),
    ]).toString('utf8');

    expect(decrypted).toBe(plaintext);
  });
});

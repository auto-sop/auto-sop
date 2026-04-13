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

import {
  encryptSecrets,
  decryptSecrets,
  readSecretsFile,
  writeSecretsFile,
  type SecretsFileV1,
} from '../../src/config/secrets.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

beforeEach(() => {
  vol.reset();
});

describe('encryptSecrets / decryptSecrets', () => {
  it('encryptSecrets returns SecretsFileV1 with correct fields', async () => {
    const result = await encryptSecrets('hello world');
    expect(result.v).toBe(1);
    expect(result.salt).toMatch(/^[0-9a-f]{32}$/); // 16 bytes hex
    expect(result.iv).toMatch(/^[0-9a-f]{24}$/); // 12 bytes hex
    expect(result.tag).toMatch(/^[0-9a-f]{32}$/); // 16 bytes hex
    expect(typeof result.ciphertext).toBe('string');
    // base64 check
    expect(() => Buffer.from(result.ciphertext, 'base64')).not.toThrow();
  });

  it('round-trips plaintext correctly', async () => {
    const plaintext = 'hello world';
    const encrypted = await encryptSecrets(plaintext);
    const decrypted = await decryptSecrets(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('round-trips empty string', async () => {
    const encrypted = await encryptSecrets('');
    const decrypted = await decryptSecrets(encrypted);
    expect(decrypted).toBe('');
  });

  it('round-trips JSON-shaped license payload (Phase 6 use case)', async () => {
    const payload = JSON.stringify({
      licenseKey: '123',
      trialStartedAt: 1700000000,
    });
    const encrypted = await encryptSecrets(payload);
    const decrypted = await decryptSecrets(encrypted);
    expect(decrypted).toBe(payload);
    expect(JSON.parse(decrypted)).toEqual({
      licenseKey: '123',
      trialStartedAt: 1700000000,
    });
  });

  it('tampering with ciphertext causes decryption to throw', async () => {
    const encrypted = await encryptSecrets('sensitive data');
    // Flip one byte in the ciphertext
    const buf = Buffer.from(encrypted.ciphertext, 'base64');
    buf[0] = buf[0]! ^ 0xff;
    const tampered: SecretsFileV1 = {
      ...encrypted,
      ciphertext: buf.toString('base64'),
    };
    await expect(decryptSecrets(tampered)).rejects.toThrow();
  });

  it('throws on unsupported version', async () => {
    const badVersion = {
      v: 2 as unknown as 1,
      salt: 'aa'.repeat(16),
      iv: 'bb'.repeat(12),
      tag: 'cc'.repeat(16),
      ciphertext: 'dGVzdA==',
    };
    await expect(decryptSecrets(badVersion as SecretsFileV1)).rejects.toThrow(
      'Unsupported secrets.enc version: 2',
    );
  });
});

describe('readSecretsFile / writeSecretsFile', () => {
  it('round-trips via file system', async () => {
    const encrypted = await encryptSecrets('file-round-trip');
    const filePath = '/tmp/test-secrets/secrets.enc';
    await writeSecretsFile(filePath, encrypted);

    const read = await readSecretsFile(filePath);
    expect(read).not.toBeNull();
    expect(read!.v).toBe(1);
    expect(read!.salt).toBe(encrypted.salt);
    expect(read!.iv).toBe(encrypted.iv);
    expect(read!.tag).toBe(encrypted.tag);
    expect(read!.ciphertext).toBe(encrypted.ciphertext);

    // Full round-trip: decrypt the read-back file
    const decrypted = await decryptSecrets(read!);
    expect(decrypted).toBe('file-round-trip');
  });

  it('readSecretsFile returns null on ENOENT', async () => {
    const result = await readSecretsFile('/tmp/nonexistent/secrets.enc');
    expect(result).toBeNull();
  });
});

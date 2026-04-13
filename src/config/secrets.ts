import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { getMachineId } from './machine-id.js';

export interface SecretsFileV1 {
  v: 1;
  salt: string; // hex, 16 bytes
  iv: string; // hex, 12 bytes (GCM)
  tag: string; // hex, 16 bytes
  ciphertext: string; // base64
}

function deriveKey(machineId: string, saltHex: string): Buffer {
  return scryptSync(machineId, Buffer.from(saltHex, 'hex'), 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
}

export async function encryptSecrets(plaintext: string): Promise<SecretsFileV1> {
  const machineId = await getMachineId();
  const salt = randomBytes(16);
  const key = deriveKey(machineId, salt.toString('hex'));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: enc.toString('base64'),
  };
}

export async function decryptSecrets(file: SecretsFileV1): Promise<string> {
  if (file.v !== 1) throw new Error(`Unsupported secrets.enc version: ${file.v}`);
  const machineId = await getMachineId();
  const key = deriveKey(machineId, file.salt);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

export async function readSecretsFile(path: string): Promise<SecretsFileV1 | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as SecretsFileV1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeSecretsFile(path: string, file: SecretsFileV1): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await fs.rename(tmp, path);
}

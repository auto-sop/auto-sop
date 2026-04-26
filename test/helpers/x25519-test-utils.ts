import {
  generateKeyPairSync,
  diffieHellman,
  createPublicKey,
  createDecipheriv,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import { HKDF_SALT, HKDF_INFO, AES_KEY_BYTES } from '../../src/license/x25519-encrypt.js';

export const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export function generateTestX25519Keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const b64 = spkiDer.toString('base64');
  return { publicKey, privateKey, b64 };
}

export function serverDecrypt(
  ephemeralPublicHex: string,
  nonceHex: string,
  ciphertextHex: string,
  serverPrivateKey: KeyObject,
): string {
  const rawEphemeral = Buffer.from(ephemeralPublicHex, 'hex');
  const ephemeralPublic = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, rawEphemeral]),
    format: 'der',
    type: 'spki',
  });

  const sharedSecret = diffieHellman({
    privateKey: serverPrivateKey,
    publicKey: ephemeralPublic,
  });

  const aesKey = Buffer.from(
    hkdfSync('sha256', sharedSecret, HKDF_SALT, HKDF_INFO, AES_KEY_BYTES),
  );

  const nonce = Buffer.from(nonceHex, 'hex');
  const ctBuf = Buffer.from(ciphertextHex, 'hex');
  const encrypted = ctBuf.subarray(0, ctBuf.length - 16);
  const authTag = ctBuf.subarray(ctBuf.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

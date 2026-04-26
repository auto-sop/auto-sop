import {
  generateKeyPairSync,
  diffieHellman,
  createPublicKey,
  createCipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

export const HKDF_SALT = 'auto-sop-bind8-v1';
export const HKDF_INFO = 'request-encryption';
export const AES_KEY_BYTES = 32;
export const NONCE_BYTES = 12;

export interface EncryptedPayload {
  ephemeral_public: string;
  nonce: string;
  ciphertext: string;
}

export function encryptRequest(
  plaintext: string,
  serverPublicKeyB64: string,
): EncryptedPayload {
  const { publicKey: ephemeralPublic, privateKey: ephemeralPrivate } =
    generateKeyPairSync('x25519');

  const serverPublicKey = createPublicKey({
    key: Buffer.from(serverPublicKeyB64, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const sharedSecret = diffieHellman({
    privateKey: ephemeralPrivate,
    publicKey: serverPublicKey,
  });

  const aesKey = Buffer.from(
    hkdfSync('sha256', sharedSecret, HKDF_SALT, HKDF_INFO, AES_KEY_BYTES),
  );

  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const rawEphemeralPub = ephemeralPublic
    .export({ type: 'spki', format: 'der' })
    .subarray(-32);

  return {
    ephemeral_public: rawEphemeralPub.toString('hex'),
    nonce: nonce.toString('hex'),
    ciphertext: Buffer.concat([encrypted, authTag]).toString('hex'),
  };
}

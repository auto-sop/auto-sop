/**
 * Ed25519 signature verification for server-signed license responses.
 * Uses only Node.js built-in crypto — no external dependencies.
 */
import { createPublicKey, verify } from 'node:crypto';
import { SERVER_PUBLIC_KEY_B64 } from './server-public-key.js';

/** Decode the embedded PEM public key from base64. */
function loadPublicKey(b64Pem: string = SERVER_PUBLIC_KEY_B64) {
  const pem = Buffer.from(b64Pem, 'base64').toString('utf8');
  return createPublicKey(pem);
}

/**
 * Verify an Ed25519 signature over a JSON payload.
 *
 * @param payload  - The response body object (will be JSON.stringify'd)
 * @param signatureHex - Hex-encoded Ed25519 signature from the server
 * @param publicKeyB64 - Optional override for the public key (testing)
 * @returns true if valid, false otherwise
 */
export function verifyServerSignature(
  payload: Record<string, unknown>,
  signatureHex: string,
  publicKeyB64?: string,
): boolean {
  try {
    const key = loadPublicKey(publicKeyB64);
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = Buffer.from(signatureHex, 'hex');
    // Ed25519 uses algorithm: null
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}

export interface FreshnessPayload {
  nonce: string;
  issued_at: string; // ISO 8601
  expires_at: string; // ISO 8601
  [key: string]: unknown;
}

/** Maximum age of issued_at before we reject the response (2 hours). */
const MAX_ISSUED_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Validate freshness constraints on a server response to prevent replay.
 *
 * @param payload   - Must contain nonce, issued_at, expires_at
 * @param lastNonce - Previous nonce to detect replays (optional)
 * @param now       - Current time for testing (defaults to Date.now())
 * @returns true if the response is fresh and not replayed
 */
export function validateResponseFreshness(
  payload: FreshnessPayload,
  lastNonce?: string,
  now: number = Date.now(),
): boolean {
  // Anti-replay: nonce must differ from last seen
  if (lastNonce !== undefined && payload.nonce === lastNonce) {
    return false;
  }

  const issuedAt = new Date(payload.issued_at).getTime();
  const expiresAt = new Date(payload.expires_at).getTime();

  // issued_at must be a valid date
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return false;
  }

  // issued_at must be recent (within 2 hours) — not in the distant past or future
  const age = now - issuedAt;
  if (age < 0 || age > MAX_ISSUED_AGE_MS) {
    return false;
  }

  // expires_at must be in the future
  if (expiresAt <= now) {
    return false;
  }

  return true;
}

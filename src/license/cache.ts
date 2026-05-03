/**
 * License cache with grace period for offline operation.
 * Caches the last successful server validation response.
 * No external dependencies — Node.js built-ins only.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic/write.js';

/** Grace period: how many days to allow after the first validation failure. */
export const GRACE_PERIOD_DAYS = 7;

export const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/** Default cache path: ~/.auto-sop/state/license-cache.json */
export function defaultCachePath(): string {
  return join(homedir(), '.auto-sop', 'state', 'license-cache.json');
}

export interface LicenseCachePayload {
  expires_at: string; // ISO 8601
  [key: string]: unknown;
}

export interface LicenseCache {
  /** ISO 8601 — when the cache was last successfully validated */
  validated_at: string;
  /** Last nonce received from the server (for anti-replay) */
  last_nonce: string;
  /** The server's validated payload */
  payload: LicenseCachePayload;
  /** Hex-encoded Ed25519 signature over the payload */
  signature: string;
  /** Number of consecutive validation failures since last success */
  consecutive_failures: number;
  /** ISO 8601 — when the first failure in the current streak occurred */
  first_failure_at?: string | undefined;
}

/**
 * Read the license cache from disk.
 * Returns null if missing, corrupt, or unreadable.
 */
export async function readCache(
  cachePath: string = defaultCachePath(),
): Promise<LicenseCache | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidCache(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Minimal shape check for a cache object. */
function isValidCache(v: unknown): v is LicenseCache {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.validated_at === 'string' &&
    typeof o.last_nonce === 'string' &&
    typeof o.payload === 'object' &&
    o.payload !== null &&
    typeof o.signature === 'string' &&
    typeof o.consecutive_failures === 'number'
  );
}

/**
 * Write the license cache atomically with mode 0600.
 * Creates parent directories if needed.
 */
export async function writeCache(
  cache: LicenseCache,
  cachePath: string = defaultCachePath(),
): Promise<void> {
  await writeFileAtomic(cachePath, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Check whether the cached payload is still valid (not expired).
 * A cache is valid if payload.expires_at is in the future.
 */
export function isCacheValid(cache: LicenseCache, now: number = Date.now()): boolean {
  const expiresAt = new Date(cache.payload.expires_at).getTime();
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > now;
}

/**
 * Check whether the grace period has expired.
 * Grace is expired when:
 *   1. There have been consecutive failures (consecutive_failures > 0)
 *   2. The first failure occurred more than GRACE_PERIOD_DAYS ago
 */
export function isGraceExpired(cache: LicenseCache, now: number = Date.now()): boolean {
  if (cache.consecutive_failures <= 0) return false;
  if (cache.first_failure_at === undefined) return false;
  const firstFailure = new Date(cache.first_failure_at).getTime();
  if (Number.isNaN(firstFailure)) return false;
  return now > firstFailure + GRACE_PERIOD_MS;
}

/**
 * Increment the failure counter.
 * Sets first_failure_at if this is the first failure in the streak.
 * Returns a new object (does not mutate).
 */
export function incrementFailure(cache: LicenseCache, now: number = Date.now()): LicenseCache {
  return {
    ...cache,
    consecutive_failures: cache.consecutive_failures + 1,
    first_failure_at: cache.first_failure_at ?? new Date(now).toISOString(),
  };
}

/**
 * Reset failures to zero (called after a successful validation).
 * Returns a new object (does not mutate).
 */
export function resetFailures(cache: LicenseCache): LicenseCache {
  return {
    ...cache,
    consecutive_failures: 0,
    first_failure_at: undefined,
  };
}

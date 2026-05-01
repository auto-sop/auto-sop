/**
 * Server validation client with cache fallback.
 * Uses Node.js native fetch — no external dependencies.
 */
import {
  verifyServerSignature,
  validateResponseFreshness,
  type FreshnessPayload,
} from './ed25519-verify.js';
import { SERVER_X25519_PUBLIC_KEY_B64 } from './server-public-key.js';
import { API_BASE_URL } from '../config/environment.js';
import { encryptRequest } from './x25519-encrypt.js';
import {
  readCache,
  writeCache,
  isCacheValid,
  isGraceExpired,
  incrementFailure,
  resetFailures,
  GRACE_PERIOD_MS,
  type LicenseCache,
  type LicenseCachePayload,
} from './cache.js';

/** Timeout for server requests in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

export interface ValidateOpts {
  key: string;
  machineId: string;
  boundProjects: string[];
  bindingHashes?: string[] | undefined;
  cliHash?: string | undefined;
  cliVersion?: string | undefined;
}

export interface ValidateResult {
  success: boolean;
  payload?: LicenseCachePayload | undefined;
  error?: string | undefined;
  fromCache?: boolean | undefined;
  message?: string | undefined;
  active_projects?: string[] | undefined;
}

export interface ValidationStatus {
  lastValidated: string | null;
  graceRemaining: number | null;
  isOnline: boolean;
  plan: string | null;
  maxProjects: number | null;
}

/** Shape of the server's JSON response body. */
interface ServerResponse {
  data: FreshnessPayload & LicenseCachePayload & { valid?: boolean; reason?: string };
  signature: string;
}

/**
 * Validate a license key against the server.
 * Falls back to cached validation when the server is unreachable.
 */
export async function validateLicense(opts: ValidateOpts): Promise<ValidateResult> {
  const { key, machineId, boundProjects, bindingHashes, cliHash, cliVersion } = opts;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      const rawBody = JSON.stringify({
        key,
        machine_id: machineId,
        bound_projects: boundProjects,
        binding_hashes: bindingHashes,
        cli_hash: cliHash,
        cli_version: cliVersion,
      });

      let contentType = 'application/json';
      let finalBody = rawBody;
      try {
        const encrypted = encryptRequest(rawBody, SERVER_X25519_PUBLIC_KEY_B64);
        contentType = 'application/x-asop-encrypted';
        finalBody = JSON.stringify(encrypted);
      } catch (err) {
        console.warn('[BIND-8] Request encryption unavailable, falling back to plaintext:', err instanceof Error ? err.message : String(err));
      }

      response = await fetch(`${API_BASE_URL}/license/validate`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: finalBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    // 401: invalid key — don't touch cache
    if (response.status === 401) {
      return { success: false, error: 'invalid_key' };
    }

    // 429: rate limited — use cache, don't increment failure
    if (response.status === 429) {
      return fallbackToCache(false);
    }

    // 5xx: server error — use cache, increment failure
    if (response.status >= 500) {
      return fallbackToCache(true);
    }

    // Other non-2xx — treat as server error
    if (!response.ok) {
      return fallbackToCache(true);
    }

    const body = (await response.json()) as ServerResponse;

    // Verify Ed25519 signature over the data payload
    if (!verifyServerSignature(body.data as Record<string, unknown>, body.signature)) {
      return { success: false, error: 'invalid_signature' };
    }

    // Check freshness / anti-replay using last nonce from cache
    const existingCache = await readCache();
    const lastNonce = existingCache?.last_nonce;
    if (!validateResponseFreshness(body.data, lastNonce)) {
      return { success: false, error: 'replay_detected' };
    }

    // BIND-7: Handle tampered_client response — hard failure, not cacheable,
    // not grace-eligible. Do NOT fall back to cache.
    if (body.data.valid === false && body.data.reason === 'tampered_client') {
      return {
        success: false,
        error: 'tampered_client',
        message: 'CLI integrity check failed. Please reinstall: npm install -g auto-sop',
      };
    }

    // Success — write fresh cache, using resetFailures() to clear any prior failure streak
    const newCache: LicenseCache = resetFailures({
      validated_at: new Date().toISOString(),
      last_nonce: body.data.nonce,
      payload: body.data as LicenseCachePayload,
      signature: body.signature,
      consecutive_failures: 0,
      first_failure_at: undefined,
    });
    await writeCache(newCache);

    // Extract active_projects from server response (V56: project toggles)
    const activeProjects = Array.isArray(body.data.active_projects)
      ? (body.data.active_projects as string[])
      : undefined;

    return { success: true, payload: body.data as LicenseCachePayload, active_projects: activeProjects };
  } catch {
    // Network errors: connection refused, DNS failure, abort timeout, JSON parse
    return fallbackToCache(true);
  }
}

/**
 * Fall back to the license cache when the server is unreachable.
 *
 * @param shouldIncrementFailure - Whether to bump consecutive_failures
 */
async function fallbackToCache(shouldIncrementFailure: boolean): Promise<ValidateResult> {
  const cache = await readCache();

  if (cache === null) {
    return { success: false, error: 'no_cache' };
  }

  let currentCache = cache;
  if (shouldIncrementFailure) {
    currentCache = incrementFailure(cache);
    await writeCache(currentCache);
  }

  if (isGraceExpired(currentCache)) {
    return { success: false, error: 'grace_expired' };
  }

  // Extract active_projects from cached payload (V56: project toggles)
  const cachedActiveProjects = Array.isArray(currentCache.payload['active_projects'])
    ? (currentCache.payload['active_projects'] as string[])
    : undefined;

  // Cache payload still fresh (expires_at in the future) — normal cache hit
  if (isCacheValid(currentCache)) {
    return { success: true, payload: currentCache.payload, fromCache: true, active_projects: cachedActiveProjects };
  }

  // Cache payload expired but grace period still active — allow with warning
  return { success: true, payload: currentCache.payload, fromCache: true, active_projects: cachedActiveProjects };
}

/**
 * Get the current validation status from the cache.
 * For display by the `status` CLI verb.
 */
export async function getValidationStatus(): Promise<ValidationStatus> {
  const cache = await readCache();

  if (cache === null) {
    return {
      lastValidated: null,
      graceRemaining: null,
      isOnline: false,
      plan: null,
      maxProjects: null,
    };
  }

  let graceRemaining: number | null = null;
  if (cache.consecutive_failures > 0 && cache.first_failure_at !== undefined) {
    const firstFailure = new Date(cache.first_failure_at).getTime();
    const elapsed = Date.now() - firstFailure;
    graceRemaining = Math.max(0, GRACE_PERIOD_MS - elapsed);
  }

  const plan =
    typeof cache.payload['plan'] === 'string' ? cache.payload['plan'] : null;
  const maxProjects =
    typeof cache.payload['max_projects'] === 'number'
      ? cache.payload['max_projects']
      : null;

  return {
    lastValidated: cache.validated_at,
    graceRemaining,
    isOnline: cache.consecutive_failures === 0,
    plan,
    maxProjects,
  };
}

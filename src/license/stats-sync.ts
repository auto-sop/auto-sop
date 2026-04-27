/**
 * Stats sync client — sends per-project metrics to the server.
 * Uses X25519 encrypted channel (same security model as validate).
 * Fail-open: never throws, always returns { success, error? }.
 */
import { encryptRequest } from './x25519-encrypt.js';
import { API_BASE_URL, SERVER_X25519_PUBLIC_KEY_B64 } from './server-public-key.js';

/** Timeout for stats sync requests in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

export interface ProjectStats {
  project_slug: string;
  total_tokens_saved: number;
  total_errors_prevented: number;
  total_time_saved_minutes: number;
  directive_count: number;
  /** V46: total confirmed fires from Claude self-reports. */
  confirmed_fires_total?: number;
  /** V46: per-directive confirmed fire counts. */
  confirmed_fires_by_directive?: Record<string, number>;
  /** V46: list of active directive short IDs. */
  directive_ids?: string[];
  /** V46: estimation method used for token savings. */
  estimation_method?: string;
}

export interface SyncStatsOpts {
  key: string;
  machineId: string;
  projects: ProjectStats[];
}

export interface SyncStatsResult {
  success: boolean;
  error?: string;
}

/**
 * Send encrypted stats payload to POST /api/v1/stats.
 * Returns { success: true } on 200, { success: false, error } on any failure.
 * NEVER throws — all errors are caught and returned as error strings.
 */
export async function syncStats(opts: SyncStatsOpts): Promise<SyncStatsResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      const rawBody = JSON.stringify({
        key: opts.key,
        machine_id: opts.machineId,
        projects: opts.projects,
      });

      const encrypted = encryptRequest(rawBody, SERVER_X25519_PUBLIC_KEY_B64);
      const finalBody = JSON.stringify(encrypted);

      response = await fetch(`${API_BASE_URL}/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-asop-encrypted' },
        body: finalBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 200) {
      return { success: true };
    }

    if (response.status === 401) {
      return { success: false, error: 'invalid_key' };
    }

    if (response.status === 403) {
      return { success: false, error: 'forbidden' };
    }

    if (response.status === 429) {
      return { success: false, error: 'rate_limited' };
    }

    if (response.status >= 500) {
      return { success: false, error: `server_error_${response.status}` };
    }

    return { success: false, error: `http_${response.status}` };
  } catch (err) {
    // Network errors: connection refused, DNS failure, abort timeout, etc.
    if (err instanceof Error && err.name === 'AbortError') {
      return { success: false, error: 'timeout' };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

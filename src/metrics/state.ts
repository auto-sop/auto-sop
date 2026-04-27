import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../atomic/index.js';

export interface DirectiveAttribution {
  directive_id: string;
  tokens_saved: number;
  errors_prevented: number;
  time_saved_minutes: number;
}

export interface MetricsState {
  v: 1;
  project_slug: string;
  total_tokens_saved: number;
  total_errors_prevented: number;
  total_time_saved_minutes: number;
  directive_count?: number;
  estimation_method?: 'byte_counted' | 'tool_call_heuristic';
  per_directive_attribution: DirectiveAttribution[];
  last_computed_at: string;
}

/** Approximate tokens an LLM processes per minute of wall-clock time. */
export const TOKENS_PER_MINUTE = 200;

const METRICS_DIR = 'metrics';

/**
 * Hash a project root path to a safe filename.
 * Uses SHA-256 truncated to 16 hex chars.
 */
export function projectHash(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}

/**
 * Build path: ~/.auto-sop/state/metrics/{hash}.json
 */
export function metricsStatePath(homeDir: string, projectRoot: string): string {
  return join(homeDir, '.auto-sop', 'state', METRICS_DIR, `${projectHash(projectRoot)}.json`);
}

/**
 * Load metrics state from disk. Returns null if file doesn't exist or is corrupt.
 */
export function loadMetricsState(homeDir: string, projectRoot: string): MetricsState | null {
  const path = metricsStatePath(homeDir, projectRoot);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.project_slug !== 'string') return null;
    return parsed as unknown as MetricsState;
  } catch {
    return null;
  }
}

/**
 * Save metrics state atomically (temp + fsync + rename).
 * Creates directory structure if needed. File mode 0600.
 */
export async function saveMetricsState(
  homeDir: string,
  projectRoot: string,
  state: MetricsState,
): Promise<void> {
  const path = metricsStatePath(homeDir, projectRoot);
  const dir = join(homeDir, '.auto-sop', 'state', METRICS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(state));
}

/**
 * Create an empty metrics state for a project.
 */
export function emptyMetricsState(projectSlug: string): MetricsState {
  return {
    v: 1,
    project_slug: projectSlug,
    total_tokens_saved: 0,
    total_errors_prevented: 0,
    total_time_saved_minutes: 0,
    per_directive_attribution: [],
    last_computed_at: new Date().toISOString(),
  };
}

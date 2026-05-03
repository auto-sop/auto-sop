/**
 * Sync Queue — JSONL-based queue for cloud sync (Phase 8 prep).
 *
 * Appends per-tick summaries to sync-queue.jsonl for eventual push to
 * the SaaS backend. Best-effort: write failures are silently swallowed
 * so they never block the learner tick.
 */
import { appendFileSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { nanoid } from 'nanoid';
import type { BeforeAfterComparison, TokenEstimate } from './session-metrics.js';

// ─── Constants ──────────────────────────────────────────

const SYNC_QUEUE_FILE = 'sync-queue.jsonl';

// ─── Types ──────────────────────────────────────────────

export interface SyncEntry {
  v: 1;
  t: string;
  project_id: string;
  project_slug: string;
  tick_id: string;
  directives_active: number;
  fires_total: number;
  fires_by_category: {
    error_preventing: number;
    efficiency: number;
    best_practice: number;
  };
  errors_prevented_total: number;
  session_comparison: BeforeAfterComparison | null;
  token_estimate: TokenEstimate | null;
}

export interface BuildSyncEntryOpts {
  projectId: string;
  projectSlug: string;
  tickId: string;
  directivesActive: number;
  firesTotal: number;
  firesByCategory: {
    error_preventing: number;
    efficiency: number;
    best_practice: number;
  };
  errorsPrevented: number;
  sessionComparison: BeforeAfterComparison | null;
  tokenEstimate: TokenEstimate | null;
}

// ─── Public API ─────────────────────────────────────────

/**
 * Build a SyncEntry from tick output. Stamps the current ISO timestamp.
 */
export function buildSyncEntry(opts: BuildSyncEntryOpts): SyncEntry {
  return {
    v: 1,
    t: new Date().toISOString(),
    project_id: opts.projectId,
    project_slug: opts.projectSlug,
    tick_id: opts.tickId,
    directives_active: opts.directivesActive,
    fires_total: opts.firesTotal,
    fires_by_category: { ...opts.firesByCategory },
    errors_prevented_total: opts.errorsPrevented,
    session_comparison: opts.sessionComparison,
    token_estimate: opts.tokenEstimate,
  };
}

/**
 * Append a sync entry to the JSONL queue. Best-effort — NEVER throws.
 */
export function appendSyncEntry(stateDir: string, entry: SyncEntry): void {
  try {
    const filePath = join(stateDir, SYNC_QUEUE_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // best-effort — swallow errors
  }
}

/**
 * Read all sync entries from the JSONL queue. Skips malformed lines.
 */
export function readSyncEntries(stateDir: string): SyncEntry[] {
  const filePath = join(stateDir, SYNC_QUEUE_FILE);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const entries: SyncEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SyncEntry;
      if (parsed.v === 1 && parsed.t && parsed.project_id) {
        entries.push(parsed);
      }
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

export interface CompactResult {
  removed: number;
  kept: number;
}

/**
 * Remove entries older than maxAgeDays from the sync queue.
 * Uses atomic rewrite (write to temp, rename) to avoid corruption.
 * Returns { removed, kept } counts so callers don't need a follow-up read.
 */
export function compactSyncQueue(stateDir: string, maxAgeDays: number): CompactResult {
  const filePath = join(stateDir, SYNC_QUEUE_FILE);
  const entries = readSyncEntries(stateDir);
  if (entries.length === 0) return { removed: 0, kept: 0 };

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const keptEntries: SyncEntry[] = [];
  let removed = 0;

  for (const entry of entries) {
    const entryMs = Date.parse(entry.t);
    if (Number.isFinite(entryMs) && entryMs < cutoffMs) {
      removed++;
    } else {
      keptEntries.push(entry);
    }
  }

  if (removed === 0) return { removed: 0, kept: entries.length };

  // Atomic rewrite
  const tmpPath = join(stateDir, `.${nanoid(10)}.tmp`);
  try {
    const content =
      keptEntries.map((e) => JSON.stringify(e)).join('\n') + (keptEntries.length > 0 ? '\n' : '');
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
  }

  return { removed, kept: keptEntries.length };
}

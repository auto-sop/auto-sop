/**
 * State hygiene utilities — clean orphan markers, nested state dirs,
 * stray .auto-sop directories, and oversized sync queues.
 *
 * Every function is try/catch wrapped and NEVER throws.
 * Designed to run on the hot path (pre-start hooks) with <10ms budget.
 */
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  compactSyncQueue,
  readSyncEntries,
  type CompactResult,
} from '../../learner/sync-queue.js';

// ─── Constants (exported for test assertions) ──────────

/** Default max age for stale turn markers: 24 hours. */
export const STALE_MARKER_MAX_AGE_MS = 86_400_000;

/** Default max sync queue entries before auto-compact triggers. */
export const SYNC_QUEUE_MAX_ENTRIES = 500;

/** Default max age in days for sync queue compaction. */
export const SYNC_QUEUE_MAX_AGE_DAYS = 7;

/** Filename for the binding file that marks a legitimate .auto-sop dir. */
export const BINDING_FILE = 'binding.json';

/** Glob prefix for current-turn markers. */
export const TURN_MARKER_PREFIX = 'current-turn-';

/** Suffix for current-turn marker files. */
export const TURN_MARKER_SUFFIX = '.json';

// ─── cleanStaleMarkers ─────────────────────────────────

export interface StaleMarkerResult {
  removed: number;
}

/**
 * Remove current-turn-*.json files in stateDir that are older than maxAgeMs.
 * Synchronous, <5ms typical. NEVER throws.
 */
export function cleanStaleMarkers(
  stateDir: string,
  maxAgeMs: number = STALE_MARKER_MAX_AGE_MS,
): StaleMarkerResult {
  try {
    if (!existsSync(stateDir)) return { removed: 0 };
    const entries = readdirSync(stateDir);
    const now = Date.now();
    let removed = 0;
    for (const entry of entries) {
      if (!entry.startsWith(TURN_MARKER_PREFIX) || !entry.endsWith(TURN_MARKER_SUFFIX)) continue;
      const fullPath = join(stateDir, entry);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath);
          removed++;
        }
      } catch {
        // best-effort per file
      }
    }
    return { removed };
  } catch {
    return { removed: 0 };
  }
}

// ─── cleanNestedStateDir ───────────────────────────────

/**
 * Remove a nested state/state directory created by a pre-May-3 bug.
 * Returns true if removed, false if not found. NEVER throws.
 */
export function cleanNestedStateDir(stateDir: string): boolean {
  try {
    const nested = join(stateDir, 'state');
    if (!existsSync(nested)) return false;
    const stat = statSync(nested);
    if (!stat.isDirectory()) return false;
    rmSync(nested, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ─── cleanStrayAutoSopDirs ─────────────────────────────

export interface StrayDirResult {
  removed: string[];
}

/**
 * Scan immediate subdirectories of projectRoot for .auto-sop dirs
 * that lack binding.json (contamination from CWD bug).
 * SAFETY: NEVER removes .auto-sop dirs that contain binding.json.
 * NEVER throws.
 */
export function cleanStrayAutoSopDirs(projectRoot: string): StrayDirResult {
  try {
    if (!existsSync(projectRoot)) return { removed: [] };
    const entries = readdirSync(projectRoot, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdirAutoSop = join(projectRoot, entry.name, '.auto-sop');
      try {
        if (!existsSync(subdirAutoSop)) continue;
        const subdirStat = statSync(subdirAutoSop);
        if (!subdirStat.isDirectory()) continue;
        // SAFETY: never remove if binding.json exists
        if (existsSync(join(subdirAutoSop, BINDING_FILE))) continue;
        rmSync(subdirAutoSop, { recursive: true, force: true });
        removed.push(subdirAutoSop);
      } catch {
        // best-effort per subdirectory
      }
    }
    return { removed };
  } catch {
    return { removed: [] };
  }
}

// ─── compactSyncQueueIfNeeded ──────────────────────────

/**
 * Compact the sync queue if it exceeds maxEntries.
 * Returns CompactResult if compaction ran, null if skipped.
 * NEVER throws.
 */
export function compactSyncQueueIfNeeded(
  stateDir: string,
  maxEntries: number = SYNC_QUEUE_MAX_ENTRIES,
  maxAgeDays: number = SYNC_QUEUE_MAX_AGE_DAYS,
): CompactResult | null {
  try {
    const entries = readSyncEntries(stateDir);
    if (entries.length <= maxEntries) return null;
    return compactSyncQueue(stateDir, maxAgeDays);
  } catch {
    return null;
  }
}

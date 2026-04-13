/**
 * Orphan sweep: finalize stale .pending turn dirs and clean up old tmp payloads.
 *
 * Runs as a pre-start hook on every UserPromptSubmit (B2 turn boundary).
 *
 * Thresholds:
 *   - .pending with no activity > 30s → finalize with reason 'timeout'
 *   - .pending with no activity > 30min → quarantine to yarim-kalan/
 *   - tmp payload files older than 1h → delete (max 50 per pass)
 */
import { readdirSync, statSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeMeta } from './meta.js';
import { finalizeTurnDir } from './turn-dir.js';

export const STALE_TIMEOUT_MS = 30_000; // 30 seconds → finalize as timeout
export const STALE_YARIM_KALAN_MS = 30 * 60_000; // 30 minutes → quarantine
export const TMP_MAX_AGE_MS = 60 * 60_000; // 1 hour
export const MAX_TMP_SWEEP_PER_PASS = 50;

export interface SweepResult {
  finalized: number;
  quarantined: number;
  errors: number;
}

/**
 * Get the most recent mtime of a .pending turn dir.
 * Walks one level deep (does NOT recurse into large-outputs/).
 */
function getLastMtime(dir: string): number {
  let maxMtime = 0;
  try {
    const dirStat = statSync(dir);
    maxMtime = dirStat.mtimeMs;
  } catch {
    return 0;
  }

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // Skip large-outputs/ subdirectory — don't recurse
      if (entry === 'large-outputs') continue;
      try {
        const entryPath = join(dir, entry);
        const entryStat = statSync(entryPath);
        if (entryStat.mtimeMs > maxMtime) {
          maxMtime = entryStat.mtimeMs;
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // dir unreadable — use dir mtime only
  }

  return maxMtime;
}

/**
 * Sweep orphaned .pending turn directories.
 *
 * - age > STALE_YARIM_KALAN_MS → move to yarim-kalan/ (quarantine)
 * - age > STALE_TIMEOUT_MS → finalize with reason 'timeout'
 * - Otherwise skip (still active)
 *
 * Order matters: check yarim-kalan first (it's a superset of timeout threshold).
 */
export function sweepOrphanedTurns(
  capturesDir: string,
  yarimKalanDir: string,
  now: number = Date.now(),
): SweepResult {
  const result: SweepResult = { finalized: 0, quarantined: 0, errors: 0 };

  let entries: string[];
  try {
    entries = readdirSync(capturesDir);
  } catch {
    return result; // capturesDir doesn't exist yet — nothing to sweep
  }

  const pendingDirs = entries.filter((name) => name.endsWith('.pending'));

  for (const pendingName of pendingDirs) {
    const pendingPath = join(capturesDir, pendingName);

    try {
      const lastMtime = getLastMtime(pendingPath);
      if (lastMtime === 0) continue; // couldn't stat — skip

      const age = now - lastMtime;

      if (age > STALE_YARIM_KALAN_MS) {
        // Quarantine: move entire dir to yarim-kalan/
        mkdirSync(yarimKalanDir, { recursive: true, mode: 0o700 });
        const dest = join(yarimKalanDir, pendingName);
        renameSync(pendingPath, dest);
        result.quarantined++;
      } else if (age > STALE_TIMEOUT_MS) {
        // Finalize with timeout reason, then drop .pending
        finalizeMeta(pendingPath, 'timeout');
        finalizeTurnDir(pendingPath);
        result.finalized++;
      }
      // else: still active, skip
    } catch {
      result.errors++;
    }
  }

  return result;
}

/**
 * Sweep stale tmp payload files older than TMP_MAX_AGE_MS.
 * Stops after MAX_TMP_SWEEP_PER_PASS deletions to bound latency.
 * Any individual failure continues to the next file.
 */
export function sweepOrphanTmpPayloads(
  tmpDir: string,
  now: number = Date.now(),
): { deleted: number } {
  let deleted = 0;

  let entries: string[];
  try {
    entries = readdirSync(tmpDir);
  } catch {
    return { deleted }; // tmpDir doesn't exist — nothing to sweep
  }

  for (const entry of entries) {
    if (deleted >= MAX_TMP_SWEEP_PER_PASS) break;

    try {
      const filePath = join(tmpDir, entry);
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > TMP_MAX_AGE_MS) {
        unlinkSync(filePath);
        deleted++;
      }
    } catch {
      // Individual failure — continue
    }
  }

  return { deleted };
}

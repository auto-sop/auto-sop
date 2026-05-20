/**
 * repair verb — diagnose and fix managed-section drift deadlock and stale
 * state files.
 *
 * Repair actions:
 *   1. Re-sync managed section hash — reads current CLAUDE.md, computes
 *      hash of managed section, writes to managed-section-hash.json.
 *      If no managed section markers exist, clears the hash store.
 *   2. Clean stale current-turn markers — removes current-turn-*.json
 *      files in state/ older than 1 hour (orphaned session markers).
 *   3. Remove nested state/state directory (legacy bug artifact).
 *   4. Compact sync queue entries older than 7 days.
 *   5. Remove stray .auto-sop directories without binding.json.
 */
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { emit } from '../output/json.js';
import { findMarkers } from '../../managed-section/markers.js';
import {
  readLastHash,
  writeLastHash,
  clearLastHash,
  sha256,
} from '../../managed-section/hash-store.js';
import {
  cleanStaleMarkers,
  cleanNestedStateDir,
  cleanStrayAutoSopDirs,
  STALE_MARKER_MAX_AGE_MS,
  SYNC_QUEUE_MAX_AGE_DAYS,
} from '../../capture/writer/state-hygiene.js';
import { compactSyncQueue } from '../../learner/sync-queue.js';

export interface RepairResult {
  hashResynced: boolean;
  hashCleared: boolean;
  /** @deprecated Use markersRemoved. Kept for JSON API backward compatibility. */
  staleTurnMarkersRemoved: number;
  /** Number of stale turn markers removed. */
  markersRemoved: number;
  nestedStateRemoved: boolean;
  syncCompacted: { removed: number; kept: number } | null;
  strayDirsRemoved: string[];
  details: string[];
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export interface RepairFlags {
  cleanMarkers?: boolean;
  compactSync?: boolean;
  cleanStray?: boolean;
}

/**
 * Core repair logic — exported for testing.
 *
 * When flags is undefined or empty, all hygiene actions run (default).
 * When flags has explicit boolean values, only the flagged actions run.
 */
export function runRepair(projectRoot: string, flags?: RepairFlags): RepairResult {
  const runAll = !flags || (!flags.cleanMarkers && !flags.compactSync && !flags.cleanStray);

  const result: RepairResult = {
    hashResynced: false,
    hashCleared: false,
    staleTurnMarkersRemoved: 0,
    markersRemoved: 0,
    nestedStateRemoved: false,
    syncCompacted: null,
    strayDirsRemoved: [],
    details: [],
  };

  // ── 1. Re-sync managed section hash ──────────────────────
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  let fileContent: string | null = null;
  try {
    fileContent = readFileSync(claudeMdPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  let markers: ReturnType<typeof findMarkers> = null;
  if (fileContent !== null) {
    try {
      markers = findMarkers(fileContent);
    } catch {
      // Malformed markers — treat as no section
      markers = null;
    }
  }

  if (markers !== null && fileContent !== null) {
    // Managed section exists — compute hash and compare with stored
    const currentHash = sha256(fileContent.slice(markers.beginStart, markers.endAfter));
    const stored = readLastHash(projectRoot);

    if (stored === null || stored.lastHash !== currentHash) {
      writeLastHash(projectRoot, currentHash);
      result.hashResynced = true;
      result.details.push(
        stored === null
          ? 'Hash store was empty — initialized from current managed section'
          : `Hash drift detected (stored: ${stored.lastHash.slice(0, 8)}… vs current: ${currentHash.slice(0, 8)}…) — re-synced`,
      );
    }
  } else {
    // No managed section — clear hash if one exists
    const stored = readLastHash(projectRoot);
    if (stored !== null) {
      clearLastHash(projectRoot);
      result.hashCleared = true;
      result.details.push('No managed section markers found — cleared stale hash store');
    }
  }

  // ── 2. Clean stale current-turn markers ──────────────────
  // Uses cleanStaleMarkers with repair's 1h threshold by default.
  // When --clean-markers flag is used alone, uses the 24h threshold
  // matching the pre-start hook behavior.
  const stateDir = path.join(projectRoot, '.auto-sop', 'state');
  if (runAll) {
    const markerResult = cleanStaleMarkers(stateDir, STALE_THRESHOLD_MS);
    result.staleTurnMarkersRemoved = markerResult.removed;
    result.markersRemoved = markerResult.removed;
    if (markerResult.removed > 0) {
      result.details.push(
        `Removed ${markerResult.removed} stale current-turn marker(s)`,
      );
    }
  } else if (flags?.cleanMarkers) {
    const markerResult = cleanStaleMarkers(stateDir, STALE_MARKER_MAX_AGE_MS);
    result.staleTurnMarkersRemoved = markerResult.removed;
    result.markersRemoved = markerResult.removed;
    if (markerResult.removed > 0) {
      result.details.push(
        `Cleaned ${markerResult.removed} orphan marker(s) older than 24h`,
      );
    }
  }

  // ── 3. State hygiene: nested state/state dir ──────────
  if (runAll) {
    const nested = cleanNestedStateDir(stateDir);
    result.nestedStateRemoved = nested;
    if (nested) {
      result.details.push('Removed nested state/state directory');
    }
  }

  // ── 4. State hygiene: compact sync queue ──────────────
  if (runAll || flags?.compactSync) {
    try {
      const compactResult = compactSyncQueue(stateDir, SYNC_QUEUE_MAX_AGE_DAYS);
      result.syncCompacted = compactResult;
      if (compactResult.removed > 0) {
        result.details.push(
          `Compacted sync queue: removed ${compactResult.removed}, kept ${compactResult.kept}`,
        );
      }
    } catch {
      // best-effort
    }
  }

  // ── 5. State hygiene: stray .auto-sop directories ────
  if (runAll || flags?.cleanStray) {
    const strayResult = cleanStrayAutoSopDirs(projectRoot);
    result.strayDirsRemoved = strayResult.removed;
    if (strayResult.removed.length > 0) {
      result.details.push(
        `Removed ${strayResult.removed.length} stray .auto-sop director${strayResult.removed.length === 1 ? 'y' : 'ies'}`,
      );
    }
  }

  return result;
}

export function registerRepairVerb(program: Command): void {
  program
    .command('repair')
    .description('fix managed-section drift deadlock and clean stale state')
    .option('--project <path>', 'project root', process.cwd())
    .option('--clean-markers', 'clean orphan turn markers older than 24h')
    .option('--compact-sync', 'compact sync queue entries older than 7 days')
    .option('--clean-stray', 'remove stray .auto-sop directories without binding.json')
    .action(async (opts, cmd) => {
      const jsonMode: boolean = cmd.parent?.opts().json ?? false;
      const root = path.resolve(opts.project as string);

      // SEC: path traversal guard
      if (!path.isAbsolute(root) || root.includes('..')) {
        if (jsonMode) {
          emit({ ok: false, verb: 'repair', reason: 'invalid_project_path', project: root });
        } else {
          process.stderr.write(pc.red('✗ Invalid project path\n'));
        }
        process.exitCode = 1;
        return;
      }

      const flags: RepairFlags = {};
      if (opts.cleanMarkers) flags.cleanMarkers = true;
      if (opts.compactSync) flags.compactSync = true;
      if (opts.cleanStray) flags.cleanStray = true;

      try {
        const result = runRepair(root, flags);

        if (jsonMode) {
          emit({
            ok: true,
            verb: 'repair',
            hash_resynced: result.hashResynced,
            hash_cleared: result.hashCleared,
            stale_turn_markers_removed: result.staleTurnMarkersRemoved,
            markers_removed: result.markersRemoved,
            nested_state_removed: result.nestedStateRemoved,
            sync_compacted: result.syncCompacted,
            stray_dirs_removed: result.strayDirsRemoved,
            details: result.details,
          });
        } else {
          if (result.details.length === 0) {
            process.stdout.write(pc.green('✓ Nothing to repair — everything looks healthy\n'));
          } else {
            process.stdout.write(pc.green('✓ Repair complete:\n'));
            for (const detail of result.details) {
              process.stdout.write(`  • ${detail}\n`);
            }
          }
        }
      } catch (err) {
        if (jsonMode) {
          emit({
            ok: false,
            verb: 'repair',
            reason: 'repair_failed',
            error: (err as Error).message,
          });
        } else {
          process.stderr.write(pc.red(`✗ Repair failed: ${(err as Error).message}\n`));
        }
        process.exitCode = 1;
      }
    });
}

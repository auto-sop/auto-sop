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
 */
import type { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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

export interface RepairResult {
  hashResynced: boolean;
  hashCleared: boolean;
  staleTurnMarkersRemoved: number;
  details: string[];
}

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Core repair logic — exported for testing.
 */
export function runRepair(projectRoot: string): RepairResult {
  const result: RepairResult = {
    hashResynced: false,
    hashCleared: false,
    staleTurnMarkersRemoved: 0,
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
  const stateDir = path.join(projectRoot, '.auto-sop', 'state');
  if (existsSync(stateDir)) {
    try {
      const entries = readdirSync(stateDir);
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.startsWith('current-turn-') || !entry.endsWith('.json')) continue;
        const fullPath = path.join(stateDir, entry);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > STALE_THRESHOLD_MS) {
            unlinkSync(fullPath);
            result.staleTurnMarkersRemoved++;
          }
        } catch {
          // best-effort per file
        }
      }
      if (result.staleTurnMarkersRemoved > 0) {
        result.details.push(
          `Removed ${result.staleTurnMarkersRemoved} stale current-turn marker(s)`,
        );
      }
    } catch {
      // best-effort — state dir read can fail
    }
  }

  return result;
}

export function registerRepairVerb(program: Command): void {
  program
    .command('repair')
    .description('fix managed-section drift deadlock and clean stale state')
    .option('--project <path>', 'project root', process.cwd())
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

      try {
        const result = runRepair(root);

        if (jsonMode) {
          emit({
            ok: true,
            verb: 'repair',
            hash_resynced: result.hashResynced,
            hash_cleared: result.hashCleared,
            stale_turn_markers_removed: result.staleTurnMarkersRemoved,
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

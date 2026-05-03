/**
 * ManagedSectionEditor — hardened, idempotent, backed-up writer for
 * a marker-bounded section inside <project>/CLAUDE.md.
 *
 * Design invariants:
 * - Byte-preserves everything outside the markers
 * - Backup is written BEFORE the main file (crash safety)
 * - Atomic rename for the main file write
 * - Dry-run never touches the filesystem
 * - Idempotent: same content → verdict 'unchanged', no file write
 *
 * v16 hardening:
 * - E1 drift detection: compares stored SHA-256 of last-known managed
 *   section against the current file. On drift → backup + abort, no write.
 * - E2 git-aware: skips writes during rebase/merge/cherry-pick/bisect/revert.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { getPlatform } from '../platform/index.js';
import { fsyncFile } from '../atomic/safe-fsync.js';
import {
  GENERATED_COMMENT,
  END_MARKER,
  CLAUDE_MD_HEADER,
  buildSectionBlock,
  findMarkers,
} from './markers.js';
import { readLastHash, writeLastHash, clearLastHash, sha256 } from './hash-store.js';
import { isGitBusy } from './git-state.js';

// Re-export error classes for consumers
export { AmbiguousMarkersError, MalformedMarkersError } from './markers.js';

// ─── Public types ────────────────────────────────────────

export interface ManagedSectionContent {
  /** Markdown body (without markers). */
  body: string;
}

/**
 * Optional structured logger. The editor calls this to emit
 *   'managed_section_drift_detected'
 *   'managed_section_skip_git_state'
 * events. The default behaviour (no logger) is a silent no-op so existing
 * call sites and tests are unaffected.
 */
export type ManagedSectionLogger = (kind: string, data?: unknown) => void;

export interface WriteResult {
  verdict: 'created' | 'updated' | 'unchanged' | 'dry_run' | 'drift_aborted' | 'git_busy';
  claudeMdPath: string;
  /**
   * - normal write: path to the rolling backup (CLAUDE.md.backup)
   * - drift abort: path to the conflict snapshot under managed-history/
   * - skip/dry-run/unchanged/created: null
   */
  backupPath: string | null;
  bytesBefore: number;
  bytesAfter: number;
  markersPresent: 'before_write' | 'after_write';
  /** The computed new content — populated only when dryRun is true. */
  newContent?: string;
}

export interface WriteOptions {
  projectRoot: string;
  content: ManagedSectionContent;
  /** If true, compute new content but write nothing to disk. */
  dryRun?: boolean | undefined;
  /** Optional structured-event logger (drift / git-busy). */
  logger?: ManagedSectionLogger | undefined;
}

// ─── Path traversal guard ────────────────────────────────

function assertNoTraversal(projectRoot: string): void {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be absolute, got: ${projectRoot}`);
  }
  // Defense in depth: reject traversal segments like /tmp/foo/../etc/passwd
  if (projectRoot.includes('..')) {
    throw new Error(`projectRoot must not contain '..': ${projectRoot}`);
  }
}

// ─── Pure render ─────────────────────────────────────────

/**
 * Pure function that computes the post-write contents of CLAUDE.md given:
 *
 *   - `currentContent`  — the existing file contents, or null if the file
 *                          does not exist yet.
 *   - `body`            — the managed-section body to embed between markers.
 *
 * Does NOT touch the filesystem, does NOT consult git state, does NOT
 * consult the hash store. It encapsulates exactly the three branches of
 * `writeManagedSection`'s splice logic so that golden-file regression tests
 * (E7) can assert byte-for-byte output without needing to fake a whole
 * project root. A fresh write through `writeManagedSection` with `dryRun:
 * true` returns the same bytes in `newContent` (assuming no drift / git
 * busy short-circuit fires).
 *
 * May throw `AmbiguousMarkersError` / `MalformedMarkersError` when the
 * markers in `currentContent` are malformed. That is the same surface
 * `writeManagedSection` exposes, and tests rely on it.
 */
export function renderManagedSection(currentContent: string | null, body: string): string {
  const sectionBlock = buildSectionBlock(body);

  if (currentContent === null) {
    return CLAUDE_MD_HEADER + '\n' + sectionBlock + '\n';
  }

  const markers = findMarkers(currentContent);
  if (markers === null) {
    return currentContent.replace(/\n*$/, '\n\n') + sectionBlock + '\n';
  }

  const before = currentContent.slice(0, markers.beginStart);
  const after = currentContent.slice(markers.endAfter);
  return before + sectionBlock + '\n' + after;
}

// ─── Hash helpers ────────────────────────────────────────

/**
 * Compute the canonical hash of the managed section currently present in
 * `fileContent`. Returns the empty string when no managed section is found
 * (file missing or markers absent). The hashed range is exactly
 * [beginStart, endAfter) — the same byte range we splice on writes — so a
 * fresh write followed by an immediate re-hash yields the identical digest.
 */
function computeManagedHash(fileContent: string | null): string {
  if (fileContent === null) return '';
  let markers: ReturnType<typeof findMarkers>;
  try {
    markers = findMarkers(fileContent);
  } catch {
    // Malformed/ambiguous markers → can't hash a meaningful section. Treat
    // as "no section" so the editor's normal error path (re-thrown by the
    // caller) can surface the parse error instead of a confusing drift.
    return '';
  }
  if (markers === null) return '';
  return sha256(fileContent.slice(markers.beginStart, markers.endAfter));
}

// ─── Write ───────────────────────────────────────────────

export function writeManagedSection(opts: WriteOptions): WriteResult {
  const { projectRoot, content, dryRun, logger } = opts;
  assertNoTraversal(projectRoot);

  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  const tmpPath = claudeMdPath + '.tmp';
  const backupDir = join(projectRoot, '.auto-sop', 'state');
  const backupPath = join(backupDir, 'CLAUDE.md.backup');

  // 0. E2 — Git-busy short-circuit. Honoured even on dry-run: if a rebase
  //    is in flight, dry-run output is misleading because the file may be
  //    in a transient state.
  if (isGitBusy(projectRoot)) {
    if (logger) logger('managed_section_skip_git_state', { projectRoot });
    return {
      verdict: 'git_busy',
      claudeMdPath,
      backupPath: null,
      bytesBefore: 0,
      bytesAfter: 0,
      markersPresent: 'before_write',
    };
  }

  // 1. Read current content
  let current: string | null = null;
  try {
    current = readFileSync(claudeMdPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const bytesBefore = current !== null ? Buffer.byteLength(current, 'utf-8') : 0;

  // 2. Find existing markers (may throw AmbiguousMarkersError / MalformedMarkersError).
  //    These intentionally propagate — drift checking can't proceed against
  //    a malformed section, and the caller already handles these errors.
  const markers = current !== null ? findMarkers(current) : null;
  const markersPresent: WriteResult['markersPresent'] =
    markers !== null ? 'before_write' : 'after_write';

  // 2a. E1 — Drift detection with auto-recovery (V27).
  //     If we've previously recorded a hash AND it no longer matches what's
  //     on disk, the user (or some other tool) edited the managed section
  //     between writes. After 3 consecutive drifts, auto-repair: re-compute
  //     hash from current file, write it, reset counter, and proceed.
  const stored = readLastHash(projectRoot);
  if (stored !== null) {
    const currentHash = computeManagedHash(current);
    if (currentHash !== stored.lastHash) {
      const driftCount = (stored.consecutiveDrifts ?? 0) + 1;

      // V27: Auto-recovery after 3 consecutive drifts.
      //
      // RATIONALE: A threshold of 3 balances safety vs. liveness. A single
      // drift is likely a legitimate user hand-edit (abort is correct). Two
      // consecutive drifts could still be manual edits across ticks. Three
      // in a row strongly suggests a tool/process issue (e.g. another
      // editor or formatter touching the file), not intentional hand-edits.
      // At that point, staying wedged is worse than re-syncing: the learner
      // would be permanently stuck until the user manually runs `repair`.
      // The auto-repair re-computes the hash from the current file content
      // (whatever is on disk IS the truth after 3 failed attempts) and
      // resets the counter so normal writes resume.
      if (driftCount >= 3 && dryRun !== true) {
        const oldHash = stored.lastHash;
        // Re-compute hash from the current file and persist it, resetting
        // the drift counter so subsequent normal writes proceed.
        if (currentHash.length > 0) {
          writeLastHash(projectRoot, currentHash);
        } else {
          clearLastHash(projectRoot);
        }
        // Conspicuous log: auto-recovery is a significant event — make it
        // visible so operators notice if it fires unexpectedly.
        console.warn(
          `[auto-sop] ⚠ Auto-repaired managed-section drift after ${driftCount} consecutive aborts (project: ${projectRoot})`,
        );
        if (logger) {
          logger('managed_section_drift_auto_repaired', {
            projectRoot,
            oldHash,
            newHash: currentHash,
            consecutiveDrifts: driftCount,
          });
        }
        // Fall through to the normal write path below
      } else {
        // Increment consecutiveDrifts in the hash store so the next tick
        // knows how many drifts have occurred in a row.
        if (dryRun !== true) {
          try {
            writeLastHash(projectRoot, stored.lastHash, driftCount);
          } catch {
            // best-effort — don't block the abort path
          }
        }

        let conflictPath: string | null = null;
        // On dry-run we surface the drift in the recap but never touch disk —
        // creating a backup file would violate the dry-run contract.
        if (dryRun !== true && current !== null) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const historyDir = join(projectRoot, '.auto-sop', 'state', 'managed-history');
          try {
            mkdirSync(historyDir, { recursive: true });
          } catch {
            // best-effort; if mkdir fails we still log and abort
          }
          conflictPath = join(historyDir, `conflict-${ts}.md`);
          try {
            writeFileSync(conflictPath, current, { mode: 0o600 });
          } catch {
            // If the snapshot write fails, we still abort the main write —
            // losing the snapshot is preferable to clobbering the user.
            conflictPath = null;
          }
        }
        if (logger) {
          logger('managed_section_drift_detected', {
            projectRoot,
            conflictPath,
            storedHash: stored.lastHash,
            currentHash,
            consecutiveDrifts: driftCount,
          });
        }
        return {
          verdict: 'drift_aborted',
          claudeMdPath,
          backupPath: conflictPath,
          bytesBefore,
          bytesAfter: 0,
          markersPresent,
        };
      }
    }
  }

  // 3. Construct new content via the pure renderer so dry-run output and the
  //    eventual on-disk bytes cannot diverge. `renderManagedSection` parses
  //    `current` itself, which would double-cost here if it weren't for the
  //    fact that we've already proven it's well-formed (step 2 did not
  //    throw). The re-parse is a few string scans — negligible next to the
  //    filesystem calls that dominate this function.
  const newContent = renderManagedSection(current, content.body);

  const bytesAfter = Buffer.byteLength(newContent, 'utf-8');

  // 4. Dry-run: return immediately, no disk writes
  if (dryRun === true) {
    return {
      verdict: 'dry_run',
      claudeMdPath,
      backupPath: null,
      bytesBefore,
      bytesAfter,
      markersPresent,
      newContent,
    };
  }

  // 5. Unchanged short-circuit
  if (newContent === current) {
    return {
      verdict: 'unchanged',
      claudeMdPath,
      backupPath: null,
      bytesBefore,
      bytesAfter,
      markersPresent,
    };
  }

  // 6. Backup (BEFORE main write — crash safety)
  //    Uses the same tmp → fsync → rename pattern as the main write so a
  //    crash mid-backup cannot leave a partial/corrupt backup on disk that
  //    `revert` might silently restore.
  let didBackup = false;
  if (current !== null) {
    mkdirSync(backupDir, { recursive: true });
    const backupTmp = backupPath + '.tmp-' + process.pid + '-' + Date.now();
    try {
      writeFileSync(backupTmp, current, { mode: 0o600 });
      fsyncFile(backupTmp);
      renameSync(backupTmp, backupPath);
    } catch (err) {
      try {
        unlinkSync(backupTmp);
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }
    didBackup = true;
  }

  // 7. Atomic write: write tmp → fsync → rename
  try {
    writeFileSync(tmpPath, newContent, { mode: 0o644 });
    fsyncFile(tmpPath);
    renameSync(tmpPath, claudeMdPath);
  } catch (err) {
    // Cleanup tmp if still present
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  // Ensure final permissions (no-op on Windows — NTFS ignores POSIX modes)
  try {
    getPlatform().chmodSync(claudeMdPath, 0o644);
  } catch {
    // best-effort — platform adapter handles Windows no-op
  }

  // 8. Record the post-write hash so the next run can detect drift.
  //    Computed against the same byte range we'd extract on read, so
  //    re-hashing the file later yields the identical digest.
  try {
    const postHash = computeManagedHash(newContent);
    if (postHash.length > 0) {
      writeLastHash(projectRoot, postHash);
    }
  } catch (err) {
    // Hash-store failure is non-fatal — the next run will treat us as
    // first-run and proceed without drift checking. Surface via logger
    // so operators can debug if it persists.
    if (logger) logger('managed_section_hash_store_failed', { err: String(err) });
  }

  const verdict: WriteResult['verdict'] = current === null ? 'created' : 'updated';

  return {
    verdict,
    claudeMdPath,
    backupPath: didBackup ? backupPath : null,
    bytesBefore,
    bytesAfter,
    markersPresent,
  };
}

// ─── Read ────────────────────────────────────────────────

export function readManagedSection(projectRoot: string): ManagedSectionContent | null {
  assertNoTraversal(projectRoot);

  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  let content: string;
  try {
    content = readFileSync(claudeMdPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const markers = findMarkers(content);
  if (markers === null) {
    return null;
  }

  // Extract body: everything between begin-marker line and end-marker line
  const afterBeginLine = content.indexOf('\n', markers.beginStart) + 1;

  // Skip the GENERATED comment line
  let bodyStart = afterBeginLine;
  const generatedLineEnd = content.indexOf('\n', afterBeginLine);
  const generatedLine = content.slice(afterBeginLine, generatedLineEnd);
  if (generatedLine.trim() === GENERATED_COMMENT) {
    bodyStart = generatedLineEnd + 1;
  }

  // Body ends at the end marker
  const endMarkerStart = content.indexOf(END_MARKER, markers.beginStart);
  let body = content.slice(bodyStart, endMarkerStart);

  // Strip leading/trailing blank lines from body
  body = body.replace(/^\n+/, '').replace(/\n+$/, '');

  return { body };
}

// ─── Remove ──────────────────────────────────────────────

export function removeManagedSection(projectRoot: string): void {
  assertNoTraversal(projectRoot);

  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  let content: string;
  try {
    content = readFileSync(claudeMdPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // No file → no-op
    }
    throw err;
  }

  let markers: ReturnType<typeof findMarkers>;
  try {
    markers = findMarkers(content);
  } catch {
    return; // Malformed/ambiguous markers → no-op, don't risk data loss
  }

  if (markers === null) {
    return; // No markers → no-op
  }

  // Splice out the markers + body, including a trailing blank line if present
  const before = content.slice(0, markers.beginStart);
  const after = content.slice(markers.endAfter);

  // Remove the trailing blank line left by removal
  const newContent = (before + after).replace(/\n{3,}$/, '\n');

  // Atomic write
  const tmpPath = claudeMdPath + '.tmp';
  try {
    writeFileSync(tmpPath, newContent, { mode: 0o644 });
    fsyncFile(tmpPath);
    renameSync(tmpPath, claudeMdPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }

  // Clear the stored hash — the managed section no longer exists on disk, so
  // keeping an old hash would cause the next writeManagedSection to compute
  // '' (no markers) against a non-empty stored hash and abort as drift,
  // wedging the learner. Best-effort; matches the pattern used by revert.ts.
  try {
    clearLastHash(projectRoot);
  } catch {
    // best-effort — same pattern as revert.ts
  }
}

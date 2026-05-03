/**
 * Hash store for the managed section in <project>/CLAUDE.md.
 *
 * Persists the SHA-256 of the most recently written managed section so the
 * editor can detect drift (a user hand-edit between writes) and abort
 * before clobbering the user's work.
 *
 * Storage:
 *   <projectRoot>/.auto-sop/state/managed-section-hash.json
 *
 * Schema:
 *   { lastHash: string, updatedAt: string, consecutiveDrifts?: number }
 *
 * File mode is 0600 — never world-readable.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { getPlatform } from '../platform/index.js';
import { createHash } from 'node:crypto';
import { fsyncFile } from '../atomic/safe-fsync.js';

// ─── Public types ────────────────────────────────────────

export interface HashRecord {
  lastHash: string;
  updatedAt: string;
  consecutiveDrifts?: number;
}

// ─── Path traversal guard ────────────────────────────────

function assertNoTraversal(projectRoot: string): void {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be absolute, got: ${projectRoot}`);
  }
  if (projectRoot.includes('..')) {
    throw new Error(`projectRoot must not contain '..': ${projectRoot}`);
  }
}

function hashStorePath(projectRoot: string): string {
  return join(projectRoot, '.auto-sop', 'state', 'managed-section-hash.json');
}

// ─── SHA-256 helper ──────────────────────────────────────

/**
 * Compute SHA-256 of a UTF-8 string. Returns hex digest.
 * For convenience to callers — the hash store itself does not require this,
 * but the editor uses it when computing managed-section hashes.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

// ─── Read ────────────────────────────────────────────────

/**
 * Read the last-known hash for a project. Returns null when:
 *   - The hash file does not exist (first run)
 *   - The hash file is malformed (treated as no record)
 *
 * Never throws on read errors — drift detection must fail-open so that a
 * corrupt hash store cannot wedge the learner.
 */
export function readLastHash(projectRoot: string): HashRecord | null {
  assertNoTraversal(projectRoot);

  const path = hashStorePath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).lastHash !== 'string' ||
    typeof (parsed as Record<string, unknown>).updatedAt !== 'string'
  ) {
    return null;
  }

  const rec = parsed as HashRecord;
  // Empty hash is treated as "no record" so we don't false-trigger drift on
  // a hash store that was zeroed out.
  if (rec.lastHash.length === 0) {
    return null;
  }
  return rec;
}

// ─── Write ───────────────────────────────────────────────

/**
 * Atomically persist the new managed-section hash for this project.
 *
 * Atomicity: write to a sibling .tmp file, fsync, then rename. A crash mid-
 * write leaves either the previous record or no record — never a torn one.
 */
export function writeLastHash(projectRoot: string, hash: string, consecutiveDrifts?: number): void {
  assertNoTraversal(projectRoot);
  if (typeof hash !== 'string' || hash.length === 0) {
    throw new Error('writeLastHash: hash must be a non-empty string');
  }

  const path = hashStorePath(projectRoot);
  const dir = join(projectRoot, '.auto-sop', 'state');
  // SEC-006: user-only state dir (0o700). Even though each file inside
  // is written with 0600, a world-readable parent dir would let other
  // local users enumerate filenames and infer which projects are being
  // tracked.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const record: HashRecord = {
    lastHash: hash,
    updatedAt: new Date().toISOString(),
    ...(consecutiveDrifts !== undefined && consecutiveDrifts > 0 ? { consecutiveDrifts } : {}),
  };
  const payload = JSON.stringify(record);
  const tmp = path + '.tmp';

  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    fsyncFile(tmp);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  // Re-assert mode after rename (umask can soften it)
  try {
    getPlatform().chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

// ─── Clear ───────────────────────────────────────────────

/**
 * Forget the stored hash. Used by the revert verb (E3) and by tests.
 * No-op if the file does not exist.
 */
export function clearLastHash(projectRoot: string): void {
  assertNoTraversal(projectRoot);
  const path = hashStorePath(projectRoot);
  try {
    unlinkSync(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

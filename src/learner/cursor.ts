/**
 * Per-project learner cursor — tracks last-processed finalized_at timestamp.
 * Uses proper-lockfile for mutual exclusion (2s stale, 1s retry).
 * Fail-open: returns null if lock can't be acquired.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { lockSync, unlockSync } from 'proper-lockfile';

// ── Types ──────────────────────────────────────────────────

export interface LearnerCursor {
  last_finalized_at: string; // ISO8601 or '' for never-processed
  total_turns_seen: number;
  last_tick_id: string;
  updated_at: string; // ISO8601
}

// ── Defaults ───────────────────────────────────────────────

function defaultCursor(): LearnerCursor {
  return {
    last_finalized_at: '',
    total_turns_seen: 0,
    last_tick_id: '',
    updated_at: new Date().toISOString(),
  };
}

// ── Paths ──────────────────────────────────────────────────

function cursorFilePath(stateDir: string): string {
  return join(stateDir, 'learner-cursor.json');
}

function cursorLockPath(stateDir: string): string {
  return join(stateDir, 'learner-cursor.lock');
}

// ── Read (no lock needed for reads in withCursorLock context) ──

export function readCursor(stateDir: string): LearnerCursor {
  try {
    const raw = readFileSync(cursorFilePath(stateDir), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      last_finalized_at: parsed.last_finalized_at ?? '',
      total_turns_seen: parsed.total_turns_seen ?? 0,
      last_tick_id: parsed.last_tick_id ?? '',
      updated_at: parsed.updated_at ?? '',
    };
  } catch {
    return defaultCursor();
  }
}

// ── Write (call only inside withCursorLock) ────────────────

export function writeCursor(stateDir: string, cursor: LearnerCursor): void {
  const filePath = cursorFilePath(stateDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(cursor, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

// ── Lock helper ────────────────────────────────────────────

/**
 * Acquire cursor lock, run fn with read/write access, release lock.
 * Returns null if lock can't be acquired within ~2s (fail-open for overlapping ticks).
 */
export function withCursorLock<T>(
  stateDir: string,
  fn: () => T,
): T | null {
  mkdirSync(stateDir, { recursive: true });

  const lockPath = cursorLockPath(stateDir);
  const cursorFile = cursorFilePath(stateDir);

  // Ensure the file exists for proper-lockfile
  if (!existsSync(cursorFile)) {
    writeFileSync(cursorFile, '{}', { mode: 0o600 });
  }

  try {
    lockSync(cursorFile, {
      lockfilePath: lockPath,
      stale: 2000,
    });
  } catch {
    return null; // lock contention — fail-open
  }

  try {
    return fn();
  } finally {
    try {
      unlockSync(cursorFile, { lockfilePath: lockPath });
    } catch {
      // best-effort release
    }
  }
}

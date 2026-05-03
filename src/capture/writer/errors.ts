/**
 * Error logging for the capture writer.
 *
 * Writes JSON lines to both project and global errors.jsonl.
 * 10MB cap with single .1 backup rotation.
 * Never throws — error logging must be silently best-effort.
 */
import {
  statSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { CapturePaths } from '../paths.js';
import type { ErrorWriter } from './routes/types.js';

export const ERRORS_CAP_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ErrorRecord {
  t: string; // ISO timestamp
  kind: string; // e.g. 'scrub_failed','rename_failed','disk_full','paused_skipped','zod_parse_failed','writer_uncaught'
  turn_id: string | null;
  err: string; // .message if Error, else String(err)
}

/**
 * Append one error record to both project and global errors.jsonl.
 * If one path fails, the other still gets written. Never throws.
 */
export function logError(
  paths: { projectErrorsLog: string; globalErrorsLog: string },
  record: Omit<ErrorRecord, 't'>,
): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ...record }) + '\n';
  for (const target of [paths.projectErrorsLog, paths.globalErrorsLog]) {
    try {
      rotateIfNeeded(target);
      ensureFile(target);
      appendFileSync(target, line, { mode: 0o600 });
    } catch {
      // Silent — error logging must never itself throw.
    }
  }
}

function ensureFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
  }
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  const { size } = statSync(path);
  if (size < ERRORS_CAP_BYTES) return;
  try {
    renameSync(path, path + '.1'); // overwrites any prior .1 — single backup policy
  } catch {
    // If rotation fails, continue — errors logging must not crash.
  }
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return String(err);
  return String(err);
}

// Module-level reference for cross-module access (pre-start hooks).
// Set by initErrorWriter(), read by getErrorWriter().
let _boundWriter: ErrorWriter | null = null;

/**
 * Initialize the error writer, binding it to resolved paths.
 * Returns an ErrorWriter function matching the late-binding slot in main.ts.
 * Also stores a module-level reference accessible via getErrorWriter().
 */
export function initErrorWriter(paths: CapturePaths): ErrorWriter {
  const writer: ErrorWriter = (kind: string, turnId: string | null, err: unknown): void => {
    logError(paths, { kind, turn_id: turnId, err: stringifyErr(err) });
  };
  _boundWriter = writer;
  return writer;
}

/**
 * Get the current error writer (or null if not yet initialized).
 * Used by pre-start hooks which can't access main.ts's local variable.
 */
export function getErrorWriter(): ErrorWriter | null {
  return _boundWriter;
}

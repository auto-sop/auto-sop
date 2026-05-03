/**
 * Error Prevention Tracker — detects when commands that previously failed
 * (and caused directive creation) now succeed after directive adoption.
 *
 * Detection: for each successful Bash post-event, fingerprint the command
 * and match against known failure fingerprints from directive history.
 * A match counts as a "prevented error" if:
 *   - The turn timestamp is after the directive's first_seen
 *   - The session is NOT in the directive's evidence sessions (i.e.
 *     the success is in a NEW session, not the original failure sessions)
 *
 * Storage: error-prevention.jsonl — append-only JSONL in the project state dir.
 * Same I/O pattern as directive-fires.jsonl.
 *
 * Privacy: command_preview is capped at 80 chars (PRIV-03).
 */
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TurnData, ToolCall } from './turn-loader.js';
import { fingerprintCommand, isBashFailure } from './command-fingerprint.js';

// ─── Constants ───────────────────────────────────────────

export const PREVENTION_FILENAME = 'error-prevention.jsonl';
const COMMAND_PREVIEW_MAX = 80;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────

export interface PreventedError {
  t: string;
  directive_id: string;
  source_fingerprint: string;
  session_id: string;
  /** First 80 chars of the command for audit/debugging. */
  command_preview: string;
}

/**
 * Known directive fingerprint — built from DirectiveHistoryEntry objects
 * that have a source_fingerprint set.
 */
export interface DirectiveFingerprint {
  directive_id: string;
  source_fingerprint: string;
  first_seen: string;
  evidence_sessions: string[];
}

// ─── Detection ──────────────────────────────────────────

/**
 * Detect prevented errors: successful Bash commands whose fingerprint
 * matches a known failure pattern from a directive.
 *
 * For each Bash post-event with success === true:
 *   1. Fingerprint the command via the matching pre-event
 *   2. Match against known failure fingerprints
 *   3. Only count if turn timestamp > directive first_seen
 *      AND session NOT in directive evidence sessions
 */
export function detectPreventedErrors(
  turns: TurnData[],
  fingerprints: DirectiveFingerprint[],
): PreventedError[] {
  if (turns.length === 0 || fingerprints.length === 0) return [];

  // Build fingerprint lookup: source_fingerprint → DirectiveFingerprint[]
  const fpMap = new Map<string, DirectiveFingerprint[]>();
  for (const fp of fingerprints) {
    const arr = fpMap.get(fp.source_fingerprint) ?? [];
    arr.push(fp);
    fpMap.set(fp.source_fingerprint, arr);
  }

  const now = new Date().toISOString();
  const prevented: PreventedError[] = [];

  // Deduplicate: avoid counting the same (fingerprint, session) pair twice in one tick
  const seen = new Set<string>();

  for (const turn of turns) {
    // Build pre-event index
    const preByUseId = new Map<string, ToolCall>();
    for (const call of turn.tool_calls) {
      if (call.event === 'pre') {
        preByUseId.set(call.tool_use_id, call);
      }
    }

    for (const call of turn.tool_calls) {
      if (call.event !== 'post') continue;
      if (call.tool !== 'Bash') continue;

      // Only count SUCCESSES (not failures)
      if (isBashFailure(call)) continue;
      if (call.success !== true) continue;

      const pre = preByUseId.get(call.tool_use_id);
      if (!pre || !pre.input) continue;

      const command = pre.input.command;
      if (typeof command !== 'string' || command.length === 0) continue;

      const fp = fingerprintCommand(command);
      if (fp.length < 1) continue;

      const matchingDirectives = fpMap.get(fp);
      if (!matchingDirectives) continue;

      for (const directive of matchingDirectives) {
        // Only count if turn timestamp is AFTER directive first_seen
        const turnTs = call.t || turn.finalized_at;
        if (turnTs <= directive.first_seen) continue;

        // Only count if session is NOT in the directive's evidence sessions
        const evidenceSet = new Set(directive.evidence_sessions);
        if (evidenceSet.has(turn.session_id)) continue;

        // Deduplicate within this tick
        const dedupeKey = `${fp}:${turn.session_id}:${directive.directive_id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        prevented.push({
          t: now,
          directive_id: directive.directive_id,
          source_fingerprint: fp,
          session_id: turn.session_id,
          command_preview: command.slice(0, COMMAND_PREVIEW_MAX),
        });
      }
    }
  }

  return prevented;
}

// ─── File I/O ───────────────────────────────────────────

function preventionPath(stateDir: string): string {
  return join(stateDir, PREVENTION_FILENAME);
}

/**
 * Append prevented-error events as JSONL. Creates the file if it doesn't exist.
 * Best-effort — never throws.
 */
export function appendPreventedErrors(stateDir: string, errors: PreventedError[]): void {
  if (errors.length === 0) return;

  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = preventionPath(stateDir);
    const lines = errors.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(path, lines, { mode: 0o600 });
  } catch {
    // Best-effort — never throw
  }
}

/**
 * Read prevented-error events from JSONL. Skips malformed lines.
 * Returns sorted by timestamp ascending.
 */
export function readPreventedErrors(stateDir: string): PreventedError[] {
  const path = preventionPath(stateDir);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return [];
  }

  if (raw.length === 0) return [];

  const results: PreventedError[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      // Minimal validation
      if (
        typeof entry.t !== 'string' ||
        typeof entry.directive_id !== 'string' ||
        typeof entry.source_fingerprint !== 'string' ||
        typeof entry.session_id !== 'string' ||
        typeof entry.command_preview !== 'string'
      ) {
        continue;
      }
      results.push(entry as unknown as PreventedError);
    } catch {
      // Skip malformed lines
    }
  }

  results.sort((a, b) => a.t.localeCompare(b.t));
  return results;
}

/**
 * Compact prevention events — remove entries older than maxAgeDays.
 * Atomic rewrite (tmp + fsync + rename).
 * Returns count of removed entries.
 */
export function compactPreventedErrors(stateDir: string, maxAgeDays: number): number {
  const path = preventionPath(stateDir);
  if (!existsSync(path)) return 0;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return 0;
  }

  if (raw.length === 0) return 0;

  const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;
  const keep: string[] = [];
  let removedCount = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry = JSON.parse(trimmed) as { t?: string };
      if (typeof entry.t === 'string') {
        const entryMs = Date.parse(entry.t);
        if (Number.isFinite(entryMs) && entryMs < cutoffMs) {
          removedCount++;
          continue;
        }
      }
      keep.push(trimmed);
    } catch {
      removedCount++;
    }
  }

  // Atomic rewrite
  const tmpPath = path + '.tmp';
  try {
    const content = keep.length > 0 ? keep.join('\n') + '\n' : '';
    writeFileSync(tmpPath, content, { mode: 0o600 });
    const fd = openSync(tmpPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, path);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    return 0;
  }

  return removedCount;
}

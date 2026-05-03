/**
 * Turn directory lifecycle: create .pending → atomic rename to finalize.
 *
 * Readers MUST ignore directories ending in `.pending` — they represent
 * in-flight turns whose contents (meta.json, prompt.md) may be mid-write.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';

export interface TurnDirParams {
  capturesDir: string;
  ts: string;
  agent: string;
  filehash: string;
  turnId: string;
}

export interface CurrentTurnState {
  turnDir: string;
  turnId: string;
}

/**
 * Format a Date as compact ISO: YYYYMMDDTHHmmss (UTC).
 */
export function compactIso(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${da}T${h}${mi}${s}`;
}

/**
 * Generate a 12-char turn ID.
 */
export function generateTurnId(): string {
  return nanoid(12);
}

/**
 * Create a `.pending` turn directory under capturesDir.
 * Returns the absolute path to the created directory.
 */
export function createPendingTurnDir(params: TurnDirParams): string {
  const dirName = `${params.ts}-${params.agent}-${params.filehash}-${params.turnId}.pending`;
  const dirPath = join(params.capturesDir, dirName);
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

/**
 * Atomically finalize a turn directory by dropping the `.pending` suffix.
 * Single rename syscall — POSIX-atomic.
 */
export function finalizeTurnDir(pendingDir: string): string {
  const finalDir = pendingDir.replace(/\.pending$/, '');
  renameSync(pendingDir, finalDir);
  return finalDir;
}

/**
 * Read the current turn marker for a session.
 */
export function resolveCurrentTurn(stateDir: string, sessionId: string): CurrentTurnState | null {
  const markerPath = join(stateDir, `current-turn-${sessionId}.json`);
  try {
    const raw = readFileSync(markerPath, 'utf8');
    return JSON.parse(raw) as CurrentTurnState;
  } catch {
    return null;
  }
}

/**
 * Atomically write the current turn marker for a session (temp file + rename).
 */
export function setCurrentTurn(stateDir: string, sessionId: string, state: CurrentTurnState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const markerPath = join(stateDir, `current-turn-${sessionId}.json`);
  const tmpPath = markerPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmpPath, markerPath);
}

/**
 * Remove the current turn marker for a session. Ignore ENOENT.
 */
export function clearCurrentTurn(stateDir: string, sessionId: string): void {
  const markerPath = join(stateDir, `current-turn-${sessionId}.json`);
  try {
    unlinkSync(markerPath);
  } catch {
    // ENOENT or other — ignore
  }
}

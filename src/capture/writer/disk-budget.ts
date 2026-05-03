/**
 * Disk budget enforcement for the capture writer.
 *
 * Measures captures directory size; when it crosses 50% of configured cap
 * (default 1GB of 2GB), writes paused.flag and subsequent writer calls
 * skip capture.
 */
import { existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const PAUSE_RATIO = 0.5; // 50% of cap

/**
 * Check if capturing is paused (paused.flag exists).
 */
export function isPaused(pausedFlagPath: string): boolean {
  return existsSync(pausedFlagPath);
}

/**
 * Recursively compute total file size in a directory (du equivalent).
 * Returns 0 for missing directories. Swallows ENOENT on individual entries.
 */
export function computeUsedBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) stack.push(p);
        else total += st.size;
      } catch {
        /* race: file vanished between readdir and stat */
      }
    }
  }
  return total;
}

/**
 * Enforce disk budget. If captures dir crosses threshold, write paused.flag.
 *
 * @returns used bytes, current pause state, and whether this call just triggered the pause.
 */
export function enforceDiskBudget(
  capturesDir: string,
  pausedFlagPath: string,
  capBytes: number = DEFAULT_CAP_BYTES,
): { used: number; paused: boolean; justPaused: boolean } {
  const used = computeUsedBytes(capturesDir);
  const threshold = Math.floor(capBytes * PAUSE_RATIO);
  const alreadyPaused = existsSync(pausedFlagPath);
  if (used >= threshold && !alreadyPaused) {
    try {
      writeFileSync(
        pausedFlagPath,
        JSON.stringify({ at: new Date().toISOString(), used, cap: capBytes, threshold }),
        { mode: 0o600 },
      );
    } catch {
      /* if we can't write flag, next call will try again */
    }
    return { used, paused: true, justPaused: true };
  }
  return { used, paused: alreadyPaused, justPaused: false };
}

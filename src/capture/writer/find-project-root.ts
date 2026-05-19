/**
 * Resolve the true project root from a potentially nested CWD.
 *
 * Problem: agents may `cd` into subdirectories during a session, causing
 * event.cwd to point to a subdirectory. Without root resolution, the writer
 * creates .auto-sop/ in that subdirectory — contaminating the tree.
 *
 * Resolution order:
 *   1. Walk up from `cwd` looking for `.auto-sop/binding.json` (canonical ownership signal)
 *   2. Fall back to `git rev-parse --show-toplevel` (sync, capped at GIT_TIMEOUT_MS)
 *   3. Fall back to original `cwd` (backward compatibility)
 *
 * Must be synchronous (writer is sync entry) and fast (<5ms for walk, <=2s worst-case git).
 */
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Marker file that signals an auto-sop-owned project directory */
export const BINDING_MARKER = join('.auto-sop', 'binding.json');

/** Maximum time to wait for git rev-parse (milliseconds) */
export const GIT_TIMEOUT_MS = 2_000;

/**
 * Walk up the directory tree from `startDir` looking for a directory
 * that contains `.auto-sop/binding.json`. Returns the owning directory
 * or `null` if none found.
 */
function walkUpForBinding(startDir: string): string | null {
  let current = resolve(startDir);

  // Safety: cap iterations to prevent infinite loops on broken filesystems
  const MAX_DEPTH = 256;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (existsSync(join(current, BINDING_MARKER))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root (/ on Unix, C:\ on Windows)
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Synchronous git rev-parse --show-toplevel fallback.
 * Returns the repo root or `null` on any failure (not a git repo, git not
 * installed, timeout, etc.). Never throws.
 */
function gitToplevel(cwd: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      // Suppress stderr to avoid noisy "not a git repository" messages
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || result.error) return null;
    const toplevel = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return toplevel.length > 0 ? toplevel : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the project root for a given working directory.
 *
 * @param cwd - The current working directory reported by the hook event
 * @returns The resolved project root directory
 */
export function findProjectRoot(cwd: string): string {
  // 1. Walk up looking for .auto-sop/binding.json
  const bindingRoot = walkUpForBinding(cwd);
  if (bindingRoot !== null) return bindingRoot;

  // 2. Fall back to git repo root
  const gitRoot = gitToplevel(cwd);
  if (gitRoot !== null) return gitRoot;

  // 3. Fall back to original cwd (backward compatibility)
  return cwd;
}

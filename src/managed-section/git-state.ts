/**
 * Git state detector for the managed-section editor.
 *
 * During a rebase, merge, cherry-pick, bisect, or revert, CLAUDE.md may be
 * partially staged or in a transient state. Touching it would corrupt the
 * user's git workflow and conflict with their resolution. The editor
 * MUST skip writes while git is busy.
 *
 * We detect this purely via filesystem checks against well-known files
 * inside <projectRoot>/.git/. No git CLI invocation — that would be slow,
 * shell-injectable, and dependent on git being on PATH.
 *
 * Returns false (not busy) when .git/ does not exist (non-git project).
 */
import { existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

// Files/directories whose presence indicates an in-progress operation.
// Sourced from the canonical names git uses for each operation type.
const GIT_BUSY_DIRS = ['rebase-merge', 'rebase-apply'] as const;
const GIT_BUSY_FILES = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'BISECT_LOG',
  'REVERT_HEAD',
] as const;

function assertNoTraversal(projectRoot: string): void {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be absolute, got: ${projectRoot}`);
  }
  if (projectRoot.includes('..')) {
    throw new Error(`projectRoot must not contain '..': ${projectRoot}`);
  }
}

/**
 * Returns true when a git operation is in progress in `projectRoot`.
 *
 * Returns false if:
 *   - `<projectRoot>/.git` does not exist (non-git project)
 *   - `<projectRoot>/.git` exists but no busy markers are present
 *
 * Never throws on filesystem access errors — fail-open so a permissions
 * blip cannot block writes forever.
 */
export function isGitBusy(projectRoot: string): boolean {
  assertNoTraversal(projectRoot);

  const gitDir = join(projectRoot, '.git');

  // Non-git project (or .git removed): not busy.
  let gitExists = false;
  try {
    gitExists = existsSync(gitDir);
  } catch {
    return false;
  }
  if (!gitExists) {
    return false;
  }

  // Worktrees and submodules use a `.git` FILE that points to a git dir
  // elsewhere. We do not chase that pointer — the in-tree busy markers
  // live in the linked dir, not the worktree, so we'd miss them. For now
  // worktree detection is a known limitation; treat "not busy" so writes
  // proceed normally. Users in mid-rebase on a worktree are an edge case.
  try {
    if (!statSync(gitDir).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  for (const dir of GIT_BUSY_DIRS) {
    try {
      if (existsSync(join(gitDir, dir))) {
        return true;
      }
    } catch {
      // ignore — fail-open per marker
    }
  }
  for (const file of GIT_BUSY_FILES) {
    try {
      if (existsSync(join(gitDir, file))) {
        return true;
      }
    } catch {
      // ignore — fail-open per marker
    }
  }

  return false;
}

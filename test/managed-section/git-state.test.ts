import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isGitBusy } from '../../src/managed-section/git-state.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-sop-git-state-'));
}

describe('isGitBusy', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpDir();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const gitDir = () => join(projectRoot, '.git');

  it('returns false when .git does not exist (non-git project)', () => {
    expect(isGitBusy(projectRoot)).toBe(false);
  });

  it('returns false when .git exists but no busy markers are present', () => {
    mkdirSync(gitDir());
    expect(isGitBusy(projectRoot)).toBe(false);
  });

  it('returns false when .git is a file (worktree pointer), not a directory', () => {
    writeFileSync(gitDir(), 'gitdir: /elsewhere/.git/worktrees/x\n');
    expect(isGitBusy(projectRoot)).toBe(false);
  });

  it('returns true during a merge (MERGE_HEAD present)', () => {
    mkdirSync(gitDir());
    writeFileSync(join(gitDir(), 'MERGE_HEAD'), 'deadbeef\n');
    expect(isGitBusy(projectRoot)).toBe(true);
  });

  it('returns true during an interactive rebase (rebase-merge/ dir)', () => {
    mkdirSync(join(gitDir(), 'rebase-merge'), { recursive: true });
    expect(isGitBusy(projectRoot)).toBe(true);
  });

  it('returns true during a non-interactive rebase (rebase-apply/ dir)', () => {
    mkdirSync(join(gitDir(), 'rebase-apply'), { recursive: true });
    expect(isGitBusy(projectRoot)).toBe(true);
  });

  it('returns true during a cherry-pick (CHERRY_PICK_HEAD present)', () => {
    mkdirSync(gitDir());
    writeFileSync(join(gitDir(), 'CHERRY_PICK_HEAD'), 'deadbeef\n');
    expect(isGitBusy(projectRoot)).toBe(true);
  });

  it('returns true during a bisect (BISECT_LOG present)', () => {
    mkdirSync(gitDir());
    writeFileSync(join(gitDir(), 'BISECT_LOG'), 'git bisect start\n');
    expect(isGitBusy(projectRoot)).toBe(true);
  });

  it('returns true during a revert (REVERT_HEAD present)', () => {
    mkdirSync(gitDir());
    writeFileSync(join(gitDir(), 'REVERT_HEAD'), 'deadbeef\n');
    expect(isGitBusy(projectRoot)).toBe(true);
  });

  it('rejects relative projectRoot', () => {
    expect(() => isGitBusy('relative/path')).toThrow(/must be absolute/);
  });

  it('rejects projectRoot containing ..', () => {
    expect(() => isGitBusy('/tmp/../etc')).toThrow(/must not contain/);
  });
});

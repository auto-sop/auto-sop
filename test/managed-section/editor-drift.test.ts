/**
 * E1 + E2 integration tests for ManagedSectionEditor:
 *  - Hash-checked writes + drift detection (E1)
 *  - Git-aware skip during rebase/merge/etc. (E2)
 *
 * These tests cover the new behaviour added by PLAN-v16 Wave 1. Existing
 * happy-path / edge-case behaviour lives in editor.test.ts and remains
 * unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeManagedSection, removeManagedSection } from '../../src/managed-section/editor.js';
import { readLastHash, clearLastHash } from '../../src/managed-section/hash-store.js';
import { isWindows } from '../setup/platform.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-editor-drift-'));
}

describe('ManagedSectionEditor — E1 drift detection', () => {
  let projectRoot: string;
  const events: Array<{ kind: string; data: unknown }> = [];
  const logger = (kind: string, data?: unknown) => events.push({ kind, data });

  beforeEach(() => {
    projectRoot = makeTmpDir();
    events.length = 0;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const claudeMd = () => join(projectRoot, 'CLAUDE.md');
  const historyDir = () => join(projectRoot, '.auto-sop', 'state', 'managed-history');

  it('first run (no stored hash) writes successfully and records post-write hash', () => {
    expect(readLastHash(projectRoot)).toBeNull();

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'first' },
      logger,
    });

    expect(result.verdict).toBe('created');
    expect(readLastHash(projectRoot)).not.toBeNull();
    expect(events).toEqual([]); // no drift events on first run
  });

  it('successful second run updates the stored hash', () => {
    writeManagedSection({
      projectRoot,
      content: { body: 'v1' },
      logger,
    });
    const h1 = readLastHash(projectRoot)!.lastHash;

    writeManagedSection({
      projectRoot,
      content: { body: 'v2' },
      logger,
    });
    const h2 = readLastHash(projectRoot)!.lastHash;

    expect(h1).not.toBe(h2);
    expect(events).toEqual([]);
  });

  it('drift aborts the write and creates a conflict backup', () => {
    // Establish a baseline write (records hash)
    writeManagedSection({
      projectRoot,
      content: { body: 'baseline body' },
      logger,
    });
    const baselineFile = readFileSync(claudeMd(), 'utf-8');

    // Simulate a user hand-edit inside the managed section.
    const tampered = baselineFile.replace('baseline body', 'USER HAND EDIT');
    writeFileSync(claudeMd(), tampered);

    events.length = 0; // reset so we observe only the drift event
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'cron-proposed body' },
      logger,
    });

    // Verdict + backup pointer
    expect(result.verdict).toBe('drift_aborted');
    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath).toContain('managed-history');
    expect(result.backupPath).toMatch(/conflict-/);

    // CLAUDE.md is left UNCHANGED (still has user hand-edit)
    expect(readFileSync(claudeMd(), 'utf-8')).toBe(tampered);
    expect(readFileSync(claudeMd(), 'utf-8')).toContain('USER HAND EDIT');
    expect(readFileSync(claudeMd(), 'utf-8')).not.toContain('cron-proposed body');

    // Conflict snapshot exists and matches the tampered file
    expect(existsSync(historyDir())).toBe(true);
    const snapshots = readdirSync(historyDir());
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toMatch(/^conflict-.*\.md$/);
    expect(readFileSync(join(historyDir(), snapshots[0]!), 'utf-8')).toBe(tampered);

    // Structured event was logged
    const drift = events.find((e) => e.kind === 'managed_section_drift_detected');
    expect(drift).toBeDefined();
    expect((drift!.data as Record<string, unknown>).conflictPath).toBe(result.backupPath);
  });

  it.skipIf(isWindows)('conflict backup is mode 0600', () => {
    writeManagedSection({ projectRoot, content: { body: 'baseline' }, logger });
    const file = readFileSync(claudeMd(), 'utf-8');
    writeFileSync(claudeMd(), file.replace('baseline', 'tampered'));

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'will not write' },
      logger,
    });

    expect(result.verdict).toBe('drift_aborted');
    const stats = statSync(result.backupPath!);
    expect(stats.mode & 0o077).toBe(0);
  });

  it('drift on dry-run reports drift_aborted without writing a backup', () => {
    writeManagedSection({ projectRoot, content: { body: 'baseline' }, logger });
    const file = readFileSync(claudeMd(), 'utf-8');
    writeFileSync(claudeMd(), file.replace('baseline', 'tampered'));

    events.length = 0;
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'preview' },
      dryRun: true,
      logger,
    });

    expect(result.verdict).toBe('drift_aborted');
    expect(result.backupPath).toBeNull();
    // Dry-run must NOT touch disk — no history dir created
    expect(existsSync(historyDir())).toBe(false);
    // Drift event is still emitted so the recap surfaces what happened
    expect(events.some((e) => e.kind === 'managed_section_drift_detected')).toBe(true);
  });

  it('clearLastHash forgets the stored hash so the next write proceeds', () => {
    writeManagedSection({ projectRoot, content: { body: 'baseline' }, logger });
    const file = readFileSync(claudeMd(), 'utf-8');
    writeFileSync(claudeMd(), file.replace('baseline', 'tampered'));

    // With stored hash → drift
    let result = writeManagedSection({
      projectRoot,
      content: { body: 'attempt-1' },
      logger,
    });
    expect(result.verdict).toBe('drift_aborted');

    // Clear → next write is treated as first-run and proceeds
    clearLastHash(projectRoot);
    events.length = 0;
    result = writeManagedSection({
      projectRoot,
      content: { body: 'attempt-2' },
      logger,
    });
    expect(result.verdict).toBe('updated');
    expect(readFileSync(claudeMd(), 'utf-8')).toContain('attempt-2');
    // After successful write, hash is recorded again
    expect(readLastHash(projectRoot)).not.toBeNull();
  });

  it('idempotent re-write does not trigger drift', () => {
    writeManagedSection({ projectRoot, content: { body: 'same' }, logger });
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'same' },
      logger,
    });
    expect(result.verdict).toBe('unchanged');
    expect(events).toEqual([]);
  });

  it('user removing entire managed section is treated as drift', () => {
    writeManagedSection({ projectRoot, content: { body: 'managed' }, logger });

    // User deletes the section completely (and any reference to it)
    writeFileSync(claudeMd(), '# CLAUDE.md\n\nUser-only content now.\n');

    events.length = 0;
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'cron-rebuild' },
      logger,
    });

    // The section is gone → computed hash is empty, but stored hash is not
    // → that's drift; abort instead of silently re-adding what user removed.
    expect(result.verdict).toBe('drift_aborted');
    expect(events.some((e) => e.kind === 'managed_section_drift_detected')).toBe(true);
  });

  // Regression: YODA Fix 1 — removeManagedSection must clear the stored
  // hash. Without the clear, a subsequent writeManagedSection computes
  // '' (no markers on disk) against the non-empty stored hash and aborts
  // as drift, wedging the learner with no recovery path other than manual
  // deletion of the hash-store file.
  it('removeManagedSection clears the stored hash so the next write proceeds', () => {
    // 1. Write establishes a managed section and stores a hash.
    writeManagedSection({ projectRoot, content: { body: 'v1' }, logger });
    expect(readLastHash(projectRoot)).not.toBeNull();

    // 2. Remove the managed section (simulates CLI `remove` verb).
    removeManagedSection(projectRoot);

    // The hash store must be cleared — the section no longer exists on disk
    // so keeping an old hash would permanently trip drift detection.
    expect(readLastHash(projectRoot)).toBeNull();

    // 3. The next write must proceed normally (not abort as drift).
    events.length = 0;
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'v2-after-remove' },
      logger,
    });
    expect(result.verdict).toBe('updated');
    expect(readFileSync(claudeMd(), 'utf-8')).toContain('v2-after-remove');
    expect(events.some((e) => e.kind === 'managed_section_drift_detected')).toBe(false);
    // Post-write hash is recorded again.
    expect(readLastHash(projectRoot)).not.toBeNull();
  });
});

describe('ManagedSectionEditor — E2 git-aware skip', () => {
  let projectRoot: string;
  const events: Array<{ kind: string; data: unknown }> = [];
  const logger = (kind: string, data?: unknown) => events.push({ kind, data });

  beforeEach(() => {
    projectRoot = makeTmpDir();
    events.length = 0;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const claudeMd = () => join(projectRoot, 'CLAUDE.md');

  it('skips write when MERGE_HEAD is present', () => {
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.git', 'MERGE_HEAD'), 'deadbeef\n');

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'should not be written' },
      logger,
    });

    expect(result.verdict).toBe('git_busy');
    expect(result.bytesAfter).toBe(0);
    expect(existsSync(claudeMd())).toBe(false);
    expect(events.some((e) => e.kind === 'managed_section_skip_git_state')).toBe(true);
  });

  it('skips write when in interactive rebase (rebase-merge/ dir)', () => {
    mkdirSync(join(projectRoot, '.git', 'rebase-merge'), { recursive: true });

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'should not be written' },
      logger,
    });

    expect(result.verdict).toBe('git_busy');
    expect(existsSync(claudeMd())).toBe(false);
  });

  it('skips write when in non-interactive rebase (rebase-apply/ dir)', () => {
    mkdirSync(join(projectRoot, '.git', 'rebase-apply'), { recursive: true });

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'no-op' },
      logger,
    });
    expect(result.verdict).toBe('git_busy');
  });

  it('skips write when CHERRY_PICK_HEAD is present', () => {
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.git', 'CHERRY_PICK_HEAD'), 'sha\n');

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'no-op' },
      logger,
    });
    expect(result.verdict).toBe('git_busy');
  });

  it('skips write when BISECT_LOG is present', () => {
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.git', 'BISECT_LOG'), 'log\n');

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'no-op' },
      logger,
    });
    expect(result.verdict).toBe('git_busy');
  });

  it('skips write when REVERT_HEAD is present', () => {
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.git', 'REVERT_HEAD'), 'sha\n');

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'no-op' },
      logger,
    });
    expect(result.verdict).toBe('git_busy');
  });

  it('writes normally when .git is absent (non-git project)', () => {
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'normal' },
      logger,
    });
    expect(result.verdict).toBe('created');
  });

  it('writes normally when .git exists with no busy markers', () => {
    mkdirSync(join(projectRoot, '.git'));
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'normal' },
      logger,
    });
    expect(result.verdict).toBe('created');
  });

  it('git-busy supersedes drift check (no backup written, no FS mutation)', () => {
    // Set up a real drift scenario first…
    writeManagedSection({ projectRoot, content: { body: 'baseline' }, logger });
    const file = readFileSync(claudeMd(), 'utf-8');
    writeFileSync(claudeMd(), file.replace('baseline', 'tampered'));

    // …then simulate a rebase
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.git', 'MERGE_HEAD'), 'sha\n');

    events.length = 0;
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'attempt' },
      logger,
    });

    expect(result.verdict).toBe('git_busy');
    // No conflict snapshot was created — git-busy short-circuits FIRST
    expect(existsSync(join(projectRoot, '.auto-sop', 'state', 'managed-history'))).toBe(false);
    // CLAUDE.md still has the tampered content
    expect(readFileSync(claudeMd(), 'utf-8')).toContain('tampered');
  });
});

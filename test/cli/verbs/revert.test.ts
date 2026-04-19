/**
 * Unit tests for `auto-sop revert` (E3 / PLAN-v16 Wave 3).
 *
 * Coverage:
 *   - Backup exists        → revert succeeds, bytes match, hash cleared.
 *   - Missing backup       → exit 1, CLAUDE.md unchanged.
 *   - Empty backup         → exit 1, CLAUDE.md unchanged.
 *   - --dry-run            → prints description, leaves files untouched.
 *   - --json success       → valid JSON with restored_path + bytes.
 *   - --json failure       → valid JSON with ok:false, reason:'no_backup'.
 *   - Hash store cleared   → `managed-section-hash.json` removed post-revert.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from '../../../src/cli/main.js';
import {
  writeLastHash,
  readLastHash,
} from '../../../src/managed-section/hash-store.js';

describe('revert verb', () => {
  let tmpDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'sop-revert-'));
    stdoutChunks = [];
    stderrChunks = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    originalExitCode = process.exitCode;
    process.exitCode = 0;

    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function stdout(): string {
    return stdoutChunks.join('');
  }

  function stderr(): string {
    return stderrChunks.join('');
  }

  function claudeMdPath(): string {
    return path.join(tmpDir, 'CLAUDE.md');
  }

  function backupPath(): string {
    return path.join(tmpDir, '.auto-sop', 'state', 'CLAUDE.md.backup');
  }

  function writeBackup(content: string): void {
    mkdirSync(path.dirname(backupPath()), { recursive: true });
    writeFileSync(backupPath(), content);
  }

  // ─── Success path ─────────────────────────────────────────

  describe('backup exists', () => {
    it('restores CLAUDE.md byte-for-byte from backup', async () => {
      const original = '# Original content\n\nManaged section lived here.\n';
      const current = '# Mutated content\n\nSomething the learner wrote.\n';
      writeBackup(original);
      writeFileSync(claudeMdPath(), current);

      const code = await runCli([
        'node',
        'auto-sop',
        'revert',
        '--project',
        tmpDir,
      ]);

      expect(code).toBe(0);
      expect(process.exitCode).toBeFalsy();
      const restored = readFileSync(claudeMdPath(), 'utf-8');
      expect(restored).toBe(original);
      expect(stdout()).toContain('\u2713 Reverted CLAUDE.md from backup');
    });

    it('clears the hash store after successful revert', async () => {
      writeBackup('# backup\n');
      writeFileSync(claudeMdPath(), '# current\n');
      writeLastHash(tmpDir, 'deadbeef'.repeat(8));
      expect(readLastHash(tmpDir)).not.toBeNull();

      await runCli(['node', 'auto-sop', 'revert', '--project', tmpDir]);

      expect(readLastHash(tmpDir)).toBeNull();
    });

    it('works when CLAUDE.md does not yet exist', async () => {
      const original = '# only-the-backup\n';
      writeBackup(original);
      // no CLAUDE.md written

      const code = await runCli([
        'node',
        'auto-sop',
        'revert',
        '--project',
        tmpDir,
      ]);

      expect(code).toBe(0);
      expect(readFileSync(claudeMdPath(), 'utf-8')).toBe(original);
    });

    it('--json emits ok:true with restored_path, backup_taken_at, bytes', async () => {
      const original = 'body';
      writeBackup(original);
      writeFileSync(claudeMdPath(), 'current');

      await runCli([
        'node',
        'auto-sop',
        '--json',
        'revert',
        '--project',
        tmpDir,
      ]);

      const parsed = JSON.parse(stdout().trim()) as Record<string, unknown>;
      expect(parsed.ok).toBe(true);
      expect(parsed.verb).toBe('revert');
      expect(parsed.restored_path).toBe(claudeMdPath());
      expect(parsed.bytes).toBe(Buffer.byteLength(original, 'utf-8'));
      expect(typeof parsed.backup_taken_at).toBe('string');
      // Backup timestamp is an ISO8601 datetime.
      expect(Number.isFinite(Date.parse(parsed.backup_taken_at as string))).toBe(
        true,
      );
    });
  });

  // ─── Missing / empty backup ──────────────────────────────

  describe('no backup', () => {
    it('exits 1 with stderr message when backup file missing', async () => {
      const originalClaudeMd = '# untouched\n';
      writeFileSync(claudeMdPath(), originalClaudeMd);
      // No backup created.

      await runCli(['node', 'auto-sop', 'revert', '--project', tmpDir]);

      expect(process.exitCode).toBe(1);
      expect(stderr()).toContain('\u2717 No backup to revert from');
      // CLAUDE.md must be untouched.
      expect(readFileSync(claudeMdPath(), 'utf-8')).toBe(originalClaudeMd);
    });

    it('exits 1 when backup exists but is zero bytes', async () => {
      writeBackup('');
      const originalClaudeMd = '# still-here\n';
      writeFileSync(claudeMdPath(), originalClaudeMd);

      await runCli(['node', 'auto-sop', 'revert', '--project', tmpDir]);

      expect(process.exitCode).toBe(1);
      expect(stderr()).toContain('No backup to revert from');
      expect(readFileSync(claudeMdPath(), 'utf-8')).toBe(originalClaudeMd);
    });

    it('--json emits ok:false with reason:no_backup', async () => {
      await runCli([
        'node',
        'auto-sop',
        '--json',
        'revert',
        '--project',
        tmpDir,
      ]);

      const parsed = JSON.parse(stdout().trim()) as Record<string, unknown>;
      expect(parsed.ok).toBe(false);
      expect(parsed.verb).toBe('revert');
      expect(parsed.reason).toBe('no_backup');
      expect(process.exitCode).toBe(1);
    });
  });

  // ─── Dry run ─────────────────────────────────────────────

  describe('--dry-run', () => {
    it('describes the restore but leaves CLAUDE.md untouched', async () => {
      const backup = 'backup line 1\nbackup line 2\n';
      const current = 'current line 1\n';
      writeBackup(backup);
      writeFileSync(claudeMdPath(), current);

      const beforeStat = statSync(claudeMdPath()).mtimeMs;
      await runCli([
        'node',
        'auto-sop',
        'revert',
        '--project',
        tmpDir,
        '--dry-run',
      ]);

      expect(stdout()).toContain('Would restore:');
      expect(stdout()).toContain(backupPath());
      // CLAUDE.md unchanged on disk + by mtime.
      expect(readFileSync(claudeMdPath(), 'utf-8')).toBe(current);
      const afterStat = statSync(claudeMdPath()).mtimeMs;
      expect(afterStat).toBe(beforeStat);
    });

    it('--dry-run does not clear the hash store', async () => {
      writeBackup('payload');
      writeFileSync(claudeMdPath(), 'current');
      writeLastHash(tmpDir, 'a'.repeat(64));
      const before = readLastHash(tmpDir);
      expect(before).not.toBeNull();

      await runCli([
        'node',
        'auto-sop',
        'revert',
        '--project',
        tmpDir,
        '--dry-run',
      ]);

      const after = readLastHash(tmpDir);
      expect(after).not.toBeNull();
      expect(after!.lastHash).toBe(before!.lastHash);
    });

    it('--dry-run + --json emits descriptive JSON', async () => {
      writeBackup('backup body\nsecond line\n');
      writeFileSync(claudeMdPath(), 'current body\n');

      await runCli([
        'node',
        'auto-sop',
        '--json',
        'revert',
        '--project',
        tmpDir,
        '--dry-run',
      ]);

      const parsed = JSON.parse(stdout().trim()) as Record<string, unknown>;
      expect(parsed.ok).toBe(true);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.backup_path).toBe(backupPath());
      expect(parsed.restore_path).toBe(claudeMdPath());
      expect(parsed.current_lines).toBe(1);
      expect(parsed.backup_lines).toBe(2);
    });
  });

  // ─── Path resolution ─────────────────────────────────────

  describe('projectRoot resolution', () => {
    it('defaults to process.cwd() when --project is omitted', async () => {
      // We can't reliably assert what cwd is here — instead, we run with
      // an explicitly NON-existent project and confirm no_backup verdict
      // is produced (proves the flag was parsed and default path logic
      // engaged without blowing up).
      const otherDir = mkdtempSync(path.join(tmpdir(), 'sop-revert-cwd-'));
      try {
        const originalCwd = process.cwd();
        try {
          process.chdir(otherDir);
          await runCli(['node', 'auto-sop', '--json', 'revert']);
        } finally {
          process.chdir(originalCwd);
        }
        const parsed = JSON.parse(stdout().trim()) as Record<string, unknown>;
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toBe('no_backup');
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    });
  });

  // ─── Atomic write contract ───────────────────────────────

  describe('atomic restore', () => {
    it('does not leave a .revert.tmp file behind on success', async () => {
      writeBackup('final\n');
      writeFileSync(claudeMdPath(), 'before\n');

      await runCli(['node', 'auto-sop', 'revert', '--project', tmpDir]);

      const tmpPath = claudeMdPath() + '.revert.tmp';
      expect(existsSync(tmpPath)).toBe(false);
    });
  });

  // ─── APEX SEC-004 — path traversal guard ─────────────────
  //
  // hash-store.ts and directive-history.ts already defend against a
  // projectRoot with traversal segments. The revert verb must do the
  // same so `--project` can't route a restore at a resolved-but-
  // traversable path. `path.resolve()` collapses relative `..`
  // segments but preserves `..` that appear as part of a literal
  // directory name (e.g. `/tmp/foo..bar`) — the guard catches both.

  describe('APEX SEC-004: path-traversal guard', () => {
    it('rejects a projectRoot whose resolved form contains "..": --json emits ok:false', async () => {
      // `/tmp/abc..def` is a legitimate absolute path — `path.resolve`
      // does not strip the `..` because it's not a standalone segment.
      // Without the guard this would flow through into fs.rename on
      // an attacker-influenced path; with the guard we bail early.
      const traversalPath = path.join(tmpdir(), 'evil..injected');

      await runCli([
        'node',
        'auto-sop',
        '--json',
        'revert',
        '--project',
        traversalPath,
      ]);

      const parsed = JSON.parse(stdout().trim()) as Record<string, unknown>;
      expect(parsed.ok).toBe(false);
      expect(parsed.verb).toBe('revert');
      expect(parsed.reason).toBe('invalid_project_path');
      expect(process.exitCode).toBe(1);
    });

    it('rejects a traversal path in human mode with clear error message', async () => {
      const traversalPath = path.join(tmpdir(), 'foo..bar');
      await runCli([
        'node',
        'auto-sop',
        'revert',
        '--project',
        traversalPath,
      ]);
      expect(process.exitCode).toBe(1);
      expect(stderr()).toContain('Invalid project path');
    });

    it('does NOT touch files when path is rejected', async () => {
      const traversalPath = path.join(tmpdir(), 'bad..path');
      // Nothing to set up — the guard must fire before any fs work.
      await runCli([
        'node',
        'auto-sop',
        'revert',
        '--project',
        traversalPath,
      ]);
      expect(process.exitCode).toBe(1);
      // The guarded path must not exist as a side-effect.
      expect(existsSync(traversalPath)).toBe(false);
    });
  });
});

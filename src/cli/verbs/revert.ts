/**
 * revert verb — restore CLAUDE.md from the rolling backup written by
 * the ManagedSectionEditor (E3 / PLAN-v16 Wave 3).
 *
 * Backup path contract:
 *   <projectRoot>/.auto-sop/state/CLAUDE.md.backup
 *
 * This is the exact path the editor writes BEFORE mutating CLAUDE.md
 * (editor.ts, step 6). See `writeManagedSection` — the editor creates
 * one rolling backup per write; re-reverting back-to-back is therefore
 * a no-op beyond the most recent write.
 *
 * Contract:
 *   - Missing / empty backup → exit 1 (`✗ No backup to revert from`).
 *   - `--dry-run`            → describe what would happen, touch no files.
 *   - `--json`               → emit a single JSON line on either path.
 *   - Normal mode            → atomic rename (tmp → CLAUDE.md) and clear
 *                              the hash store so the next learner tick
 *                              treats CLAUDE.md as fresh (no false drift).
 */
import type { Command } from 'commander';
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { emit } from '../output/json.js';
import { clearLastHash } from '../../managed-section/hash-store.js';

/** Format an ISO timestamp as `YYYY-MM-DD HH:MM:SS` in local time. */
function formatLocal(iso: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = iso.getFullYear();
  const mo = pad(iso.getMonth() + 1);
  const d = pad(iso.getDate());
  const h = pad(iso.getHours());
  const mi = pad(iso.getMinutes());
  const s = pad(iso.getSeconds());
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

export function registerRevertVerb(program: Command): void {
  program
    .command('revert')
    .description('restore CLAUDE.md from the most recent learner backup')
    .option('--project <path>', 'project root', process.cwd())
    .option('--dry-run', 'describe what would happen without modifying files')
    .action(async (opts, cmd) => {
      const jsonMode: boolean = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project);

      // SEC-004: path-traversal guard, mirroring hash-store.ts and
      // directive-history.ts. `path.resolve` normalises away `..`
      // segments, but a caller that passed a non-absolute input that
      // somehow resolved to a relative-looking path, or a path still
      // containing a literal `..` after resolution (e.g. on exotic
      // filesystems), must never reach the `fs.rename` below. Fail
      // fast with a clear error instead.
      if (!path.isAbsolute(projectRoot) || projectRoot.includes('..')) {
        if (jsonMode) {
          emit({
            ok: false,
            verb: 'revert',
            reason: 'invalid_project_path',
            project: projectRoot,
          });
        } else {
          process.stderr.write(pc.red('\u2717 Invalid project path\n'));
        }
        process.exitCode = 1;
        return;
      }

      const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
      const backupPath = path.join(
        projectRoot,
        '.auto-sop',
        'state',
        'CLAUDE.md.backup',
      );

      // 1. Existence + emptiness check — treat a zero-byte file as "no backup".
      let backupStat: ReturnType<typeof statSync> | null = null;
      if (existsSync(backupPath)) {
        try {
          backupStat = statSync(backupPath);
        } catch {
          backupStat = null;
        }
      }
      if (backupStat === null || backupStat.size === 0) {
        if (jsonMode) {
          emit({ ok: false, verb: 'revert', reason: 'no_backup' });
        } else {
          process.stderr.write(pc.red('\u2717 No backup to revert from\n'));
        }
        process.exitCode = 1;
        return;
      }

      const backupTakenAt = backupStat.mtime;
      const backupTakenAtLabel = formatLocal(backupTakenAt);
      const backupBytes = backupStat.size;

      // 2. Read backup contents up front so dry-run can show diff info
      //    without any write-side-effects.
      let backupContent: string;
      try {
        backupContent = readFileSync(backupPath, 'utf-8');
      } catch (err) {
        if (jsonMode) {
          emit({
            ok: false,
            verb: 'revert',
            reason: 'backup_read_failed',
            error: (err as Error).message,
          });
        } else {
          process.stderr.write(
            pc.red(`\u2717 Failed to read backup: ${(err as Error).message}\n`),
          );
        }
        process.exitCode = 1;
        return;
      }

      // Count backup lines (deterministic: \n splits, final empty trimmed).
      const backupLines = countLines(backupContent);

      // Read current CLAUDE.md for diff summary — missing is OK (revert still
      // proceeds; the current file is treated as "empty" for line-counting).
      let currentContent: string | null = null;
      try {
        currentContent = readFileSync(claudeMdPath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (jsonMode) {
            emit({
              ok: false,
              verb: 'revert',
              reason: 'current_read_failed',
              error: (err as Error).message,
            });
          } else {
            process.stderr.write(
              pc.red(
                `\u2717 Failed to read CLAUDE.md: ${(err as Error).message}\n`,
              ),
            );
          }
          process.exitCode = 1;
          return;
        }
      }
      const currentLines =
        currentContent === null ? 0 : countLines(currentContent);

      // 3. Dry-run: report what would happen, touch nothing.
      if (opts.dryRun === true) {
        if (jsonMode) {
          emit({
            ok: true,
            verb: 'revert',
            dry_run: true,
            restore_path: claudeMdPath,
            backup_path: backupPath,
            backup_taken_at: backupTakenAt.toISOString(),
            bytes: backupBytes,
            current_lines: currentLines,
            backup_lines: backupLines,
          });
        } else {
          process.stdout.write(
            `Would restore: ${backupPath} ` +
              `(${backupBytes} bytes, taken ${backupTakenAtLabel})\n`,
          );
          process.stdout.write(
            pc.dim(
              `  CLAUDE.md: ${currentLines} line${currentLines === 1 ? '' : 's'} \u2192 ` +
                `${backupLines} line${backupLines === 1 ? '' : 's'}\n`,
            ),
          );
        }
        return;
      }

      // 4. Normal mode — atomic restore.
      const tmpPath = claudeMdPath + '.revert.tmp';
      try {
        writeFileSync(tmpPath, backupContent, { mode: 0o644 });
        const fd = openSync(tmpPath, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpPath, claudeMdPath);
        // Re-assert mode in case umask softened it on some FS's.
        try {
          chmodSync(claudeMdPath, 0o644);
        } catch {
          // best-effort
        }
      } catch (err) {
        // Best-effort cleanup of the tmp file; if that fails too, there's
        // nothing more we can safely do.
        try {
          unlinkSync(tmpPath);
        } catch {
          // ignore
        }
        if (jsonMode) {
          emit({
            ok: false,
            verb: 'revert',
            reason: 'restore_failed',
            error: (err as Error).message,
          });
        } else {
          process.stderr.write(
            pc.red(`\u2717 Restore failed: ${(err as Error).message}\n`),
          );
        }
        process.exitCode = 1;
        return;
      }

      // 5. Clear hash store — the next tick must treat CLAUDE.md as fresh
      //    (otherwise the stored hash would mismatch the reverted content
      //    and trigger a false drift_aborted).
      try {
        clearLastHash(projectRoot);
      } catch (err) {
        // Non-fatal: the revert succeeded. Warn the user so they can
        // manually remove the hash file if drift-abort surfaces later.
        if (!jsonMode) {
          process.stderr.write(
            pc.yellow(
              `warning: failed to clear hash store: ${(err as Error).message}\n`,
            ),
          );
        }
      }

      if (jsonMode) {
        emit({
          ok: true,
          verb: 'revert',
          restored_path: claudeMdPath,
          backup_taken_at: backupTakenAt.toISOString(),
          bytes: backupBytes,
        });
      } else {
        process.stdout.write(
          pc.green(
            `\u2713 Reverted CLAUDE.md from backup (taken ${backupTakenAtLabel})\n`,
          ),
        );
      }
    });
}

/**
 * Count newline-separated lines. A trailing newline does NOT add a blank
 * line to the count (a file ending in '\n' is considered to have N lines
 * of content, not N+1). An empty string counts as 0 lines.
 */
function countLines(s: string): number {
  if (s.length === 0) return 0;
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  if (trimmed.length === 0) return 1; // A single "\n" is one empty line
  return trimmed.split('\n').length;
}

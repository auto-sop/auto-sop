/**
 * candidates verb — display, prune, or clear pattern candidates
 * accumulated by the incremental LLM pipeline (PLAN-v29).
 *
 * Commands:
 *   auto-sop candidates [--project <path>]   — show candidates table
 *   auto-sop candidates --json               — emit full JSON
 *   auto-sop candidates --prune              — remove stale (30+ days)
 *   auto-sop candidates --clear              — wipe all candidates
 */
import type { Command } from 'commander';
import path from 'node:path';
import pc from 'picocolors';
import { emit } from '../output/json.js';
import {
  readCandidates,
  writeCandidates,
  pruneStaleCandidates,
} from '../../learner/pattern-store.js';

// ── Helpers ──────────────────────────────────────────────

function candidateStatus(c: { graduated: boolean; last_seen: string }): string {
  if (c.graduated) return 'graduated';
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const lastSeenMs = new Date(c.last_seen).getTime();
  return lastSeenMs < cutoff ? 'stale' : 'active';
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function formatDate(iso: string): string {
  try {
    return iso.slice(0, 10); // YYYY-MM-DD
  } catch {
    return '-';
  }
}

// ── Register ─────────────────────────────────────────────

export function registerCandidatesVerb(program: Command): void {
  program
    .command('candidates')
    .description('show, prune, or clear LLM pattern candidates')
    .option('--project <path>', 'project root', process.cwd())
    .option('--prune', 'remove stale candidates (> 30 days old)', false)
    .option('--clear', 'clear all candidates (fresh start)', false)
    .action(async (opts, cmd) => {
      const jsonMode: boolean = cmd.parent?.opts().json ?? false;
      const rawPath = opts.project as string;

      // SEC: null-byte injection guard
      if (rawPath.includes('\0')) {
        if (jsonMode) {
          emit({ ok: false, verb: 'candidates', reason: 'invalid_project_path', project: rawPath });
        } else {
          process.stderr.write(pc.red('✗ Invalid project path\n'));
        }
        process.exitCode = 1;
        return;
      }

      const root = path.resolve(rawPath);

      const stateDir = path.join(root, '.auto-sop', 'state');

      try {
        // ── --clear: wipe everything ──────────────────────
        if (opts.clear === true) {
          writeCandidates(stateDir, []);
          if (jsonMode) {
            emit({ ok: true, verb: 'candidates', action: 'clear', cleared: true });
          } else {
            process.stdout.write(pc.green('✓ All candidates cleared\n'));
          }
          return;
        }

        // ── --prune: remove stale ─────────────────────────
        if (opts.prune === true) {
          const before = readCandidates(stateDir);
          const after = pruneStaleCandidates(before, 30);
          const pruned = before.length - after.length;
          writeCandidates(stateDir, after);

          if (jsonMode) {
            emit({
              ok: true,
              verb: 'candidates',
              action: 'prune',
              before_count: before.length,
              after_count: after.length,
              pruned_count: pruned,
            });
          } else {
            if (pruned === 0) {
              process.stdout.write(pc.green('✓ No stale candidates to prune\n'));
            } else {
              process.stdout.write(
                pc.green(`✓ Pruned ${pruned} stale candidate(s) (${after.length} remaining)\n`),
              );
            }
          }
          return;
        }

        // ── Default: show candidates ──────────────────────
        const candidates = readCandidates(stateDir);

        if (jsonMode) {
          emit({ ok: true, verb: 'candidates', candidates });
          return;
        }

        if (candidates.length === 0) {
          process.stdout.write(pc.dim('No pattern candidates found.\n'));
          return;
        }

        // Column widths
        const COL = {
          id: 10,
          pattern: 30,
          severity: 9,
          sessions: 10,
          occurrences: 12,
          first_seen: 12,
          last_seen: 12,
          status: 10,
        };

        // Header
        const header = [
          padRight('ID', COL.id),
          padRight('PATTERN', COL.pattern),
          padRight('SEVERITY', COL.severity),
          padRight('SESSIONS', COL.sessions),
          padRight('OCCURRENCES', COL.occurrences),
          padRight('FIRST SEEN', COL.first_seen),
          padRight('LAST SEEN', COL.last_seen),
          padRight('STATUS', COL.status),
        ].join('  ');

        process.stdout.write(pc.bold('Pattern Candidates') + '\n');
        process.stdout.write(pc.dim(header) + '\n');
        process.stdout.write(pc.dim('─'.repeat(header.length)) + '\n');

        for (const c of candidates) {
          const status = candidateStatus(c);
          const statusColor =
            status === 'graduated' ? pc.green : status === 'stale' ? pc.yellow : pc.white;

          const row = [
            padRight(c.id.slice(0, 8), COL.id),
            padRight(
              c.pattern.length > COL.pattern - 2
                ? c.pattern.slice(0, COL.pattern - 3) + '...'
                : c.pattern,
              COL.pattern,
            ),
            padRight(c.severity, COL.severity),
            padRight(String(new Set(c.session_ids).size), COL.sessions),
            padRight(String(c.occurrence_count), COL.occurrences),
            padRight(formatDate(c.first_seen), COL.first_seen),
            padRight(formatDate(c.last_seen), COL.last_seen),
            statusColor(padRight(status, COL.status)),
          ].join('  ');

          process.stdout.write(row + '\n');
        }

        process.stdout.write(
          '\n' + pc.dim(`Total: ${candidates.length} candidate(s)`) + '\n',
        );
      } catch (err) {
        if (jsonMode) {
          emit({
            ok: false,
            verb: 'candidates',
            reason: 'candidates_failed',
            error: (err as Error).message,
          });
        } else {
          process.stderr.write(pc.red(`✗ Failed: ${(err as Error).message}\n`));
        }
        process.exitCode = 1;
      }
    });
}

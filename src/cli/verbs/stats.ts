/**
 * stats verb — display per-project directive-fire metrics.
 *
 * Usage:
 *   auto-sop stats                              — show stats for cwd
 *   auto-sop stats --project /path/to/project   — specify project root
 *   auto-sop stats --json                       — machine-readable output
 *   auto-sop stats --since 2026-03-01           — filter fires after date
 *   auto-sop stats --minutes-per-error 20       — override time estimate
 *
 * V31: shows fires by category, real errors prevented, severity emojis,
 *      and session before/after comparison.
 */
import type { Command } from 'commander';
import path from 'node:path';
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import { PathResolver } from '../../path-resolver/index.js';
import { aggregateStats, type FireByDirective } from '../stats/aggregator.js';
import { emit } from '../output/json.js';
import { error as cliError } from '../output/human.js';

// ── Helpers ─────────────────────────────────────────────

/** Format minutes into human-readable hours/minutes string. */
function formatTimeSaved(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes} minutes`;
  const hours = totalMinutes / 60;
  return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)} hours`;
}

/** Format a date string as YYYY-MM-DD. */
function formatDate(iso: string): string {
  try {
    return iso.slice(0, 10);
  } catch {
    return '-';
  }
}

/** Pluralize "fire" / "fires". */
function firePlural(n: number): string {
  return n === 1 ? 'fire' : 'fires';
}

/** Right-pad a number to a given width. */
function padNum(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** V31: severity → emoji for display. */
function severityEmoji(severity?: 'error' | 'warning' | 'info'): string {
  switch (severity) {
    case 'error':
      return '⛔'; // ⛔
    case 'warning':
      return '⚠️'; // ⚠️
    case 'info':
      return 'ℹ️'; // ℹ️
    default:
      return ' ';
  }
}

/** V31: format percentage with sign. */
function formatPct(pct: number): string {
  const sign = pct <= 0 ? '' : '+';
  return `${sign}${pct.toFixed(1)}%`;
}

// ── Top Directives Display ──────────────────────────────

const TOP_N = 5;

function printTopDirectives(fires: FireByDirective[]): void {
  if (fires.length === 0) return;

  process.stdout.write('\n' + pc.bold('Top Firing Directives:') + '\n');

  const top = fires.slice(0, TOP_N);
  // Find max count width for alignment
  const maxCountWidth = String(top[0]!.fire_count).length;

  for (let i = 0; i < top.length; i++) {
    const entry = top[i]!;
    const rank = `${i + 1}.`;
    const countStr = padNum(entry.fire_count, maxCountWidth);
    const label = firePlural(entry.fire_count);
    const emoji = severityEmoji(entry.severity);
    // Truncate preview for display
    const preview =
      entry.rule_text_preview.length > 50
        ? entry.rule_text_preview.slice(0, 47) + '...'
        : entry.rule_text_preview;
    process.stdout.write(`  ${rank} ${emoji} [${countStr} ${label.padEnd(5)}] ${preview}\n`);
  }
}

// ── Verb Registration ───────────────────────────────────

export function registerStatsVerb(program: Command): void {
  program
    .command('stats')
    .description('show directive-fire metrics for a project')
    .option('--project <path>', 'project root', process.cwd())
    .option('--since <date>', 'filter fires after this date (ISO or YYYY-MM-DD)')
    .option('--minutes-per-error <n>', 'minutes saved per error (default: 15)', parseFloat)
    .action(async (opts, cmd) => {
      const jsonMode: boolean = cmd.parent?.opts().json ?? false;
      const rawPath = opts.project as string;

      // SEC: null-byte injection guard
      if (rawPath.includes('\0')) {
        if (jsonMode) {
          emit({ ok: false, verb: 'stats', reason: 'invalid_project_path' });
        } else {
          cliError('Invalid project path');
        }
        process.exitCode = 1;
        return;
      }

      const projectRoot = path.resolve(rawPath);
      const stateDir = path.join(projectRoot, '.auto-sop', 'state');

      // Check if project is installed
      if (!existsSync(stateDir)) {
        if (jsonMode) {
          emit({
            ok: false,
            verb: 'stats',
            reason: 'not_installed',
            message: 'auto-sop is not installed for this project',
          });
        } else {
          cliError(
            'auto-sop is not installed for this project.\n' +
              `  No state directory found at: ${stateDir}\n` +
              '  Run: auto-sop install',
          );
        }
        process.exitCode = 1;
        return;
      }

      // Resolve project identity for the slug
      const resolver = new PathResolver();
      let projectSlug: string;
      try {
        const { identity } = await resolver.resolve(projectRoot);
        projectSlug = identity.slug;
      } catch {
        // Fallback: use directory basename as slug
        projectSlug = path.basename(projectRoot);
      }

      // Parse --since (validate date format)
      let since: string | undefined;
      if (opts.since !== undefined) {
        const sinceStr = opts.since as string;
        const parsed = new Date(sinceStr);
        if (isNaN(parsed.getTime())) {
          if (jsonMode) {
            emit({
              ok: false,
              verb: 'stats',
              reason: 'invalid_since',
              message: `Invalid date: ${sinceStr}`,
            });
          } else {
            cliError(`Invalid --since date: "${sinceStr}". Use ISO or YYYY-MM-DD format.`);
          }
          process.exitCode = 1;
          return;
        }
        since = parsed.toISOString();
      }

      // Parse --minutes-per-error
      const minutesPerError =
        opts.minutesPerError !== undefined ? (opts.minutesPerError as number) : undefined;
      if (minutesPerError !== undefined && (isNaN(minutesPerError) || minutesPerError <= 0)) {
        if (jsonMode) {
          emit({
            ok: false,
            verb: 'stats',
            reason: 'invalid_minutes_per_error',
            message: '--minutes-per-error must be a positive number',
          });
        } else {
          cliError('--minutes-per-error must be a positive number.');
        }
        process.exitCode = 1;
        return;
      }

      try {
        const stats = aggregateStats({
          stateDir,
          projectRoot,
          projectSlug,
          since,
          minutesPerError,
        });

        if (jsonMode) {
          emit({ ok: true, verb: 'stats', ...stats });
          return;
        }

        // ── Human-readable output ──────────────────────────
        const periodFrom = formatDate(stats.period.since);
        const periodTo = formatDate(stats.period.until);
        const daysDiff = Math.round(
          (new Date(stats.period.until).getTime() - new Date(stats.period.since).getTime()) /
            (24 * 60 * 60 * 1000),
        );

        process.stdout.write(pc.bold(`auto-sop stats for: ${stats.project_slug}`) + '\n');
        process.stdout.write(
          pc.dim(`Period: ${periodFrom} to ${periodTo} (${daysDiff} days)`) + '\n\n',
        );

        if (stats.total_fires === 0) {
          // Friendly "no fires" message
          process.stdout.write(pc.dim('No fires yet? That is normal for new installs.') + '\n');
          process.stdout.write(
            pc.dim('Directives start firing after the learner detects patterns.') + '\n',
          );

          // V31: still show real errors prevented if available
          if (stats.real_errors_prevented > 0) {
            process.stdout.write(
              '\n' +
                `Real Errors Prevented:  ${stats.real_errors_prevented}\n`,
            );
          }
          return;
        }

        // Summary metrics
        const timeSaved = formatTimeSaved(stats.estimated_minutes_saved);
        process.stdout.write(
          `Directive Fires:        ${stats.total_fires}\n` +
            `Unique Directives Hit:  ${stats.unique_directives_fired} / ${stats.active_directives} active\n` +
            `Est. Errors Prevented:  ${stats.estimated_errors_prevented}\n` +
            `Est. Time Saved:        ${timeSaved}\n`,
        );

        // V31: Fires by category
        const cat = stats.fires_by_category;
        if (cat.error_preventing > 0 || cat.efficiency > 0 || cat.best_practice > 0) {
          process.stdout.write(
            '\n' +
              pc.bold('Fires by Category:') +
              '\n' +
              `  ⛔ Error-preventing:  ${cat.error_preventing}\n` +
              `  ⚠️ Efficiency:        ${cat.efficiency}\n` +
              `  ℹ️ Best-practice:     ${cat.best_practice}\n`,
          );
        }

        // V31: Real errors prevented
        if (stats.real_errors_prevented > 0) {
          process.stdout.write(
            '\n' +
              `Real Errors Prevented:  ${stats.real_errors_prevented}\n`,
          );
        }

        // Top firing directives (V31: with severity emojis)
        printTopDirectives(stats.fires_by_directive);

        // V31: Session comparison before/after
        if (stats.session_comparison !== null) {
          const cmp = stats.session_comparison;
          process.stdout.write('\n' + pc.bold('Session Comparison (Before/After Directives):') + '\n');
          process.stdout.write(
            `  Cutoff:          ${formatDate(cmp.cutoff)}\n` +
              `  Before sessions: ${cmp.before.sessions}  |  After sessions: ${cmp.after.sessions}\n` +
              `  Avg duration:    ${cmp.before.avg_duration_min.toFixed(1)} min -> ${cmp.after.avg_duration_min.toFixed(1)} min  (${formatPct(cmp.improvement.duration_pct)})\n` +
              `  Avg tool calls:  ${cmp.before.avg_tool_calls.toFixed(1)} -> ${cmp.after.avg_tool_calls.toFixed(1)}  (${formatPct(cmp.improvement.tool_calls_pct)})\n` +
              `  Avg bash fails:  ${cmp.before.avg_bash_failures.toFixed(1)} -> ${cmp.after.avg_bash_failures.toFixed(1)}  (${formatPct(cmp.improvement.bash_failures_pct)})\n`,
          );
        }

        // V32: Token estimation
        if (stats.token_estimate !== null && stats.token_estimate.savings_per_session > 0) {
          const te = stats.token_estimate;
          process.stdout.write(
            '\n' +
              `Est. Token Savings:     ~${te.savings_per_session.toLocaleString()} tokens/session (${formatPct(-te.savings_pct)})\n` +
              `  Method: ${te.method.replace(/_/g, '-')} (${te.tokens_per_call} tokens/call)\n`,
          );
        }
      } catch (err) {
        if (jsonMode) {
          emit({
            ok: false,
            verb: 'stats',
            reason: 'aggregation_failed',
            error: (err as Error).message,
          });
        } else {
          cliError(`Failed to aggregate stats: ${(err as Error).message}`);
        }
        process.exitCode = 1;
      }
    });
}

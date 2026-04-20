/**
 * learn-now verb — invoke the learner immediately with full flag control.
 *
 * Replaces the deprecated `recap --run` with a first-class verb.
 * Roadmap: LEARN-07.
 *
 * Usage:
 *   auto-sop learn-now                 — run learner (LLM ON by default)
 *   auto-sop learn-now --offline       — rule-based detectors only
 *   auto-sop learn-now --dry-run       — show what would change, don't write
 *   auto-sop learn-now --force-llm     — force LLM even if turns_new==0
 *   auto-sop learn-now --json          — JSON output
 *   auto-sop learn-now --limit <n>     — limit to N recap entries shown
 */
import type { Command } from 'commander';
import pc from 'picocolors';
import { renderTable } from '../output/human.js';
import { emit } from '../output/json.js';
import { runLearner } from '../shared/learner-spawn.js';

/** Format a recap entry as a human-readable table (mirrors recap.ts). */
function formatEntry(entry: Record<string, unknown>): string {
  if (entry.summary) {
    return renderTable([
      ['tick', String(entry.tick_id ?? '')],
      ['projects', String(entry.projects_processed ?? 0)],
      ['turns new', String(entry.total_turns_new ?? 0)],
      ['duration', `${entry.total_duration_ms ?? 0}ms`],
      ['skipped', String(entry.projects_skipped ?? 0)],
      ['locked', String(entry.projects_locked ?? 0)],
      ['missing', String(entry.projects_missing ?? 0)],
      ['errors', String((entry.errors as string[])?.length ?? 0)],
    ]);
  }
  return renderTable([
    ['tick', String(entry.tick_id ?? '')],
    ['project', String(entry.project_slug ?? '')],
    ['turns new', String(entry.turns_new ?? 0)],
    ['total seen', String(entry.turns_total_seen ?? 0)],
    ['tool calls', String(entry.tool_calls_new ?? 0)],
    ['scrubber', String(entry.scrubber_hits_new ?? 0)],
    ['files', String(entry.files_changed_new ?? 0)],
    ['duration', `${entry.duration_ms ?? 0}ms`],
    ['directive', directiveLabel(entry)],
    ['llm', llmLabel(entry)],
  ]);
}

function directiveLabel(entry: Record<string, unknown>): string {
  const val = entry.directive_written;
  if (val === undefined || val === null) return pc.dim('-');
  switch (val) {
    case 'created':
      return pc.green('created');
    case 'updated':
      return pc.yellow('updated');
    case 'unchanged':
      return pc.dim('unchanged');
    case 'dry_run':
      return pc.cyan('dry_run');
    case 'error':
      return pc.red('error');
    case 'drift_aborted':
      return pc.red('drift_aborted');
    case 'git_busy':
      return pc.dim('git_busy');
    default:
      return String(val);
  }
}

function llmLabel(entry: Record<string, unknown>): string {
  if (entry.llm_mode === undefined) return pc.dim('-');
  if (entry.llm_mode !== true) return pc.dim('offline');
  if (entry.llm_fallback === true) {
    const code = typeof entry.llm_error === 'string' ? entry.llm_error : 'error';
    return pc.red(`fallback (${code})`);
  }
  const ms = typeof entry.llm_duration_ms === 'number' ? entry.llm_duration_ms : 0;
  const proposed =
    typeof entry.llm_directives_proposed === 'number' ? entry.llm_directives_proposed : 0;
  return pc.green(`on (${ms}ms, ${proposed} proposed)`);
}

export function registerLearnNowVerb(program: Command): void {
  program
    .command('learn-now')
    .description('run the learner immediately (LLM mode ON by default)')
    .option('--dry-run', 'show what would change without writing')
    .option('--offline', 'disable LLM mode (rule-based detectors only)')
    .option('--force-llm', 'force LLM analysis even if no new turns')
    .option('--limit <n>', 'limit recap entries shown', (v: string) => parseInt(v, 10))
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;

      const result = await runLearner({
        dryRun: opts.dryRun,
        offline: opts.offline,
        forceLlm: opts.forceLlm,
      });

      if (result.error === 'learner.cjs not found') {
        if (jsonMode) {
          emit({ ok: false, verb: 'learn-now', error: result.error });
        } else {
          process.stderr.write(
            pc.red('error: learner.cjs not found. Run `auto-sop install` first.\n'),
          );
        }
        process.exitCode = 1;
        return;
      }

      if (result.error) {
        if (!jsonMode) {
          process.stderr.write(pc.yellow(`warning: learner exited with error: ${result.error}\n`));
        }
      }

      // Apply --limit
      const limit = opts.limit;
      const lines = limit && limit > 0 ? result.recapLines.slice(-limit) : result.recapLines;

      if (jsonMode) {
        emit({
          ok: result.exitCode === 0,
          verb: 'learn-now',
          exitCode: result.exitCode,
          entries: lines,
          error: result.error,
        });
      } else {
        if (lines.length === 0) {
          process.stdout.write(pc.dim('(no new recap entries)\n'));
        } else {
          for (const entry of lines) {
            process.stdout.write(formatEntry(entry as Record<string, unknown>) + '\n\n');
          }
        }
      }

      // Exit code: 0 success, 1 error
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
    });
}

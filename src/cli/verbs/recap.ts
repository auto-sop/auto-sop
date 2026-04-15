/**
 * recap verb — display and manage learner recap log.
 * Subcommands: recap (pretty table), --json, --run, --run --dry-run, --run --llm, --tail, --limit.
 */
import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs';
import { execa } from 'execa';
import { renderTable, warn } from '../output/human.js';
import { emit } from '../output/json.js';
import pc from 'picocolors';
import { unifiedDiff } from '../diff.js';
import { buildSampleDirectiveFromInput, collectAgentRoster } from '../../learner/directive-builder.js';
import { writeManagedSection } from '../../managed-section/editor.js';
import { readRegistry } from '../../learner/project-registry.js';

function recapLogPath(home?: string): string {
  return path.join(home ?? os.homedir(), '.claude-sop', 'logs', 'recap.log');
}

function parseLines(text: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return entries;
}

/** Format directive_written verdict for display. */
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
    default:
      return String(val);
  }
}

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
  ]);
}

/**
 * For each per-project entry with directive_written === 'dry_run', compute
 * and print a unified diff showing what WOULD be written to CLAUDE.md.
 */
function printDryRunDiffs(entries: Record<string, unknown>[]): void {
  for (const entry of entries) {
    if (entry.directive_written !== 'dry_run') continue;

    const slug = String(entry.project_slug ?? 'unknown');

    // We need the project root to read CLAUDE.md and simulate the write.
    // The recap log doesn't store project_root directly, so we look it up
    // from the project registry.
    const projectRoot = resolveProjectRoot(String(entry.project_id ?? ''));
    if (!projectRoot) {
      process.stdout.write(
        pc.dim(`  (cannot compute diff for ${slug} — project root not found)\n\n`),
      );
      continue;
    }

    // Read existing CLAUDE.md
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
    let oldContent = '';
    try {
      oldContent = readFileSync(claudeMdPath, 'utf-8');
    } catch {
      // file may not exist yet
    }

    // Simulate a non-dry-run write to get the new content.
    // We re-build the directive from the learner's directive-builder.
    let newContent: string;
    try {
      newContent = simulateDirectiveWrite(projectRoot, entry);
    } catch {
      process.stdout.write(
        pc.dim(`  (cannot compute diff for ${slug} — directive build failed)\n\n`),
      );
      continue;
    }

    const diff = unifiedDiff(oldContent, newContent, {
      oldLabel: `${slug}/CLAUDE.md`,
      newLabel: `${slug}/CLAUDE.md (proposed)`,
      context: 3,
    });

    if (diff) {
      process.stdout.write(pc.bold(`Diff for ${slug}:\n`));
      // Colorize diff lines
      for (const line of diff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) {
          process.stdout.write(pc.bold(line) + '\n');
        } else if (line.startsWith('+')) {
          process.stdout.write(pc.green(line) + '\n');
        } else if (line.startsWith('-')) {
          process.stdout.write(pc.red(line) + '\n');
        } else if (line.startsWith('@@')) {
          process.stdout.write(pc.cyan(line) + '\n');
        } else {
          process.stdout.write(line + '\n');
        }
      }
      process.stdout.write('\n');
    } else {
      process.stdout.write(pc.dim(`  (no changes for ${slug})\n\n`));
    }
  }
}

/**
 * Resolve project root from project_id by reading the project registry.
 */
function resolveProjectRoot(projectId: string): string | null {
  if (!projectId) return null;
  const registry = readRegistry();
  const entry = registry.projects.find((p) => p.project_id === projectId);
  return entry?.project_root ?? null;
}

/**
 * Simulate what the directive writer would produce for a project, without
 * actually writing anything. Delegates to writeManagedSection with dryRun:true
 * and returns the computed new content.
 */
function simulateDirectiveWrite(
  projectRoot: string,
  entry: Record<string, unknown>,
): string {
  const capturesDir = path.join(projectRoot, '.claude-sop', 'captures');
  const agentRoster = collectAgentRoster(capturesDir);
  const turnsTotalSeen = Number(entry.turns_total_seen ?? 0);
  const nowIso = String(entry.t ?? new Date().toISOString());

  const content = buildSampleDirectiveFromInput({
    turnsTotalSeen,
    agentRoster,
    nowIso,
  });

  const result = writeManagedSection({
    projectRoot,
    content,
    dryRun: true,
  });

  return result.newContent ?? '';
}

export function registerRecapVerb(program: Command): void {
  program
    .command('recap')
    .description('show learner recap log entries')
    .option('--limit <n>', 'show last N entries', (v: string) => parseInt(v, 10), 10)
    .option('--tail', 'follow recap log for new entries')
    .option('--follow', 'alias for --tail')
    .option('--run', 'run the learner now and show results')
    .option('--dry-run', 'dry-run mode: show what would change without writing (requires --run)')
    .option('--llm', 'enable LLM mode when running (requires --run)')
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const logPath = recapLogPath();

      // Validate: --dry-run requires --run
      if (opts.dryRun && !opts.run) {
        process.stderr.write(pc.red('error: --dry-run requires --run (e.g., claude-sop recap --run --dry-run)\n'));
        process.exitCode = 1;
        return;
      }

      // --run: spawn learner child process
      if (opts.run) {
        if (opts.llm) {
          process.stderr.write(pc.yellow('LLM mode — may incur API costs\n'));
        }

        const learnerPath = findLearnerCjs();
        if (!learnerPath) {
          if (jsonMode) {
            emit({ ok: false, verb: 'recap', error: 'learner.cjs not found' });
          } else {
            process.stderr.write(pc.red('error: learner.cjs not found. Run `claude-sop install` first.\n'));
          }
          return;
        }

        // Record pre-run line count
        let preRunLines = 0;
        try {
          const text = readFileSync(logPath, 'utf8');
          preRunLines = text.split('\n').filter((l) => l.trim()).length;
        } catch {
          // file doesn't exist yet
        }

        // Spawn learner
        const env: Record<string, string> = {
          HOME: os.homedir(),
          PATH: process.env.PATH ?? '',
        };
        if (opts.llm) {
          env.CLAUDE_SOP_LEARNER_MODE = 'llm';
        }
        if (opts.dryRun) {
          env.CLAUDE_SOP_LEARNER_DRY_RUN = '1';
        }

        try {
          await execa('node', [learnerPath], { env, timeout: 130_000 });
        } catch (err) {
          if (jsonMode) {
            emit({ ok: false, verb: 'recap', error: String(err) });
          } else {
            warn(`learner exited with error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Show new lines
        try {
          const text = readFileSync(logPath, 'utf8');
          const allLines = text.split('\n').filter((l) => l.trim());
          const newLines = allLines.slice(preRunLines);
          if (jsonMode) {
            for (const line of newLines) {
              process.stdout.write(line + '\n');
            }
          } else {
            if (newLines.length === 0) {
              process.stdout.write(pc.dim('(no new recap entries)\n'));
            } else {
              const parsedEntries: Record<string, unknown>[] = [];
              for (const line of newLines) {
                try {
                  const entry = JSON.parse(line) as Record<string, unknown>;
                  process.stdout.write(formatEntry(entry) + '\n\n');
                  parsedEntries.push(entry);
                } catch {
                  process.stdout.write(line + '\n');
                }
              }

              // In dry-run mode, print diffs for each project with directive_written==='dry_run'
              if (opts.dryRun) {
                const dryRunEntries = parsedEntries.filter(
                  (e) => e.directive_written === 'dry_run' && !e.summary,
                );
                if (dryRunEntries.length > 0) {
                  process.stdout.write(pc.bold('\n── Dry-run diffs ──\n\n'));
                  printDryRunDiffs(dryRunEntries);
                }
              }
            }
          }
        } catch {
          process.stdout.write(pc.dim('(no recap log)\n'));
        }
        return;
      }

      // --tail / --follow: watch for new entries
      if (opts.tail || opts.follow) {
        let lastSize = 0;
        try {
          const stat = await fs.stat(logPath);
          lastSize = stat.size;
        } catch {
          // file doesn't exist yet
        }

        process.stdout.write(pc.dim('watching recap.log for new entries... (Ctrl+C to stop)\n'));

        watchFile(logPath, { interval: 1000 }, () => {
          try {
            const text = readFileSync(logPath, 'utf8');
            const currentSize = Buffer.byteLength(text, 'utf8');
            if (currentSize > lastSize) {
              const newContent = text.slice(lastSize);
              for (const line of newContent.split('\n')) {
                if (!line.trim()) continue;
                if (jsonMode) {
                  process.stdout.write(line + '\n');
                } else {
                  try {
                    const entry = JSON.parse(line) as Record<string, unknown>;
                    process.stdout.write(formatEntry(entry) + '\n\n');
                  } catch {
                    process.stdout.write(line + '\n');
                  }
                }
              }
              lastSize = currentSize;
            }
          } catch {
            // ignore read errors
          }
        });

        // Keep process alive
        await new Promise(() => {
          // never resolves — Ctrl+C to exit
        });
        return;
      }

      // Default: show last N entries
      const limit = opts.limit ?? 10;
      try {
        const text = readFileSync(logPath, 'utf8');
        const entries = parseLines(text);
        const shown = entries.slice(-limit);

        if (jsonMode) {
          for (const entry of shown) {
            process.stdout.write(JSON.stringify(entry) + '\n');
          }
        } else {
          if (shown.length === 0) {
            process.stdout.write(pc.dim('(no recap entries)\n'));
          } else {
            for (const entry of shown) {
              process.stdout.write(formatEntry(entry as Record<string, unknown>) + '\n\n');
            }
          }
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          if (jsonMode) {
            emit({ ok: true, verb: 'recap', count: 0, entries: [] });
          } else {
            process.stdout.write(pc.dim('(no recap log — run `claude-sop recap --run` to generate)\n'));
          }
        } else {
          throw err;
        }
      }
    });
}

function findLearnerCjs(): string | null {
  // Check installed location first
  const installed = path.join(os.homedir(), '.claude-sop', 'marketplace', 'claude-sop', 'learner.cjs');
  if (existsSync(installed)) return installed;

  // Check dist/plugin/ (dev mode)
  const devPath = path.resolve('dist/plugin/learner.cjs');
  if (existsSync(devPath)) return devPath;

  return null;
}

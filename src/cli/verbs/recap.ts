/**
 * recap verb — display and manage learner recap log.
 * Subcommands: recap (pretty table), --json, --run, --run --llm, --tail, --limit.
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
  ]);
}

export function registerRecapVerb(program: Command): void {
  program
    .command('recap')
    .description('show learner recap log entries')
    .option('--limit <n>', 'show last N entries', (v: string) => parseInt(v, 10), 10)
    .option('--tail', 'follow recap log for new entries')
    .option('--follow', 'alias for --tail')
    .option('--run', 'run the learner now and show results')
    .option('--llm', 'enable LLM mode when running (requires --run)')
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const logPath = recapLogPath();

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
              for (const line of newLines) {
                try {
                  const entry = JSON.parse(line) as Record<string, unknown>;
                  process.stdout.write(formatEntry(entry) + '\n\n');
                } catch {
                  process.stdout.write(line + '\n');
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

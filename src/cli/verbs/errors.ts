import type { Command } from 'commander';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { PathResolver } from '../../path-resolver/index.js';
import { emit } from '../output/json.js';
import pc from 'picocolors';

interface ErrorEntry {
  ts: number;
  kind: string;
  msg?: string;
  [k: string]: unknown;
}

function parseSince(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!m) throw new Error(`invalid --since value: ${s} (expected e.g. 30m, 24h, 7d)`);
  const n = parseInt(m[1]!, 10);
  const unit = m[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  const mult: Record<'ms' | 's' | 'm' | 'h' | 'd', number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
  };
  return Date.now() - n * mult[unit];
}

export function registerErrorsVerb(program: Command): void {
  program
    .command('errors')
    .description('show recent errors from errors.jsonl')
    .option('--project <path>', 'project root', process.cwd())
    .option('--tail <n>', 'show last N entries', (v: string) => parseInt(v, 10), 20)
    .option('--since <duration>', 'only show entries since duration ago (e.g. 1h, 24h, 7d)')
    .option('--global', 'read from global per-project mirror (~/.claude/sop/<hash12>/errors.jsonl)')
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project);
      let errorsJsonl: string;
      if (opts.global) {
        const resolver = new PathResolver();
        const { identity } = await resolver.resolve(projectRoot);
        errorsJsonl = path.join(os.homedir(), '.claude', 'sop', identity.projectId, 'errors.jsonl');
      } else {
        errorsJsonl = path.join(projectRoot, '.auto-sop', 'errors.jsonl');
      }
      const cutoff = parseSince(opts.since);
      const entries: ErrorEntry[] = [];
      try {
        const text = await fs.readFile(errorsJsonl, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as ErrorEntry;
            if (cutoff != null && typeof obj.ts === 'number' && obj.ts < cutoff) continue;
            entries.push(obj);
          } catch {
            /* skip malformed lines */
          }
        }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const tail = typeof opts.tail === 'number' && opts.tail > 0 ? opts.tail : 20;
      const shown = entries.slice(-tail);
      if (jsonMode) {
        emit({ ok: true, verb: 'errors', count: shown.length, entries: shown });
      } else {
        if (shown.length === 0) {
          process.stdout.write(pc.dim('(no errors)\n'));
        } else {
          for (const e of shown) {
            const when = typeof e.ts === 'number' ? new Date(e.ts).toISOString() : '?';
            process.stdout.write(`${pc.dim(when)} ${pc.red(e.kind ?? 'error')} ${e.msg ?? ''}\n`);
          }
        }
      }
    });
}

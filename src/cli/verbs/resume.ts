import type { Command } from 'commander';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { emit } from '../output/json.js';
import pc from 'picocolors';

export function registerResumeVerb(program: Command): void {
  program
    .command('resume')
    .description('re-enable capture + learner')
    .option('--project <path>', 'project root', process.cwd())
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project);
      const flagPath = path.join(projectRoot, '.auto-sop', 'paused.flag');
      let removed = false;
      try {
        await fs.rm(flagPath, { force: false });
        removed = true;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (jsonMode) emit({ ok: true, verb: 'resume', removed });
      else
        process.stdout.write(
          pc.green(removed ? '\u2713 resumed\n' : '(already resumed)\n'),
        );
    });
}

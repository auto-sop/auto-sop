import type { Command } from 'commander';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../../atomic/write.js';
import { emit } from '../output/json.js';
import pc from 'picocolors';

export function registerPauseVerb(program: Command): void {
  program
    .command('pause')
    .description('temporarily disable capture + learner (deprecated: use auto-sop off)')
    .option('--project <path>', 'project root', process.cwd())
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project);
      const flagPath = path.join(projectRoot, '.auto-sop', 'paused.flag');
      await fs.mkdir(path.dirname(flagPath), { recursive: true });
      await writeFileAtomic(flagPath, JSON.stringify({ paused_at: Date.now() }) + '\n');
      if (jsonMode) emit({ ok: true, verb: 'pause', flag: flagPath, deprecated: true });
      else {
        process.stderr.write(pc.yellow('Deprecated: use auto-sop off instead\n'));
        process.stdout.write(pc.yellow(`\u2713 paused \u2014 ${flagPath}\n`));
      }
    });
}

import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resolveIdentity } from '../../path-resolver/identity.js';
import { RealGitRunner } from '../../path-resolver/git-runner.js';
import { emit } from '../output/json.js';
import pc from 'picocolors';

export function registerPurgeVerb(program: Command): void {
  program
    .command('purge')
    .description(
      'wipe all captures (project + global) without removing hooks/scheduler',
    )
    .option('--project <path>', 'project root', process.cwd())
    .option('--yes', 'skip confirmation prompt', false)
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project);
      const homeDir = os.homedir();
      const git = new RealGitRunner();
      const identity = await resolveIdentity(projectRoot, git);
      const projectHash12 = identity.projectId;
      const projectCaptures = path.join(
        projectRoot,
        '.auto-sop',
        'captures',
      );
      const globalProject = path.join(
        homeDir,
        '.claude',
        'sop',
        projectHash12,
      );

      if (!opts.yes && !jsonMode) {
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const answer = await rl.question(
            pc.yellow(
              `About to delete:\n  ${projectCaptures}\n  ${globalProject}\nType 'purge' to confirm: `,
            ),
          );
          if (answer.trim() !== 'purge') {
            process.stdout.write('aborted\n');
            return;
          }
        } finally {
          rl.close();
        }
      }

      await fs.rm(projectCaptures, { recursive: true, force: true });
      await fs.rm(globalProject, { recursive: true, force: true });

      if (jsonMode)
        emit({
          ok: true,
          verb: 'purge',
          removed: [projectCaptures, globalProject],
        });
      else process.stdout.write(pc.green('\u2713 captures purged\n'));
    });
}

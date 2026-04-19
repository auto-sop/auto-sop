import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { runUninstall } from '../../installer/uninstall-orchestrator.js';
import { resolveIdentity } from '../../path-resolver/identity.js';
import { RealGitRunner } from '../../path-resolver/git-runner.js';
import { emit } from '../output/json.js';
import { renderTable, warn } from '../output/human.js';
import pc from 'picocolors';
import { ExitCode } from '../exit-codes.js';

export function registerUninstallVerb(program: Command): void {
  program
    .command('uninstall')
    .description('remove auto-sop hooks, scheduler, and managed section')
    .option('--purge', 'also wipe all captures (project + global)', false)
    .option('--project <path>', 'project root', process.cwd())
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project);
      const homeDir = os.homedir();
      const git = new RealGitRunner();
      const identity = await resolveIdentity(projectRoot, git);
      const projectHash12 = identity.projectId;
      const result = await runUninstall({
        projectRoot,
        homeDir,
        purge: !!opts.purge,
        projectHash12,
      });

      if (jsonMode) {
        emit({
          ok: result.warnings.length === 0,
          verb: 'uninstall',
          ...result,
        });
      } else {
        const header =
          result.warnings.length === 0
            ? pc.green('\u2713 uninstall complete')
            : pc.yellow(
                `uninstall completed with ${result.warnings.length} warning(s)`,
              );
        process.stdout.write(header + '\n');
        process.stdout.write(
          renderTable(
            result.steps.map((s) => [
              s.step,
              s.outcome + (s.detail ? ' \u2014 ' + s.detail : ''),
            ]),
          ) + '\n',
        );
        for (const w of result.warnings) warn(w);
        if (result.backupPath)
          process.stdout.write(
            pc.dim(`managed-section backed up to ${result.backupPath}\n`),
          );
      }
      if (result.warnings.length > 0)
        process.exitCode = ExitCode.GENERIC_FAILURE;
    });
}

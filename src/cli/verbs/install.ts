import type { Command } from 'commander';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInstall } from '../../installer/orchestrator.js';
import { emit } from '../output/json.js';
import { renderTable, warn } from '../output/human.js';
import { PreconditionError } from '../errors.js';
import pc from 'picocolors';

export function registerInstallVerb(program: Command): void {
  program
    .command('install')
    .description('install claude-sop into the current project')
    .option('--license <key>', 'license key (non-interactive; skips prompt)')
    .option('--project <path>', 'project root', process.cwd())
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const here = path.dirname(fileURLToPath(import.meta.url));
      const { root: packageRoot, pkg } = findPackageRoot(here);
      const packageVersion = pkg.version as string;
      const pluginBundleSrc = path.join(packageRoot, 'dist', 'plugin');
      const homeDir = os.homedir();
      const marketplaceDir = path.join(
        homeDir,
        '.claude-sop',
        'marketplace',
        'claude-sop',
      );
      const result = await runInstall({
        projectRoot: path.resolve(opts.project as string),
        homeDir,
        licenseKey: opts.license as string | undefined,
        pluginBundleSrc,
        packageVersion,
        nodeBin: process.execPath,
        shimAbsPath: path.join(marketplaceDir, 'shim.cjs'),
        learnerAbsPath: path.join(marketplaceDir, 'learner.cjs'),
      });
      if (jsonMode) {
        emit({ ok: true, verb: 'install', ...result });
      } else {
        process.stdout.write(
          pc.green(`\u2713 claude-sop ${result.verdict} install complete\n`),
        );
        process.stdout.write(
          renderTable([
            ['version', result.installedVersion],
            ['scheduler', result.scheduler],
            ['managed section', result.managedSection],
            ['.gitignore', result.gitignore],
          ]) + '\n',
        );
        for (const w of result.warnings) warn(w);
        process.stdout.write(
          '\n' +
            pc.dim(
              'tip: add [sop:on] indicator to Claude Code statusline:\n' +
                '     echo \'{"statusLine":{"type":"command","command":"claude-sop statusline"}}\' > ~/.claude/settings.json\n' +
                '     (merge with existing settings — do NOT overwrite)\n',
            ),
        );
      }
    });
}

function findPackageRoot(startDir: string): { root: string; pkg: Record<string, unknown> } {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    try {
      const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      return { root: dir, pkg };
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new PreconditionError('could not locate claude-sop package root');
}

import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { collectStatus } from '../../status/collector.js';
import { PathResolver } from '../../path-resolver/index.js';
import { pickBackend } from '../../scheduler/index.js';
import { emit } from '../output/json.js';
import { renderTable } from '../output/human.js';
import { PreconditionError } from '../errors.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function registerDoctorVerb(program: Command): void {
  program
    .command('doctor')
    .description('run install health checks')
    .option('--project <path>', 'project root', process.cwd())
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project as string);
      const homeDir = os.homedir();

      const resolver = new PathResolver();
      const { identity } = await resolver.resolve(projectRoot);

      let schedulerBackend;
      try {
        const picked = await pickBackend();
        schedulerBackend = picked.backend;
      } catch {
        /* unsupported platform */
      }

      const report = await collectStatus({
        projectRoot,
        homeDir,
        projectHash12: identity.projectId,
        projectSlug: identity.slug,
        schedulerBackend,
      });

      const checks: Check[] = [
        {
          name: 'installed',
          ok: report.installedVersion !== null,
          detail: report.installedVersion ?? 'version.txt missing',
        },
        {
          name: 'hooks wired',
          ok: report.hooks.wiringState === 'present',
          detail: `${report.hooks.eventsCovered.length}/5 events`,
        },
        {
          name: 'scheduler registered',
          ok: report.scheduler.installed,
          detail: report.scheduler.backend,
        },
        {
          name: 'managed section',
          ok: report.directives.count > 0,
          detail: `${report.directives.count} directives`,
        },
        {
          name: 'license configured',
          ok: report.license.status !== 'none',
          detail: report.license.status,
        },
        {
          name: 'license not expired',
          ok: report.license.status !== 'expired',
          detail:
            report.license.daysRemaining != null
              ? `${report.license.daysRemaining}d`
              : 'n/a',
        },
        {
          name: 'disk usage',
          ok: true,
          detail: String(report.disk.usageBytes) + ' bytes',
        },
        {
          name: 'not paused',
          ok: !report.paused,
          detail: report.paused ? 'paused.flag present' : 'active',
        },
        {
          name: 'scrubber rules loadable',
          ok: await scrubberRulesLoadable(),
          detail: 'secretlint preset',
        },
      ];
      const failed = checks.filter((c) => !c.ok);

      if (jsonMode) {
        emit({ ok: failed.length === 0, verb: 'doctor', checks });
      } else {
        process.stdout.write(pc.bold('claude-sop doctor') + '\n');
        process.stdout.write(
          renderTable(
            checks.map((c) => [
              c.name,
              (c.ok ? pc.green('ok') : pc.red('fail')) + ' \u2014 ' + c.detail,
            ]),
          ) + '\n',
        );
      }
      if (failed.length > 0) {
        throw new PreconditionError(
          `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`,
        );
      }
    });
}

async function scrubberRulesLoadable(): Promise<boolean> {
  try {
    // Verify the scrubber module is importable (Phase 0 artifact).
    // We don't call loadRulePack() here because it requires a path to a YAML file;
    // just confirming the module resolves is sufficient for the health check.
    const mod = await import('../../scrubber/index.js');
    return typeof mod.loadRulePack === 'function';
  } catch {
    return false;
  }
}

import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { collectStatus } from '../../status/collector.js';
import { PathResolver } from '../../path-resolver/index.js';
import { pickBackend } from '../../scheduler/index.js';
import { renderTable } from '../output/human.js';
import { APP_BASE_URL, ENVIRONMENT } from '../../config/environment.js';
import { emit } from '../output/json.js';

export function registerStatusVerb(program: Command): void {
  program
    .command('status')
    .description('show project install status')
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
        /* unsupported platform — leave undefined */
      }

      const report = await collectStatus({
        projectRoot,
        homeDir,
        projectHash12: identity.projectId,
        projectSlug: identity.slug,
        schedulerBackend,
      });

      if (jsonMode) {
        emit({ ok: true, verb: 'status', ...report });
      } else {
        process.stdout.write(pc.bold('auto-sop status') + '\n');
        process.stdout.write(
          renderTable([
            ['project root', report.project.root],
            ['project hash', report.project.hash12],
            ['project slug', report.project.slug],
            ['installed version', report.installedVersion ?? '(not installed)'],
            [
              'hooks',
              `${report.hooks.wiringState} (${report.hooks.eventsCovered.length}/5 events)`,
            ],
            [
              'scheduler',
              `${report.scheduler.backend}${report.scheduler.installed ? ' [installed]' : ' [absent]'}`,
            ],
            [
              'last tick',
              report.scheduler.lastTickAt
                ? new Date(report.scheduler.lastTickAt).toISOString()
                : 'never',
            ],
            [
              'last learner run',
              report.learner.lastRunAt ? new Date(report.learner.lastRunAt).toISOString() : 'never',
            ],
            ['pending captures', String(report.pendingCaptures)],
            ['directives', String(report.directives.count)],
            ['license', formatLicense(report.license)],
            ['errors (24h)', String(report.errors.last24h)],
            ['disk usage', formatBytes(report.disk.usageBytes)],
            ['paused', report.paused ? 'yes' : 'no'],
            ['environment', formatEnvironment()],
          ]) + '\n',
        );

        // License & Binding section
        const sv = report.serverValidation;
        process.stdout.write('\n' + pc.bold('License & Binding') + '\n');
        const planLabel = sv.plan
          ? `${sv.plan} (${sv.maxProjects ?? '?'} project max)`
          : '(unknown)';
        const serverLabel = sv.lastValidated
          ? `validated ${formatTimeAgo(sv.lastValidated)}`
          : 'never validated';
        const graceLabel = formatGrace(sv.graceRemaining);
        const boundLabel = `${sv.boundProjects}/${sv.maxProjects ?? '?'}`;
        const bindingLabel = report.binding.exists
          ? report.binding.valid
            ? `valid (${report.binding.tokenPreview})`
            : pc.yellow('invalid')
          : pc.dim('not bound');

        process.stdout.write(
          renderTable([
            ['plan', planLabel],
            ['server', sv.isOnline ? serverLabel : pc.yellow(`offline — ${serverLabel}`)],
            ['grace', graceLabel],
            ['bound projects', boundLabel],
            ['project binding', bindingLabel],
            ['upgrade', `${APP_BASE_URL}/upgrade`],
          ]) + '\n',
        );
      }
    });
}

function formatLicense(l: { status: string; daysRemaining: number | null }): string {
  if (l.status === 'trial' && l.daysRemaining != null)
    return `trial (${l.daysRemaining.toFixed(1)} days left)`;
  if (l.status === 'dev-key') return 'dev-key';
  if (l.status === 'expired') return pc.red('expired');
  if (l.status === 'user') return 'paid';
  return '(not configured)';
}

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function formatTimeAgo(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatGrace(graceRemainingMs: number | null): string {
  if (graceRemainingMs === null) return pc.green('7 days remaining');
  if (graceRemainingMs <= 0) return pc.red('EXPIRED');
  const days = graceRemainingMs / (24 * 60 * 60 * 1000);
  const label = `${days.toFixed(1)} days remaining`;
  if (days < 3) return pc.yellow(label);
  return label;
}

function formatEnvironment(): string {
  const host = APP_BASE_URL.replace(/^https?:\/\//, '');
  return ENVIRONMENT === 'staging'
    ? `staging (${host})`
    : `production (${host})`;
}

/**
 * `auto-sop off` — deactivate a project via the server toggle endpoint.
 * Detects the current project slug from cwd, reads license key + machine_id
 * from local state, and calls POST /api/v1/projects/toggle with { active: false }.
 */
import type { Command } from 'commander';
import path from 'node:path';
import pc from 'picocolors';
import { callToggleEndpoint, resolveProjectContext } from './on.js';
import { emit } from '../output/json.js';
import { PreconditionError } from '../errors.js';

export function registerOffVerb(program: Command): void {
  program
    .command('off')
    .description('deactivate this project (server-side toggle)')
    .option('--project <path>', 'project root', process.cwd())
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project as string);

      let ctx: Awaited<ReturnType<typeof resolveProjectContext>>;
      try {
        ctx = await resolveProjectContext(projectRoot);
      } catch (err) {
        if (jsonMode) {
          emit({ verb: 'off', ok: false, error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const msg = err instanceof PreconditionError
          ? err.message
          : `Failed to resolve project context: ${err instanceof Error ? err.message : String(err)}`;
        process.stderr.write(pc.red(`✗ ${msg}\n`));
        process.exitCode = 1;
        return;
      }

      const result = await callToggleEndpoint({
        key: ctx.key,
        machineId: ctx.machineId,
        projectSlug: ctx.slug,
        active: false,
      });

      if (jsonMode) {
        emit({ verb: 'off', ...result });
        return;
      }

      if (!result.ok) {
        const errorMessages: Record<string, string> = {
          invalid_key: 'Invalid license key. Run: auto-sop install',
          project_not_found: `Project '${ctx.slug}' not found on server. Run: auto-sop install`,
          rate_limited: 'Rate limited. Try again in a few minutes.',
          timeout: 'Server request timed out. Check your internet connection.',
        };
        const msg = errorMessages[result.error ?? ''] ?? `Toggle failed: ${result.error}`;
        process.stderr.write(pc.red(`✗ ${msg}\n`));
        process.exitCode = 1;
        return;
      }

      process.stdout.write(pc.green(`✓ ${ctx.slug} will be deactivated at the next learner run\n`));
      process.stdout.write(pc.dim('  ↳ Directives will be preserved and restored when reactivated\n'));
    });
}

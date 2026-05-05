/**
 * `auto-sop on` — activate a project via the server toggle endpoint.
 * Detects the current project slug from cwd, reads license key + machine_id
 * from local state, and calls POST /api/v1/projects/toggle with { active: true }.
 */
import type { Command } from 'commander';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { PathResolver } from '../../path-resolver/index.js';
import { readSecrets } from '../../license/storage.js';
import { getMachineId } from '../../config/machine-id.js';
import { encryptRequest } from '../../license/x25519-encrypt.js';
import { SERVER_X25519_PUBLIC_KEY_B64 } from '../../license/server-public-key.js';
import { API_BASE_URL } from '../../config/environment.js';
import { emit } from '../output/json.js';
import { PreconditionError } from '../errors.js';

/** Timeout for toggle requests in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

export interface ToggleResponse {
  ok: boolean;
  active: boolean;
  project_slug: string;
  deactivated_slug?: string;
  error?: string;
}

export async function callToggleEndpoint(opts: {
  key: string;
  machineId: string;
  projectSlug: string;
  active: boolean;
}): Promise<ToggleResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const rawBody = JSON.stringify({
      key: opts.key,
      machine_id: opts.machineId,
      project_slug: opts.projectSlug,
      active: opts.active,
    });

    let contentType = 'application/json';
    let finalBody = rawBody;
    try {
      const encrypted = encryptRequest(rawBody, SERVER_X25519_PUBLIC_KEY_B64);
      contentType = 'application/x-asop-encrypted';
      finalBody = JSON.stringify(encrypted);
    } catch {
      // Fall back to plaintext if encryption unavailable
    }

    const response = await fetch(`${API_BASE_URL}/projects/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: finalBody,
      signal: controller.signal,
    });

    if (response.status === 401) {
      return { ok: false, active: opts.active, project_slug: opts.projectSlug, error: 'invalid_key' };
    }
    if (response.status === 404) {
      return { ok: false, active: opts.active, project_slug: opts.projectSlug, error: 'project_not_found' };
    }
    if (response.status === 429) {
      return { ok: false, active: opts.active, project_slug: opts.projectSlug, error: 'rate_limited' };
    }
    if (!response.ok) {
      return { ok: false, active: opts.active, project_slug: opts.projectSlug, error: `http_${response.status}` };
    }

    const body = (await response.json()) as Record<string, unknown>;
    const resp: ToggleResponse = {
      ok: true,
      active: opts.active,
      project_slug: opts.projectSlug,
    };
    if (typeof body.deactivated_slug === 'string') {
      resp.deactivated_slug = body.deactivated_slug;
    }
    return resp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, active: opts.active, project_slug: opts.projectSlug, error: 'timeout' };
    }
    return {
      ok: false,
      active: opts.active,
      project_slug: opts.projectSlug,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveProjectContext(projectRoot: string) {
  const resolver = new PathResolver();
  const { identity } = await resolver.resolve(projectRoot);
  const secretsEncPath = join(homedir(), '.auto-sop', 'secrets.enc');
  const secrets = await readSecrets(secretsEncPath);
  if (secrets === null) {
    throw new PreconditionError('no license key found — run auto-sop install first');
  }
  const machineId = await getMachineId();
  return { slug: identity.slug, key: secrets.license.key, machineId };
}

export function registerOnVerb(program: Command): void {
  program
    .command('on')
    .description('activate this project (server-side toggle)')
    .option('--project <path>', 'project root', process.cwd())
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = resolve(opts.project as string);

      let ctx: Awaited<ReturnType<typeof resolveProjectContext>>;
      try {
        ctx = await resolveProjectContext(projectRoot);
      } catch (err) {
        if (jsonMode) {
          emit({ verb: 'on', ok: false, error: err instanceof Error ? err.message : String(err) });
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
        active: true,
      });

      if (jsonMode) {
        emit({ verb: 'on', ...result });
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

      process.stdout.write(pc.green(`✓ ${ctx.slug} will be active at next tick (within ~1 hour)\n`));
      if (result.deactivated_slug) {
        process.stdout.write(pc.dim(`  ↳ ${result.deactivated_slug} will be deactivated\n`));
      }
    });
}

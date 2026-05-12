/**
 * `auto-sop login` — authenticate via browser-based device code flow.
 * Opens the browser for sign-in, receives the license key, validates it,
 * and stores it in secrets.enc.
 */
import type { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import pc from 'picocolors';
import { browserAuth } from '../browser-auth.js';
import { readSecrets, writeSecrets } from '../../license/storage.js';
import { getMachineId } from '../../config/machine-id.js';
import { validateLicense } from '../../license/server-client.js';
import { classifyLicense } from '../prompt.js';
import { emit } from '../output/json.js';

export function registerLoginVerb(program: Command): void {
  program
    .command('login')
    .description('authenticate via browser sign-in')
    .action(async (_opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const secretsEncPath = join(homedir(), '.auto-sop', 'secrets.enc');

      let licenseKey: string;
      try {
        licenseKey = await browserAuth();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode) {
          emit({ verb: 'login', ok: false, error: msg });
          return;
        }
        process.stderr.write(pc.red(`✗ ${msg}\n`));
        process.exitCode = 1;
        return;
      }

      // Check if already logged in with same key
      const existing = await readSecrets(secretsEncPath).catch(() => null);
      if (existing && existing.license.key === licenseKey) {
        // Validate to get email/plan info
        const machineId = await getMachineId();
        const validation = await validateLicense({
          key: licenseKey,
          machineId,
          boundProjects: [],
        });
        const plan = validation.payload?.['plan'] ?? 'unknown';
        const email = validation.payload?.['email'] ?? 'unknown';
        if (jsonMode) {
          emit({ verb: 'login', ok: true, already: true, email, plan });
          return;
        }
        process.stdout.write(pc.cyan(`ℹ Already logged in as ${email}\n`));
        return;
      }

      // Validate the key before storing
      const machineId = await getMachineId();
      const validation = await validateLicense({
        key: licenseKey,
        machineId,
        boundProjects: [],
      });

      if (!validation.success) {
        const errorMsg = validation.error === 'invalid_key'
          ? 'Invalid license key received from server.'
          : `Validation failed: ${validation.error ?? 'unknown error'}`;
        if (jsonMode) {
          emit({ verb: 'login', ok: false, error: errorMsg });
          return;
        }
        process.stderr.write(pc.red(`✗ ${errorMsg}\n`));
        process.exitCode = 1;
        return;
      }

      // Store the key — preserve trial metadata if secrets.enc exists
      const now = Date.now();
      const kind = classifyLicense(licenseKey);

      if (existing) {
        // Update only the license section, preserve trial + install metadata
        await writeSecrets(secretsEncPath, {
          schema_version: 1,
          license: {
            key: licenseKey,
            kind,
            captured_at: now,
          },
          trial: existing.trial,
          install: existing.install,
        });
      } else {
        // No existing secrets — create minimal payload
        await writeSecrets(secretsEncPath, {
          schema_version: 1,
          license: {
            key: licenseKey,
            kind,
            captured_at: now,
          },
          trial: {
            started_at: now,
            duration_days: 14,
          },
          install: {
            version: '0.0.0',
            installed_at: now,
            machine_id_prefix: machineId.slice(0, 8),
          },
        });
      }

      // Write version.txt so checkForUpdate has a correct baseline
      // (prevents false self-update trigger on fresh installs)
      try {
        const autoSopDir = join(homedir(), '.auto-sop');
        await mkdir(autoSopDir, { recursive: true });
        const cliVersion = getCliVersion();
        await writeFile(join(autoSopDir, 'version.txt'), cliVersion + '\n', { mode: 0o600 });
      } catch {
        // Non-fatal — version.txt write failure shouldn't block login
      }

      const plan = validation.payload?.['plan'] ?? 'unknown';
      const email = validation.payload?.['email'] ?? 'unknown';

      if (jsonMode) {
        emit({ verb: 'login', ok: true, email, plan });
        return;
      }

      process.stdout.write(pc.green(`✓ Logged in as ${email} (plan: ${plan})\n`));
      process.stdout.write(pc.dim('  License key stored. Your projects will sync at the next learner run.\n'));
    });
}

/**
 * Read the CLI's own version from package.json.
 * Mirrors the logic in main.ts readPkgVersion().
 */
function getCliVersion(): string {
  let here: string;
  try {
    here = new URL('.', import.meta.url).pathname;
  } catch {
    here = process.cwd();
  }

  for (const p of [
    join(here, '..', '..', '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
    join(here, '..', 'package.json'),
    join(here, 'package.json'),
  ]) {
    try {
      const content = readFileSync(p, 'utf8');
      const parsed = JSON.parse(content) as { version?: string };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

/**
 * `auto-sop update` — check for and perform self-update from global npm package.
 * Does NOT run npm update — that is the user's responsibility.
 */
import type { Command } from 'commander';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { checkForUpdate, performUpdate } from '../../learner/self-update.js';
import { emit } from '../output/json.js';

export function registerUpdateVerb(program: Command): void {
  program
    .command('update')
    .description('update auto-sop from global npm package')
    .action(async (_opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const home = homedir();

      if (jsonMode) {
        await runUpdate(home, true);
      } else {
        await runUpdate(home, false);
      }
    });
}

async function runUpdate(home: string, jsonMode: boolean): Promise<void> {
  if (!jsonMode) {
    process.stdout.write('Checking for updates...\n');
  }

  const info = checkForUpdate(home);

  if (info === null) {
    // Either already up to date or global package not found
    const { findGlobalPackagePath } = await import('../../learner/self-update.js');
    const globalPath = findGlobalPackagePath();

    if (!globalPath) {
      if (jsonMode) {
        emit({ verb: 'update', ok: true, status: 'no_global' });
        return;
      }
      process.stdout.write(
        pc.cyan('ℹ No global package found. Run: npm update -g auto-sop\n'),
      );
      return;
    }

    // Global exists but version is same or older
    if (jsonMode) {
      emit({ verb: 'update', ok: true, status: 'up_to_date' });
      return;
    }
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    let version = 'unknown';
    try {
      const pkg = JSON.parse(readFileSync(join(globalPath, 'package.json'), 'utf8'));
      version = pkg.version ?? 'unknown';
    } catch {
      // ignore
    }
    process.stdout.write(pc.green(`✓ Already up to date (${version})\n`));
    return;
  }

  // Update available
  if (!jsonMode) {
    process.stdout.write(`Updating ${info.installedVersion ?? 'none'} → ${info.globalVersion}...\n`);
  }

  try {
    await performUpdate(home, info);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      emit({ verb: 'update', ok: false, error: msg });
      return;
    }
    process.stderr.write(pc.red(`✗ Update failed: ${msg}\n`));
    process.exitCode = 1;
    return;
  }

  if (jsonMode) {
    emit({
      verb: 'update',
      ok: true,
      status: 'updated',
      from: info.installedVersion ?? 'none',
      to: info.globalVersion,
    });
    return;
  }

  process.stdout.write(pc.green(`✓ Updated to ${info.globalVersion}\n`));
}

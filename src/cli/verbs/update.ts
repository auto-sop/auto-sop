/**
 * `auto-sop update` — check for and perform self-update from npm registry
 * or global npm package.
 */
import type { Command } from 'commander';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { checkForUpdate, performUpdate, findGlobalPackagePath } from '../../learner/self-update.js';
import { emit } from '../output/json.js';

export function registerUpdateVerb(program: Command): void {
  program
    .command('update')
    .description('update auto-sop from npm registry or global package')
    .action(async (_opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const home = homedir();

      await runUpdate(home, jsonMode);
    });
}

async function runUpdate(home: string, jsonMode: boolean): Promise<void> {
  if (!jsonMode) {
    process.stdout.write('Checking npm registry...\n');
  }

  const info = checkForUpdate(home, { forceFresh: true });

  if (info === null) {
    const globalPath = findGlobalPackagePath();

    if (!globalPath) {
      if (jsonMode) {
        emit({ verb: 'update', ok: true, status: 'no_source' });
        return;
      }
      process.stdout.write(
        pc.cyan(
          'i No updates available. Check your internet connection or run: npx auto-sop@latest install\n',
        ),
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

  const sourceLabel = info.source === 'registry' ? 'from npm registry' : 'from global package';

  if (!jsonMode) {
    process.stdout.write(
      `Updating ${info.installedVersion ?? 'none'} → ${info.globalVersion} (${sourceLabel})...\n`,
    );
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
      source: info.source,
    });
    return;
  }

  process.stdout.write(pc.green(`✓ Updated to ${info.globalVersion} (${sourceLabel})\n`));
}

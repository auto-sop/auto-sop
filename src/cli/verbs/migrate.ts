/**
 * migrate verb — assist users migrating from claude-sop to auto-sop.
 *
 * Usage:
 *   auto-sop migrate                    — migrate ~/.claude-sop/ → ~/.auto-sop/
 *   auto-sop migrate --project /path    — also update project hook paths
 *   auto-sop migrate --dry-run          — show what would change without acting
 *
 * Steps:
 *   1. Move ~/.claude-sop/ → ~/.auto-sop/ (if old dir exists)
 *   2. Update launchd plist label (macOS)
 *   3. Update project .claude/settings.json hook paths
 */
import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import { emit } from '../output/json.js';

interface MigrateStep {
  step: string;
  outcome: 'ok' | 'skipped' | 'warning';
  detail?: string;
}

export function registerMigrateVerb(program: Command): void {
  program
    .command('migrate')
    .description('migrate from claude-sop to auto-sop (directory, plist, hooks)')
    .option('--project <path>', 'project root to migrate hooks', process.cwd())
    .option('--dry-run', 'show what would change without acting', false)
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const homeDir = os.homedir();
      const dryRun = !!opts.dryRun;
      const projectRoot = path.resolve(opts.project as string);
      const steps: MigrateStep[] = [];

      // Windows: no migration needed — always fresh install, no legacy claude-sop support.
      if (process.platform === 'win32') {
        const msg = 'Windows does not need migration — fresh install only.';
        if (jsonMode) {
          emit({ ok: true, verb: 'migrate', dryRun, steps: [{ step: 'skip', outcome: 'skipped', detail: msg }] });
        } else {
          process.stdout.write(pc.dim(msg) + '\n');
        }
        return;
      }

      // Step 1: Move ~/.claude-sop/ → ~/.auto-sop/
      const oldHome = path.join(homeDir, '.claude-sop');
      const newHome = path.join(homeDir, '.auto-sop');
      try {
        const oldExists = await dirExists(oldHome);
        const newExists = await dirExists(newHome);
        if (oldExists && !newExists) {
          if (dryRun) {
            steps.push({ step: 'move-home', outcome: 'ok', detail: `would move ${oldHome} → ${newHome}` });
          } else {
            await fs.rename(oldHome, newHome);
            steps.push({ step: 'move-home', outcome: 'ok', detail: `moved ${oldHome} → ${newHome}` });
          }
        } else if (oldExists && newExists) {
          steps.push({
            step: 'move-home',
            outcome: 'warning',
            detail: `both ${oldHome} and ${newHome} exist — merge manually`,
          });
        } else if (!oldExists && newExists) {
          steps.push({ step: 'move-home', outcome: 'skipped', detail: 'already using ~/.auto-sop/' });
        } else {
          steps.push({ step: 'move-home', outcome: 'skipped', detail: 'no ~/.claude-sop/ found' });
        }
      } catch (e) {
        steps.push({
          step: 'move-home',
          outcome: 'warning',
          detail: `failed: ${(e as Error).message}`,
        });
      }

      // Step 2: Update launchd plist label (macOS only)
      if (process.platform === 'darwin') {
        try {
          const oldPlist = path.join(homeDir, 'Library', 'LaunchAgents', 'com.claude-sop.learner.plist');
          const newPlist = path.join(homeDir, 'Library', 'LaunchAgents', 'com.auto-sop.learner.plist');
          const oldPlistExists = await fileExists(oldPlist);
          if (oldPlistExists) {
            if (dryRun) {
              steps.push({
                step: 'launchd-plist',
                outcome: 'ok',
                detail: `would unload old plist and reinstall. Run 'auto-sop install' after migrate.`,
              });
            } else {
              // Unload old plist
              const { execa } = await import('execa');
              const uid = process.getuid?.() ?? 501;
              await execa('launchctl', ['bootout', `gui/${uid}/com.claude-sop.learner`], { reject: false });
              await fs.rm(oldPlist, { force: true });
              steps.push({
                step: 'launchd-plist',
                outcome: 'ok',
                detail: `removed old plist. Run 'auto-sop install' to set up new scheduler.`,
              });
            }
          } else {
            steps.push({ step: 'launchd-plist', outcome: 'skipped', detail: 'no old plist found' });
          }
        } catch (e) {
          steps.push({
            step: 'launchd-plist',
            outcome: 'warning',
            detail: `failed: ${(e as Error).message}`,
          });
        }
      }

      // Step 3: Update project .claude/settings.json hook paths
      try {
        const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
        const settingsExists = await fileExists(settingsPath);
        if (settingsExists) {
          const raw = await fs.readFile(settingsPath, 'utf8');
          if (raw.includes('claude-sop')) {
            const updated = raw
              .replace(/\.claude-sop/g, '.auto-sop')
              .replace(/claude-sop/g, 'auto-sop');
            if (dryRun) {
              steps.push({
                step: 'project-hooks',
                outcome: 'ok',
                detail: `would update ${settingsPath} (claude-sop → auto-sop)`,
              });
            } else {
              await fs.writeFile(settingsPath, updated, 'utf8');
              steps.push({
                step: 'project-hooks',
                outcome: 'ok',
                detail: `updated ${settingsPath}`,
              });
            }
          } else {
            steps.push({ step: 'project-hooks', outcome: 'skipped', detail: 'no claude-sop references found' });
          }
        } else {
          steps.push({ step: 'project-hooks', outcome: 'skipped', detail: 'no .claude/settings.json' });
        }
      } catch (e) {
        steps.push({
          step: 'project-hooks',
          outcome: 'warning',
          detail: `failed: ${(e as Error).message}`,
        });
      }

      // Step 4: Update .gitignore entry
      try {
        const gitignorePath = path.join(projectRoot, '.gitignore');
        const gitignoreExists = await fileExists(gitignorePath);
        if (gitignoreExists) {
          const raw = await fs.readFile(gitignorePath, 'utf8');
          if (raw.includes('.claude-sop/')) {
            const updated = raw.replace(/\.claude-sop\//g, '.auto-sop/');
            if (dryRun) {
              steps.push({ step: 'gitignore', outcome: 'ok', detail: 'would update .gitignore entry' });
            } else {
              await fs.writeFile(gitignorePath, updated, 'utf8');
              steps.push({ step: 'gitignore', outcome: 'ok', detail: 'updated .gitignore entry' });
            }
          } else {
            steps.push({ step: 'gitignore', outcome: 'skipped', detail: 'no .claude-sop/ entry found' });
          }
        } else {
          steps.push({ step: 'gitignore', outcome: 'skipped', detail: 'no .gitignore' });
        }
      } catch (e) {
        steps.push({
          step: 'gitignore',
          outcome: 'warning',
          detail: `failed: ${(e as Error).message}`,
        });
      }

      // Step 5: Move project .claude-sop/ → .auto-sop/
      try {
        const oldProjectDir = path.join(projectRoot, '.claude-sop');
        const newProjectDir = path.join(projectRoot, '.auto-sop');
        const oldProjectExists = await dirExists(oldProjectDir);
        const newProjectExists = await dirExists(newProjectDir);
        if (oldProjectExists && !newProjectExists) {
          if (dryRun) {
            steps.push({ step: 'move-project-dir', outcome: 'ok', detail: `would move ${oldProjectDir} → ${newProjectDir}` });
          } else {
            await fs.rename(oldProjectDir, newProjectDir);
            steps.push({ step: 'move-project-dir', outcome: 'ok', detail: `moved project dir` });
          }
        } else if (oldProjectExists && newProjectExists) {
          steps.push({
            step: 'move-project-dir',
            outcome: 'warning',
            detail: 'both old and new project dirs exist — merge manually',
          });
        } else {
          steps.push({ step: 'move-project-dir', outcome: 'skipped', detail: 'no old project dir' });
        }
      } catch (e) {
        steps.push({
          step: 'move-project-dir',
          outcome: 'warning',
          detail: `failed: ${(e as Error).message}`,
        });
      }

      // Output
      const warnings = steps.filter((s) => s.outcome === 'warning');
      if (jsonMode) {
        emit({ ok: warnings.length === 0, verb: 'migrate', dryRun, steps });
      } else {
        const prefix = dryRun ? pc.yellow('[dry-run] ') : '';
        process.stdout.write(prefix + pc.bold('auto-sop migrate') + '\n\n');
        for (const s of steps) {
          const icon =
            s.outcome === 'ok' ? pc.green('✓') :
            s.outcome === 'skipped' ? pc.dim('–') :
            pc.yellow('⚠');
          process.stdout.write(`  ${icon} ${s.step}: ${s.detail ?? s.outcome}\n`);
        }
        process.stdout.write('\n');
        if (warnings.length > 0) {
          process.stdout.write(pc.yellow(`${warnings.length} warning(s) — review above.\n`));
        } else {
          process.stdout.write(
            pc.green('Migration complete.') +
            (dryRun ? '' : ` Run ${pc.bold('auto-sop install')} to finalize.\n`),
          );
        }
      }
    });
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

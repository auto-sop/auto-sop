import path from 'node:path';
import { promises as fs } from 'node:fs';
import { statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { lock } from 'proper-lockfile';
import { assertPlatformSupported } from '../platform-check.js';
import { readInstalledVersion, writeInstalledVersion, compareVersions } from './version.js';
import { copyPluginBundle } from './plugin-bundle.js';
import { mergeGlobalMarketplace, mergeProjectHooks } from './merge-settings.js';
import { buildHookEntries } from './hook-entries.js';
import { writeTickScript } from '../scheduler/tick-wrapper.js';
import { pickBackend, type SchedulerBackend } from '../scheduler/index.js';
import { ensureGitignore } from './gitignore.js';
import { recordLicenseOnInstall } from '../license/storage.js';
import { getMachineId } from '../config/machine-id.js';
import { promptLicense, classifyLicense } from '../cli/prompt.js';
import { PreconditionError } from '../cli/errors.js';
import { upsertProject, readRegistry } from '../learner/project-registry.js';
import { createBindingFile, writeBindingFile } from '../license/binding.js';
import { validateLicense } from '../license/server-client.js';
import { computeCliHash } from '../license/self-hash.js';
import { resolveIdentity } from '../path-resolver/identity.js';
import { RealGitRunner } from '../path-resolver/git-runner.js';
import {
  loadActiveDirectives,
  setJustRestored,
  type DirectiveHistoryEntry,
} from '../managed-section/directive-history.js';
import { writeManagedSection } from '../managed-section/editor.js';

export interface InstallOptions {
  projectRoot: string;
  homeDir: string;
  licenseKey?: string | undefined;
  pluginBundleSrc: string;
  packageVersion: string;
  nodeBin: string;
  shimAbsPath: string;
  learnerAbsPath: string;
  /** Skip directive restoration from previous install (clean slate). */
  noRestore?: boolean | undefined;
  // Test hooks:
  promptLicense?: (() => Promise<string>) | undefined;
  schedulerBackend?: SchedulerBackend | undefined;
  now?: number | undefined;
  getMachineId?: (() => Promise<string>) | undefined;
}

export interface InstallResult {
  verdict: 'fresh' | 'upgrade' | 'same-version';
  installedVersion: string;
  warnings: string[];
  pluginBundleDst: string;
  scheduler: 'launchd' | 'systemd' | 'cron' | 'task-scheduler';
  gitignore: 'created' | 'appended' | 'noop';
  /** Number of directives restored from a previous install, or 0. */
  directivesRestored: number;
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const warnings: string[] = [];

  // Derived paths
  const claudeSopHome = path.join(opts.homeDir, '.auto-sop');
  const marketplaceDir = path.join(claudeSopHome, 'marketplace', 'auto-sop');
  const binDir = path.join(claudeSopHome, 'bin');
  const tickScriptPath = path.join(binDir, 'tick.sh');
  const versionTxtPath = path.join(claudeSopHome, 'version.txt');
  const secretsEncPath = path.join(claudeSopHome, 'secrets.enc');
  const logDir = path.join(claudeSopHome, 'logs');
  const globalClaudeSettings = path.join(opts.homeDir, '.claude', 'settings.json');
  const projectClaudeSettings = path.join(opts.projectRoot, '.claude', 'settings.json');
  const gitignorePath = path.join(opts.projectRoot, '.gitignore');
  const installLockPath = path.join(claudeSopHome, 'install.lock');

  // Step 0: Acquire install lock
  await fs.mkdir(claudeSopHome, { recursive: true });
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await lock(claudeSopHome, {
      lockfilePath: installLockPath,
      stale: 300_000, // 5 minutes
      retries: 0,
    });
  } catch {
    throw new PreconditionError('another install is in progress');
  }

  try {
    // Step 1: Preflight
    assertPlatformSupported();
    const nodeVersion = process.versions.node;
    const [major, minor] = nodeVersion.split('.').map(Number);
    if (major! < 18 || (major === 18 && minor! < 17)) {
      throw new PreconditionError(`Node >= 18.17 required, got ${nodeVersion}`);
    }
    const projectStat = await fs.stat(opts.projectRoot).catch(() => null);
    if (!projectStat?.isDirectory()) {
      throw new PreconditionError(`project root does not exist: ${opts.projectRoot}`);
    }

    // Step 2: Version compare
    const installed = await readInstalledVersion(versionTxtPath);
    const versionVerdict = compareVersions(installed, opts.packageVersion);
    if (versionVerdict === 'older-package') {
      throw new PreconditionError(
        'installed version newer than package version; refusing downgrade',
      );
    }
    let verdict: InstallResult['verdict'];
    if (versionVerdict === 'none') verdict = 'fresh';
    else if (versionVerdict === 'newer-package') verdict = 'upgrade';
    else verdict = 'same-version';

    // Step 3: License
    const licenseKey = opts.licenseKey ?? (await (opts.promptLicense ?? promptLicense)());
    const kind = classifyLicense(licenseKey);
    const machineIdFull = await (opts.getMachineId ?? getMachineId)();
    await recordLicenseOnInstall({
      secretsEncPath,
      licenseKey,
      kind,
      packageVersion: opts.packageVersion,
      machineIdFull,
      now: opts.now,
    });

    // Step 3b: Project binding — ties license to project + machine
    const projectAutoSopDir = path.join(opts.projectRoot, '.auto-sop');
    await fs.mkdir(projectAutoSopDir, { recursive: true });
    const binding = createBindingFile({
      licenseKey,
      projectPath: opts.projectRoot,
      machineId: machineIdFull,
    });
    await writeBindingFile(projectAutoSopDir, binding);

    // Step 3c: Server validation (fail-open for network errors)
    if (kind !== 'dev') {
      try {
        const registry = readRegistry(opts.homeDir);
        const boundProjects = registry.projects.map((p) => p.project_root);
        let cliHash: string | undefined;
        try {
          cliHash = computeCliHash();
        } catch {
          // fail-open
        }
        const result = await validateLicense({
          key: licenseKey,
          machineId: machineIdFull,
          boundProjects,
          cliHash,
          cliVersion: opts.packageVersion,
        });
        if (!result.success && result.error === 'invalid_key') {
          throw new PreconditionError(
            'Invalid license key. Get a free key at https://app.auto-sop.com/signup',
          );
        }
        if (!result.success && result.error === 'tampered_client') {
          throw new PreconditionError(
            'CLI integrity check failed. Please reinstall: npm install -g auto-sop',
          );
        }
        if (!result.success && result.error !== 'no_cache') {
          warnings.push(
            'Could not reach license server. Install will continue with 7-day offline grace period.',
          );
        }
      } catch (err) {
        if (err instanceof PreconditionError) throw err;
        warnings.push(
          'Could not reach license server. Install will continue with 7-day offline grace period.',
        );
      }
    }

    // Step 4: Plugin bundle copy
    await copyPluginBundle(opts.pluginBundleSrc, marketplaceDir);

    // Step 5: Register marketplace in global settings
    await fs.mkdir(path.dirname(globalClaudeSettings), { recursive: true });
    await mergeGlobalMarketplace(globalClaudeSettings, marketplaceDir);

    // Step 6: Project hooks
    await fs.mkdir(path.dirname(projectClaudeSettings), { recursive: true });
    const hookEntries = buildHookEntries(opts.shimAbsPath);
    await mergeProjectHooks(projectClaudeSettings, hookEntries);

    // Step 7: Scheduler
    let schedulerBackend: SchedulerBackend;
    let fallbackWarning: string | undefined;
    if (opts.schedulerBackend) {
      schedulerBackend = opts.schedulerBackend;
    } else {
      const picked = await pickBackend();
      schedulerBackend = picked.backend;
      fallbackWarning = picked.fallbackWarning;
    }
    await fs.mkdir(binDir, { recursive: true });
    const errorsLog = path.join(logDir, 'errors.log');
    const claudeBinDir = detectClaudeBinDir(opts.homeDir);
    await writeTickScript(tickScriptPath, {
      homeDir: opts.homeDir,
      nodeBin: opts.nodeBin,
      learnerJs: opts.learnerAbsPath,
      errorsLog,
      claudeBinDir,
    });
    await schedulerBackend.install({
      tickScriptPath,
      intervalSec: 3600,
      logDir,
      homeDir: opts.homeDir,
      user: process.env.USER ?? process.env.USERNAME ?? '',
    });
    if (fallbackWarning) warnings.push(fallbackWarning);

    // Step 8: Gitignore
    const gitignore = await ensureGitignore(gitignorePath, '.auto-sop/');

    // Step 8.5 (I9): Directive restoration. After a reinstall, restore
    // active directives from directive-history.json to the managed section
    // in CLAUDE.md so users don't lose their learned directives. The
    // learner's ManagedSectionEditor is the canonical writer — we use it
    // here too, which means the hash store, drift detection, and atomic
    // write guarantees all apply. The just_restored flag tells the next
    // learner tick to skip LLM analysis (the directives are already known).
    let directivesRestored = 0;
    if (!opts.noRestore) {
      try {
        const entries = loadActiveDirectives(opts.projectRoot);
        if (entries.length > 0) {
          const body = buildRestoredBody(entries);
          writeManagedSection({
            projectRoot: opts.projectRoot,
            content: body,
          });
          setJustRestored(opts.projectRoot);
          directivesRestored = entries.length;
        }
      } catch {
        // Directive restore is non-critical — fail-open. The learner will
        // eventually re-discover directives through normal analysis.
      }
    }

    // Step 9: Write version.txt LAST
    await writeInstalledVersion(versionTxtPath, opts.packageVersion);

    // Step 10: Register project in learner registry (fail-open)
    try {
      const git = new RealGitRunner();
      const identity = await resolveIdentity(opts.projectRoot, git);
      upsertProject(identity.projectId, identity.slug, opts.projectRoot, opts.homeDir);
    } catch {
      // fail-open: registry upsert is non-critical
    }

    return {
      verdict,
      installedVersion: opts.packageVersion,
      warnings,
      pluginBundleDst: marketplaceDir,
      scheduler: schedulerBackend.name,
      gitignore,
      directivesRestored,
    };
  } finally {
    if (releaseLock) {
      await releaseLock().catch(() => {
        // best-effort release
      });
    }
  }
}

/**
 * Detect the directory containing the `claude` binary.
 * Tries `which claude` first, then checks common install locations.
 * Returns undefined if detection fails — callers should fall back to
 * $HOME/.local/bin which is always prepended in the tick script PATH.
 */
export function detectClaudeBinDir(homeDir: string): string | undefined {
  // 1. Try `which claude` (works on POSIX and some Windows setups)
  try {
    const resolved = execSync('which claude', {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (resolved) return path.dirname(resolved);
  } catch {
    // which failed — try common paths
  }

  // 2. Check common install locations
  const candidates = [
    path.join(homeDir, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    path.join(homeDir, '.cargo', 'bin', 'claude'),
  ];

  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return path.dirname(candidate);
    } catch {
      // not found, try next
    }
  }

  // No common path found — return undefined, caller uses safe default
  return undefined;
}

/**
 * Build a managed section body from restored directive history entries.
 * Simpler than the full buildDirectiveBodyFromInput — no agent roster,
 * LLM summary, or turn statistics needed for a restore.
 */
function buildRestoredBody(entries: DirectiveHistoryEntry[]): { body: string } {
  const count = entries.length;
  const label = count === 1 ? 'directive' : 'directives';
  const header = `_Directives restored from previous install._\n`;
  const learnings = `**Learnings** (${count} active ${label})`;
  const bullets = entries.map((e) => `- **[${e.severity}]** ${e.rule_text}`).join('\n\n');
  return { body: `${header}\n${learnings}\n\n${bullets}` };
}

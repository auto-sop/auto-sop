import path from 'node:path';
import { promises as fs } from 'node:fs';
import { lock } from 'proper-lockfile';
import { assertPlatformSupported } from '../platform-check.js';
import {
  readInstalledVersion,
  writeInstalledVersion,
  compareVersions,
} from './version.js';
import { copyPluginBundle } from './plugin-bundle.js';
import { mergeGlobalMarketplace, mergeProjectHooks } from './merge-settings.js';
import { buildHookEntries } from './hook-entries.js';
import { writeTickScript } from '../scheduler/tick-wrapper.js';
import { pickBackend, type SchedulerBackend } from '../scheduler/index.js';
import { ensureManagedSection } from './managed-section.js';
import { ensureGitignore } from './gitignore.js';
import { recordLicenseOnInstall } from '../license/storage.js';
import { getMachineId } from '../config/machine-id.js';
import { promptLicense, classifyLicense } from '../cli/prompt.js';
import { PreconditionError } from '../cli/errors.js';
import { upsertProject } from '../learner/project-registry.js';
import { resolveIdentity } from '../path-resolver/identity.js';
import { RealGitRunner } from '../path-resolver/git-runner.js';

export interface InstallOptions {
  projectRoot: string;
  homeDir: string;
  licenseKey?: string | undefined;
  pluginBundleSrc: string;
  packageVersion: string;
  nodeBin: string;
  shimAbsPath: string;
  learnerAbsPath: string;
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
  scheduler: 'launchd' | 'systemd' | 'cron';
  managedSection: 'created' | 'appended' | 'noop';
  gitignore: 'created' | 'appended' | 'noop';
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const warnings: string[] = [];

  // Derived paths
  const claudeSopHome = path.join(opts.homeDir, '.claude-sop');
  const marketplaceDir = path.join(
    claudeSopHome,
    'marketplace',
    'claude-sop',
  );
  const binDir = path.join(claudeSopHome, 'bin');
  const tickScriptPath = path.join(binDir, 'tick.sh');
  const versionTxtPath = path.join(claudeSopHome, 'version.txt');
  const secretsEncPath = path.join(claudeSopHome, 'secrets.enc');
  const logDir = path.join(claudeSopHome, 'logs');
  const globalClaudeSettings = path.join(
    opts.homeDir,
    '.claude',
    'settings.json',
  );
  const projectClaudeSettings = path.join(
    opts.projectRoot,
    '.claude',
    'settings.json',
  );
  const claudeMdPath = path.join(opts.projectRoot, 'CLAUDE.md');
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
      throw new PreconditionError(
        `Node >= 18.17 required, got ${nodeVersion}`,
      );
    }
    const projectStat = await fs.stat(opts.projectRoot).catch(() => null);
    if (!projectStat?.isDirectory()) {
      throw new PreconditionError(
        `project root does not exist: ${opts.projectRoot}`,
      );
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
    const licenseKey =
      opts.licenseKey ??
      (await (opts.promptLicense ?? promptLicense)());
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
    await writeTickScript(tickScriptPath, {
      homeDir: opts.homeDir,
      nodeBin: opts.nodeBin,
      learnerJs: opts.learnerAbsPath,
      errorsLog,
    });
    await schedulerBackend.install({
      tickScriptPath,
      intervalSec: 3600,
      logDir,
      homeDir: opts.homeDir,
      user: process.env.USER ?? '',
    });
    if (fallbackWarning) warnings.push(fallbackWarning);

    // Step 8: Managed section + gitignore
    const managedSection = await ensureManagedSection(claudeMdPath);
    const gitignore = await ensureGitignore(gitignorePath, '.claude-sop/');

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
      managedSection,
      gitignore,
    };
  } finally {
    if (releaseLock) {
      await releaseLock().catch(() => {
        // best-effort release
      });
    }
  }
}

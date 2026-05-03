import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_BASE_URL } from '../config/environment.js';
import { readSecrets } from './storage.js';
import { readRegistry, type ProjectRegistryEntry } from '../learner/project-registry.js';
import { readBindingFile } from './binding.js';
import { validateLicense, type ValidateResult } from './server-client.js';
import { getMachineId } from '../config/machine-id.js';
import { classifyLicense } from '../cli/prompt.js';
import { computeCliHash } from './self-hash.js';

export interface EnforcementResult {
  allowed: boolean;
  reason?: string;
  plan?: string;
  maxProjects?: number;
  /** V56: Active project slugs from server (project toggles). */
  activeProjects?: string[] | undefined;
  /** License key from secrets — threaded to avoid re-reading secrets.enc */
  licenseKey?: string;
  /** Machine ID — threaded to avoid re-computing */
  machineId?: string;
}

export async function checkLicenseBeforeTick(home: string): Promise<EnforcementResult> {
  const secretsEncPath = join(home, '.auto-sop', 'secrets.enc');
  const secrets = await readSecrets(secretsEncPath);
  if (secrets === null) {
    return { allowed: true, plan: 'unknown' };
  }

  const licenseKey = secrets.license.key;
  if (classifyLicense(licenseKey) === 'dev') {
    return { allowed: true, plan: 'dev', licenseKey };
  }

  const registry = readRegistry(home);
  const boundProjects = registry.projects.map((p) => p.project_root);

  const bindingHashes: string[] = [];
  for (const project of registry.projects) {
    const binding = await readBindingFile(join(project.project_root, '.auto-sop'));
    if (binding !== null) {
      bindingHashes.push(binding.token);
    }
  }

  const machineId = await getMachineId();

  // BIND-7: compute CLI hash and version for tamper detection
  let cliHash: string | undefined;
  let cliVersion: string | undefined;
  try {
    cliHash = computeCliHash();
  } catch {
    // fail-open: hash computation is non-critical
  }
  try {
    const here =
      typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    cliVersion = pkg.version;
  } catch {
    // fail-open: version read is non-critical
  }

  let result: ValidateResult;
  try {
    result = await validateLicense({
      key: licenseKey,
      machineId,
      boundProjects,
      bindingHashes,
      cliHash,
      cliVersion,
    });
  } catch {
    return { allowed: true, plan: 'unknown', licenseKey, machineId };
  }

  if (!result.success) {
    if (result.error === 'grace_expired') {
      return {
        allowed: false,
        reason: 'License validation grace period expired. Please check your internet connection.',
      };
    }
    if (result.error === 'invalid_key') {
      return {
        allowed: false,
        reason: 'Invalid license key. Update with: auto-sop install',
      };
    }
    if (result.error === 'tampered_client') {
      return {
        allowed: false,
        reason:
          result.message ?? 'CLI integrity check failed. Please reinstall: npm install -g auto-sop',
      };
    }
    return { allowed: true, plan: 'unknown', licenseKey, machineId };
  }

  const payload = result.payload;
  const valid = payload?.['valid'] as boolean | undefined;
  const plan = (payload?.['plan'] as string) ?? 'free';
  const maxProjects = (payload?.['max_projects'] as number) ?? 1;
  const activeProjects = result.active_projects;

  if (valid === false) {
    return {
      allowed: false,
      reason: `Project limit exceeded. Your ${plan} plan allows ${maxProjects} project(s). Upgrade at ${APP_BASE_URL}/upgrade`,
      plan,
      maxProjects,
    };
  }

  return { allowed: true, plan, maxProjects, activeProjects, licenseKey, machineId };
}

export function shouldProjectRun(projectIndex: number, maxProjects: number): boolean {
  return projectIndex < maxProjects;
}

/**
 * V56: Determine if a project should run based on active_projects list
 * from the server (project toggles). Falls back to index-based quota
 * when active_projects is empty or undefined (backward compat with
 * older servers or failed fetches).
 */
export function isProjectActive(
  slug: string,
  activeProjects: string[] | undefined,
  index: number,
  maxProjects: number,
): boolean {
  if (activeProjects && activeProjects.length > 0) {
    return activeProjects.includes(slug);
  }
  return index < maxProjects;
}

export function sortProjectsByAge(projects: ProjectRegistryEntry[]): ProjectRegistryEntry[] {
  return [...projects].sort((a, b) => {
    const aTime = new Date(a.installed_at).getTime();
    const bTime = new Date(b.installed_at).getTime();
    return aTime - bTime;
  });
}

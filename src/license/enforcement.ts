import { join } from 'node:path';
import { readSecrets } from './storage.js';
import { readRegistry, type ProjectRegistryEntry } from '../learner/project-registry.js';
import { readBindingFile, type BindingFile } from './binding.js';
import { validateLicense, type ValidateResult } from './server-client.js';
import { getMachineId } from '../config/machine-id.js';
import { classifyLicense } from '../cli/prompt.js';

export interface EnforcementResult {
  allowed: boolean;
  reason?: string;
  plan?: string;
  maxProjects?: number;
}

export async function checkLicenseBeforeTick(home: string): Promise<EnforcementResult> {
  const secretsEncPath = join(home, '.auto-sop', 'secrets.enc');
  const secrets = await readSecrets(secretsEncPath);
  if (secrets === null) {
    return { allowed: true, plan: 'unknown' };
  }

  const licenseKey = secrets.license.key;
  if (classifyLicense(licenseKey) === 'dev') {
    return { allowed: true, plan: 'dev' };
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

  let result: ValidateResult;
  try {
    result = await validateLicense({
      key: licenseKey,
      machineId,
      boundProjects,
      bindingHashes,
    });
  } catch {
    return { allowed: true, plan: 'unknown' };
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
    return { allowed: true, plan: 'unknown' };
  }

  const payload = result.payload;
  const valid = payload?.['valid'] as boolean | undefined;
  const plan = (payload?.['plan'] as string) ?? 'free';
  const maxProjects = (payload?.['max_projects'] as number) ?? 1;

  if (valid === false) {
    return {
      allowed: false,
      reason: `Project limit exceeded. Your ${plan} plan allows ${maxProjects} project(s). Upgrade at https://app.auto-sop.com/upgrade`,
      plan,
      maxProjects,
    };
  }

  return { allowed: true, plan, maxProjects };
}

export function shouldProjectRun(projectIndex: number, maxProjects: number): boolean {
  return projectIndex < maxProjects;
}

export function sortProjectsByAge(
  projects: ProjectRegistryEntry[],
): ProjectRegistryEntry[] {
  return [...projects].sort((a, b) => {
    const aTime = new Date(a.installed_at).getTime();
    const bTime = new Date(b.installed_at).getTime();
    return aTime - bTime;
  });
}

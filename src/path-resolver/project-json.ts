import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ProjectIdentity, ProjectJsonV1 } from './types.js';

export async function readProjectJson(projectClaudeSopDir: string): Promise<ProjectJsonV1 | null> {
  try {
    const raw = await fs.readFile(join(projectClaudeSopDir, 'project.json'), 'utf8');
    const parsed = JSON.parse(raw) as ProjectJsonV1;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeProjectJsonAtomic(
  projectClaudeSopDir: string,
  identity: ProjectIdentity,
): Promise<void> {
  await fs.mkdir(projectClaudeSopDir, { recursive: true });
  const final = join(projectClaudeSopDir, 'project.json');
  const tmp = `${final}.tmp.${process.pid}.${Date.now()}`;
  const data: ProjectJsonV1 = {
    version: 1,
    projectId: identity.projectId,
    slug: identity.slug,
    source: identity.source,
    remoteUrl: identity.remoteUrl,
    toplevel: identity.toplevel,
    cwd: identity.cwd,
    createdAt: Date.now(),
  };
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, final);
}

export interface MoveDetection {
  moved: boolean;
  previousProjectId?: string;
  currentProjectId: string;
}

export function detectMove(stored: ProjectJsonV1 | null, current: ProjectIdentity): MoveDetection {
  if (!stored) return { moved: false, currentProjectId: current.projectId };
  if (stored.projectId !== current.projectId) {
    return {
      moved: true,
      previousProjectId: stored.projectId,
      currentProjectId: current.projectId,
    };
  }
  return { moved: false, currentProjectId: current.projectId };
}

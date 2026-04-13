import { resolveIdentity } from './identity.js';
import { RealGitRunner, type GitRunner } from './git-runner.js';
import { readProjectJson, writeProjectJsonAtomic, detectMove } from './project-json.js';
import { join } from 'node:path';
import type { ProjectIdentity } from './types.js';

export class PathResolver {
  constructor(private readonly git: GitRunner = new RealGitRunner()) {}

  async resolve(cwd: string) {
    const identity = await resolveIdentity(cwd, this.git);
    const projectClaudeSopDir = join(cwd, '.claude-sop');
    const stored = await readProjectJson(projectClaudeSopDir);
    const move = detectMove(stored, identity);
    return { identity, projectClaudeSopDir, stored, move };
  }

  async writeAnchor(cwd: string, identity: ProjectIdentity) {
    await writeProjectJsonAtomic(join(cwd, '.claude-sop'), identity);
  }
}

export type { ProjectIdentity, ProjectJsonV1, IdentitySource } from './types.js';
export type { MoveDetection } from './project-json.js';
export { normalizeRemoteUrl } from './normalize-remote-url.js';
export { RealGitRunner, type GitRunner } from './git-runner.js';
export { resolveIdentity } from './identity.js';
export { readProjectJson, writeProjectJsonAtomic, detectMove } from './project-json.js';

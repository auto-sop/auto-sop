import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { GitRunner } from './git-runner.js';
import { normalizeRemoteUrl } from './normalize-remote-url.js';
import type { ProjectIdentity } from './types.js';

function sha12(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

export async function resolveIdentity(cwd: string, git: GitRunner): Promise<ProjectIdentity> {
  // Tier 1: git remote origin → normalize → sha256[:12]
  const rawRemote = await git.remoteOriginUrl(cwd);
  if (rawRemote) {
    const remoteUrl = normalizeRemoteUrl(rawRemote);
    const toplevel = (await git.toplevel(cwd)) ?? cwd;
    return {
      projectId: sha12(remoteUrl),
      slug: basename(toplevel),
      source: 'git-remote',
      remoteUrl,
      toplevel,
      cwd,
    };
  }

  // Tier 2: git toplevel path → sha256[:12]
  const toplevel = await git.toplevel(cwd);
  if (toplevel) {
    return {
      projectId: sha12(toplevel),
      slug: basename(toplevel),
      source: 'git-toplevel',
      toplevel,
      cwd,
    };
  }

  // Tier 3: cwd → sha256[:12]
  return {
    projectId: sha12(cwd),
    slug: basename(cwd),
    source: 'cwd',
    cwd,
  };
}

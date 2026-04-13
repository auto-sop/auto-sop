export type IdentitySource = 'git-remote' | 'git-toplevel' | 'cwd';

export interface ProjectIdentity {
  projectId: string; // 12 hex chars
  slug: string; // human-readable
  source: IdentitySource;
  remoteUrl?: string; // normalized canonical form
  toplevel?: string; // absolute path from git rev-parse --show-toplevel
  cwd: string; // absolute path
}

export interface ProjectJsonV1 {
  version: 1;
  projectId: string;
  slug: string;
  source: IdentitySource;
  remoteUrl?: string | undefined;
  toplevel?: string | undefined;
  cwd: string;
  createdAt: number; // unix ms
}

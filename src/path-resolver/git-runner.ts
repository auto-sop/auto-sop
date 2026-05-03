import { execa } from 'execa';

/**
 * Abstraction over git CLI calls. Enables dependency injection for tests.
 * Methods NEVER throw — non-git projects, missing binaries, and permission
 * errors all return null so PathResolver can fall through the identity hierarchy.
 */
export interface GitRunner {
  remoteOriginUrl(cwd: string): Promise<string | null>;
  toplevel(cwd: string): Promise<string | null>;
}

export class RealGitRunner implements GitRunner {
  async remoteOriginUrl(cwd: string): Promise<string | null> {
    try {
      const result = await execa('git', ['remote', 'get-url', 'origin'], {
        cwd,
        reject: false,
      });
      if (result.exitCode !== 0) return null;
      return result.stdout.trim() || null;
    } catch {
      return null; // git not installed (ENOENT) or other failure
    }
  }

  async toplevel(cwd: string): Promise<string | null> {
    try {
      const result = await execa('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        reject: false,
      });
      if (result.exitCode !== 0) return null;
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }
}

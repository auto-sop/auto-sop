import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { GitRunner } from '../../src/path-resolver/git-runner.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

/** Fake GitRunner for dependency injection tests. */
class FakeGitRunner implements GitRunner {
  constructor(
    private remoteUrl: string | null = null,
    private topDir: string | null = null,
  ) {}

  async remoteOriginUrl(_cwd: string): Promise<string | null> {
    return this.remoteUrl;
  }

  async toplevel(_cwd: string): Promise<string | null> {
    return this.topDir;
  }
}

describe('FakeGitRunner (interface contract)', () => {
  it('returns configured remote URL', async () => {
    const runner = new FakeGitRunner('git@github.com:foo/bar.git', '/repo');
    expect(await runner.remoteOriginUrl('/any')).toBe('git@github.com:foo/bar.git');
  });

  it('returns configured toplevel', async () => {
    const runner = new FakeGitRunner(null, '/home/user/project');
    expect(await runner.toplevel('/any')).toBe('/home/user/project');
  });

  it('returns null for remote when not configured', async () => {
    const runner = new FakeGitRunner();
    expect(await runner.remoteOriginUrl('/any')).toBeNull();
  });

  it('returns null for toplevel when not configured', async () => {
    const runner = new FakeGitRunner();
    expect(await runner.toplevel('/any')).toBeNull();
  });
});

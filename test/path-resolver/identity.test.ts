import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { resolveIdentity } from '../../src/path-resolver/identity.js';
import type { GitRunner } from '../../src/path-resolver/git-runner.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

function sha12(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

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

describe('resolveIdentity', () => {
  it('tier 1: uses git remote when available', async () => {
    const git = new FakeGitRunner('git@github.com:acme/widget.git', '/home/user/widget');
    const id = await resolveIdentity('/home/user/widget', git);

    expect(id.source).toBe('git-remote');
    expect(id.remoteUrl).toBe('https://github.com/acme/widget');
    expect(id.projectId).toBe(sha12('https://github.com/acme/widget'));
    expect(id.projectId).toHaveLength(12);
    expect(id.toplevel).toBe('/home/user/widget');
    expect(id.cwd).toBe('/home/user/widget');
  });

  it('tier 2: falls back to git toplevel when remote is null', async () => {
    const git = new FakeGitRunner(null, '/home/user/local-repo');
    const id = await resolveIdentity('/home/user/local-repo', git);

    expect(id.source).toBe('git-toplevel');
    expect(id.projectId).toBe(sha12('/home/user/local-repo'));
    expect(id.projectId).toHaveLength(12);
    expect(id.toplevel).toBe('/home/user/local-repo');
    expect(id.remoteUrl).toBeUndefined();
  });

  it('tier 3: falls back to cwd when both git calls return null', async () => {
    const git = new FakeGitRunner(null, null);
    const id = await resolveIdentity('/tmp/plain-dir', git);

    expect(id.source).toBe('cwd');
    expect(id.projectId).toBe(sha12('/tmp/plain-dir'));
    expect(id.projectId).toHaveLength(12);
    expect(id.toplevel).toBeUndefined();
    expect(id.remoteUrl).toBeUndefined();
  });

  it('produces identical projectId for different URL formats of the same repo', async () => {
    const gitScp = new FakeGitRunner('git@github.com:foo/bar.git', '/repo');
    const gitHttps = new FakeGitRunner('https://github.com/foo/bar', '/repo');
    const gitUppercase = new FakeGitRunner('https://github.com/FOO/BAR.git', '/repo');

    const idScp = await resolveIdentity('/repo', gitScp);
    const idHttps = await resolveIdentity('/repo', gitHttps);
    const idUpper = await resolveIdentity('/repo', gitUppercase);

    expect(idScp.projectId).toBe(idHttps.projectId);
    expect(idScp.projectId).toBe(idUpper.projectId);
    // All should normalize to same URL
    expect(idScp.remoteUrl).toBe('https://github.com/foo/bar');
    expect(idHttps.remoteUrl).toBe('https://github.com/foo/bar');
    expect(idUpper.remoteUrl).toBe('https://github.com/foo/bar');
  });

  it('derives slug from basename of toplevel (with git)', async () => {
    const git = new FakeGitRunner('git@github.com:org/my-project.git', '/home/dev/my-project');
    const id = await resolveIdentity('/home/dev/my-project/sub', git);
    expect(id.slug).toBe('my-project');
  });

  it('derives slug from basename of cwd (without git)', async () => {
    const git = new FakeGitRunner(null, null);
    const id = await resolveIdentity('/tmp/some-folder', git);
    expect(id.slug).toBe('some-folder');
  });

  it('uses cwd as toplevel fallback when remote exists but toplevel is null', async () => {
    const git = new FakeGitRunner('git@github.com:x/y.git', null);
    const id = await resolveIdentity('/work/y', git);

    expect(id.source).toBe('git-remote');
    // toplevel falls back to cwd
    expect(id.toplevel).toBe('/work/y');
    expect(id.slug).toBe('y');
  });
});

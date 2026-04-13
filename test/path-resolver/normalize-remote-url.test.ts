import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeRemoteUrl } from '../../src/path-resolver/normalize-remote-url.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

describe('normalizeRemoteUrl', () => {
  const EXPECTED = 'https://github.com/owner/repo';

  it('normalizes https with .git suffix', () => {
    expect(normalizeRemoteUrl('https://github.com/owner/repo.git')).toBe(EXPECTED);
  });

  it('normalizes https without .git suffix', () => {
    expect(normalizeRemoteUrl('https://github.com/owner/repo')).toBe(EXPECTED);
  });

  it('normalizes SCP-style git@host:path.git', () => {
    expect(normalizeRemoteUrl('git@github.com:owner/repo.git')).toBe(EXPECTED);
  });

  it('normalizes ssh:// URL', () => {
    expect(normalizeRemoteUrl('ssh://git@github.com/owner/repo.git')).toBe(EXPECTED);
  });

  it('normalizes git+ssh:// URL', () => {
    expect(normalizeRemoteUrl('git+ssh://git@github.com/owner/repo.git')).toBe(EXPECTED);
  });

  it('normalizes git:// protocol URL', () => {
    expect(normalizeRemoteUrl('git://github.com/owner/repo.git')).toBe(EXPECTED);
  });

  it('lowercases host and path for determinism', () => {
    expect(normalizeRemoteUrl('https://GitHub.COM/OWNER/REPO.git')).toBe(EXPECTED);
  });

  it('handles uppercase SCP-style URL', () => {
    expect(normalizeRemoteUrl('git@GitHub.COM:Owner/Repo.git')).toBe(EXPECTED);
  });

  it('strips whitespace around the URL', () => {
    expect(normalizeRemoteUrl('  https://github.com/owner/repo.git  ')).toBe(EXPECTED);
  });

  it('handles GitLab URLs the same way', () => {
    expect(normalizeRemoteUrl('git@gitlab.com:team/project.git')).toBe(
      'https://gitlab.com/team/project',
    );
  });

  it('throws on malformed URL', () => {
    expect(() => normalizeRemoteUrl('not-a-url')).toThrow();
  });
});

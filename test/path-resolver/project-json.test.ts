import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { isWindows } from '../setup/platform.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  readProjectJson,
  writeProjectJsonAtomic,
  detectMove,
} from '../../src/path-resolver/project-json.js';
import type { ProjectIdentity, ProjectJsonV1 } from '../../src/path-resolver/types.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

describe('project-json', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'path-resolver-test-'));
  });

  const sampleIdentity: ProjectIdentity = {
    projectId: 'abcdef012345',
    slug: 'my-project',
    source: 'git-remote',
    remoteUrl: 'https://github.com/owner/repo',
    toplevel: '/home/user/repo',
    cwd: '/home/user/repo',
  };

  describe('writeProjectJsonAtomic', () => {
    it('creates directory and file', async () => {
      const dir = join(testDir, '.auto-sop');
      await writeProjectJsonAtomic(dir, sampleIdentity);

      const raw = await fs.readFile(join(dir, 'project.json'), 'utf8');
      const parsed = JSON.parse(raw) as ProjectJsonV1;
      expect(parsed.version).toBe(1);
      expect(parsed.projectId).toBe('abcdef012345');
      expect(parsed.slug).toBe('my-project');
      expect(parsed.source).toBe('git-remote');
      expect(parsed.remoteUrl).toBe('https://github.com/owner/repo');
      expect(parsed.createdAt).toBeGreaterThan(0);
    });

    it('writes file with mode 0600', async () => {
      if (isWindows) return;
      const dir = join(testDir, '.auto-sop');
      await writeProjectJsonAtomic(dir, sampleIdentity);

      const stat = await fs.stat(join(dir, 'project.json'));
      // 0o600 = owner read+write only
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('does not leave a .tmp file behind on success', async () => {
      const dir = join(testDir, '.auto-sop');
      await writeProjectJsonAtomic(dir, sampleIdentity);

      const files = await fs.readdir(dir);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('readProjectJson', () => {
    it('returns null on ENOENT (missing file)', async () => {
      const result = await readProjectJson(join(testDir, 'nonexistent'));
      expect(result).toBeNull();
    });

    it('returns parsed v1 object', async () => {
      const dir = join(testDir, '.auto-sop');
      await writeProjectJsonAtomic(dir, sampleIdentity);

      const result = await readProjectJson(dir);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
      expect(result!.projectId).toBe('abcdef012345');
    });

    it('returns null when version != 1 (forward-compat)', async () => {
      const dir = join(testDir, '.auto-sop');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, 'project.json'), JSON.stringify({ version: 2, projectId: 'x' }));

      const result = await readProjectJson(dir);
      expect(result).toBeNull();
    });
  });

  describe('detectMove', () => {
    it('returns moved=false when stored is null', () => {
      const result = detectMove(null, sampleIdentity);
      expect(result.moved).toBe(false);
      expect(result.currentProjectId).toBe('abcdef012345');
      expect(result.previousProjectId).toBeUndefined();
    });

    it('returns moved=false when projectIds match', () => {
      const stored: ProjectJsonV1 = {
        version: 1,
        projectId: 'abcdef012345',
        slug: 'my-project',
        source: 'git-remote',
        cwd: '/home/user/repo',
        createdAt: Date.now(),
      };
      const result = detectMove(stored, sampleIdentity);
      expect(result.moved).toBe(false);
      expect(result.currentProjectId).toBe('abcdef012345');
    });

    it('returns moved=true with previousProjectId when ids differ', () => {
      const stored: ProjectJsonV1 = {
        version: 1,
        projectId: 'oldoldoldold',
        slug: 'old-project',
        source: 'git-remote',
        cwd: '/old/path',
        createdAt: Date.now(),
      };
      const result = detectMove(stored, sampleIdentity);
      expect(result.moved).toBe(true);
      expect(result.previousProjectId).toBe('oldoldoldold');
      expect(result.currentProjectId).toBe('abcdef012345');
    });
  });
});

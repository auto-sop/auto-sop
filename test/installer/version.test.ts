import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import {
  readInstalledVersion,
  writeInstalledVersion,
  compareVersions,
} from '../../src/installer/version.js';

describe('version', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `version-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('readInstalledVersion', () => {
    it('returns null for nonexistent file', async () => {
      const result = await readInstalledVersion(
        join(testDir, 'version.txt'),
      );
      expect(result).toBeNull();
    });

    it('round-trips write then read', async () => {
      const vPath = join(testDir, 'version.txt');
      await writeInstalledVersion(vPath, '1.2.3');
      const result = await readInstalledVersion(vPath);
      expect(result).toBe('1.2.3');
    });

    it('trims whitespace around valid semver', async () => {
      const vPath = join(testDir, 'version.txt');
      await fs.writeFile(vPath, '  1.0.0  \n');
      const result = await readInstalledVersion(vPath);
      expect(result).toBe('1.0.0');
    });

    it('returns null for invalid semver content', async () => {
      const vPath = join(testDir, 'version.txt');
      await fs.writeFile(vPath, 'not-semver\n');
      const result = await readInstalledVersion(vPath);
      expect(result).toBeNull();
    });
  });

  describe('writeInstalledVersion', () => {
    it('throws for invalid semver', async () => {
      await expect(
        writeInstalledVersion(join(testDir, 'v.txt'), 'nope'),
      ).rejects.toThrow('invalid semver');
    });
  });

  describe('compareVersions', () => {
    it('returns none when installed is null', () => {
      expect(compareVersions(null, '1.0.0')).toBe('none');
    });

    it('returns same for equal versions', () => {
      expect(compareVersions('1.0.0', '1.0.0')).toBe('same');
    });

    it('returns newer-package when current > installed', () => {
      expect(compareVersions('1.0.0', '1.0.1')).toBe('newer-package');
    });

    it('returns older-package when current < installed', () => {
      expect(compareVersions('1.1.0', '1.0.0')).toBe('older-package');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { copyPluginBundle } from '../../src/installer/plugin-bundle.js';

describe('copyPluginBundle', () => {
  let testDir: string;
  let srcDir: string;
  let dstDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `plugin-bundle-test-${nanoid(10)}`);
    srcDir = join(testDir, 'src-bundle');
    dstDir = join(testDir, 'dst-bundle');
    await fs.mkdir(srcDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('copies src dir tree to dst recursively', async () => {
    // Create nested structure
    await fs.mkdir(join(srcDir, 'sub'), { recursive: true });
    await fs.writeFile(join(srcDir, 'root.txt'), 'root-content');
    await fs.writeFile(join(srcDir, 'sub', 'nested.txt'), 'nested-content');

    await copyPluginBundle(srcDir, dstDir);

    const rootContent = await fs.readFile(join(dstDir, 'root.txt'), 'utf8');
    expect(rootContent).toBe('root-content');
    const nestedContent = await fs.readFile(join(dstDir, 'sub', 'nested.txt'), 'utf8');
    expect(nestedContent).toBe('nested-content');
  });

  it('destructive: stale content in dst is removed after copy', async () => {
    // Seed stale dst
    await fs.mkdir(dstDir, { recursive: true });
    await fs.writeFile(join(dstDir, 'stale.txt'), 'old-data');

    // Src has different content
    await fs.writeFile(join(srcDir, 'new.txt'), 'new-data');

    await copyPluginBundle(srcDir, dstDir);

    // Stale content gone
    await expect(fs.access(join(dstDir, 'stale.txt'))).rejects.toThrow();
    // New content present
    const newContent = await fs.readFile(join(dstDir, 'new.txt'), 'utf8');
    expect(newContent).toBe('new-data');
  });

  it('throws if src does not exist', async () => {
    const missing = join(testDir, 'no-such-dir');
    await expect(copyPluginBundle(missing, dstDir)).rejects.toThrow(/does not exist/);
  });

  it('throws if src is a file not a directory', async () => {
    const filePath = join(testDir, 'a-file');
    await fs.writeFile(filePath, 'content');
    await expect(copyPluginBundle(filePath, dstDir)).rejects.toThrow(/not a directory/);
  });
});

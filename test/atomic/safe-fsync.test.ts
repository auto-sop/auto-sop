import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { fsyncFile, fsyncFileAsync, IS_WINDOWS } from '../../src/atomic/safe-fsync.js';

describe('fsyncFile (sync)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `safe-fsync-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('fsyncs a valid file without error', async () => {
    const target = join(testDir, 'valid.txt');
    await fs.writeFile(target, 'content');
    expect(() => fsyncFile(target)).not.toThrow();
  });

  it('throws for a non-existent file', () => {
    const missing = join(testDir, 'no-such-file.txt');
    expect(() => fsyncFile(missing)).toThrow();
  });

  it('preserves file content after fsync', async () => {
    const target = join(testDir, 'preserve.txt');
    const content = 'data-to-preserve';
    await fs.writeFile(target, content);
    fsyncFile(target);
    const result = await fs.readFile(target, 'utf8');
    expect(result).toBe(content);
  });

  it('works on a file written with restrictive mode', async () => {
    const target = join(testDir, 'restricted.txt');
    await fs.writeFile(target, 'secret', { mode: 0o600 });
    // On all platforms: either fsync succeeds, or EPERM is swallowed on Windows
    expect(() => fsyncFile(target)).not.toThrow();
  });
});

describe('fsyncFileAsync', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `safe-fsync-async-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('fsyncs a valid file without error', async () => {
    const target = join(testDir, 'valid-async.txt');
    await fs.writeFile(target, 'async content');
    await expect(fsyncFileAsync(target)).resolves.toBeUndefined();
  });

  it('throws for a non-existent file', async () => {
    const missing = join(testDir, 'no-such-async.txt');
    await expect(fsyncFileAsync(missing)).rejects.toThrow();
  });

  it('preserves file content after async fsync', async () => {
    const target = join(testDir, 'preserve-async.txt');
    const content = 'async-data-to-preserve';
    await fs.writeFile(target, content);
    await fsyncFileAsync(target);
    const result = await fs.readFile(target, 'utf8');
    expect(result).toBe(content);
  });

  it('works on a file written with restrictive mode', async () => {
    const target = join(testDir, 'restricted-async.txt');
    await fs.writeFile(target, 'secret', { mode: 0o600 });
    // On all platforms: either succeeds or EPERM is swallowed on Windows
    await expect(fsyncFileAsync(target)).resolves.toBeUndefined();
  });
});

describe('IS_WINDOWS export', () => {
  it('matches process.platform check', () => {
    expect(IS_WINDOWS).toBe(process.platform === 'win32');
  });
});

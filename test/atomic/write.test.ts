import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { writeFileAtomic } from '../../src/atomic/write.js';
import { isWindows } from '../setup/platform.js';

describe('writeFileAtomic', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `atomic-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('writes content and reads it back', async () => {
    const target = join(testDir, 'hello.txt');
    await writeFileAtomic(target, 'hello world');
    const result = await fs.readFile(target, 'utf8');
    expect(result).toBe('hello world');
  });

  it('creates parent directories that do not exist', async () => {
    const target = join(testDir, 'a', 'b', 'c', 'deep.txt');
    await writeFileAtomic(target, 'deep content');
    const result = await fs.readFile(target, 'utf8');
    expect(result).toBe('deep content');
  });

  it('overwrites existing file — second value wins, no tmp files left', async () => {
    const target = join(testDir, 'overwrite.txt');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');
    const result = await fs.readFile(target, 'utf8');
    expect(result).toBe('second');

    // No .tmp files left
    const files = await fs.readdir(testDir);
    const tmps = files.filter((f) => f.endsWith('.tmp'));
    expect(tmps).toHaveLength(0);
  });

  it('concurrent writes — final content is one of the inputs, no tmp files', async () => {
    const target = join(testDir, 'concurrent.txt');
    const values = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    await Promise.all(values.map((v) => writeFileAtomic(target, v)));
    const result = await fs.readFile(target, 'utf8');
    expect(values).toContain(result);

    const files = await fs.readdir(testDir);
    const tmps = files.filter((f) => f.endsWith('.tmp'));
    expect(tmps).toHaveLength(0);
  });

  it('round-trips large content (1 MiB)', async () => {
    const target = join(testDir, 'large.bin');
    const content = Buffer.alloc(1024 * 1024, 0x42); // 1 MiB of 'B'
    await writeFileAtomic(target, content);
    const result = await fs.readFile(target);
    expect(result.equals(content)).toBe(true);
  });

  it('sets file mode to 0o600', async () => {
    const target = join(testDir, 'mode.txt');
    await writeFileAtomic(target, 'secret');
    const stat = await fs.stat(target);
    if (!isWindows) {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});

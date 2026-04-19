import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { ensureGitignore } from '../../src/installer/gitignore.js';

describe('ensureGitignore', () => {
  let testDir: string;
  const entry = '.auto-sop/';

  beforeEach(async () => {
    testDir = join(tmpdir(), `gitignore-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('creates file when missing', async () => {
    const p = join(testDir, '.gitignore');
    const result = await ensureGitignore(p, entry);
    expect(result).toBe('created');
    const text = await fs.readFile(p, 'utf8');
    expect(text).toBe('.auto-sop/\n');
  });

  it('returns noop when entry already exists', async () => {
    const p = join(testDir, '.gitignore');
    await fs.writeFile(p, '.auto-sop/\n');
    const result = await ensureGitignore(p, entry);
    expect(result).toBe('noop');
    const text = await fs.readFile(p, 'utf8');
    expect(text).toBe('.auto-sop/\n');
  });

  it('appends to file with other entries', async () => {
    const p = join(testDir, '.gitignore');
    await fs.writeFile(p, 'node_modules\n');
    const result = await ensureGitignore(p, entry);
    expect(result).toBe('appended');
    const text = await fs.readFile(p, 'utf8');
    expect(text).toBe('node_modules\n.auto-sop/\n');
  });

  it('adds separator when file lacks trailing newline', async () => {
    const p = join(testDir, '.gitignore');
    await fs.writeFile(p, 'node_modules');
    const result = await ensureGitignore(p, entry);
    expect(result).toBe('appended');
    const text = await fs.readFile(p, 'utf8');
    expect(text).toBe('node_modules\n.auto-sop/\n');
  });

  it('.auto-sop/ is distinct from .auto-sop (no trailing slash)', async () => {
    const p = join(testDir, '.gitignore');
    await fs.writeFile(p, '.auto-sop\n');
    // .auto-sop (no slash) is present, but .auto-sop/ is not
    const result = await ensureGitignore(p, entry);
    expect(result).toBe('appended');
    const text = await fs.readFile(p, 'utf8');
    expect(text).toContain('.auto-sop\n');
    expect(text).toContain('.auto-sop/\n');
  });
});

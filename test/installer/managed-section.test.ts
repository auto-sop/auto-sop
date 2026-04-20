import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import {
  stripManagedSection,
  MANAGED_BEGIN,
  MANAGED_END,
} from '../../src/installer/managed-section.js';

describe('stripManagedSection (legacy marker cleanup for uninstall)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `strip-section-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('removes markers and content between them', async () => {
    const p = join(testDir, 'CLAUDE.md');
    const between = '\nsome managed content\n';
    await fs.writeFile(p, `before\n${MANAGED_BEGIN}${between}${MANAGED_END}\nafter\n`);
    const result = await stripManagedSection(p);
    expect(result.removed).toBe(between);
    const text = await fs.readFile(p, 'utf8');
    expect(text).not.toContain(MANAGED_BEGIN);
    expect(text).not.toContain(MANAGED_END);
    expect(text).toContain('before');
    expect(text).toContain('after');
  });

  it('returns null when file has no markers', async () => {
    const p = join(testDir, 'CLAUDE.md');
    await fs.writeFile(p, 'no markers here');
    const result = await stripManagedSection(p);
    expect(result.removed).toBeNull();
  });

  it('returns null for nonexistent file', async () => {
    const result = await stripManagedSection(join(testDir, 'missing.md'));
    expect(result.removed).toBeNull();
  });

  it('leaves file unchanged when only markers but no content exists (empty pre-v15 stub)', async () => {
    const p = join(testDir, 'CLAUDE.md');
    const original = `# My Rules\n\n${MANAGED_BEGIN}\n${MANAGED_END}\n`;
    await fs.writeFile(p, original);
    const { removed } = await stripManagedSection(p);
    expect(removed).toBe('\n');
    const text = await fs.readFile(p, 'utf8');
    expect(text).not.toContain(MANAGED_BEGIN);
    expect(text).not.toContain(MANAGED_END);
    expect(text).toContain('# My Rules');
  });
});

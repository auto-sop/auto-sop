import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import {
  ensureManagedSection,
  stripManagedSection,
  MANAGED_BEGIN,
  MANAGED_END,
} from '../../src/installer/managed-section.js';

describe('ensureManagedSection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `managed-section-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('creates file with markers when missing', async () => {
    const p = join(testDir, 'CLAUDE.md');
    const result = await ensureManagedSection(p);
    expect(result).toBe('created');
    const text = await fs.readFile(p, 'utf8');
    expect(text).toBe(`${MANAGED_BEGIN}\n${MANAGED_END}\n`);
  });

  it('appends markers to existing file without trailing newline', async () => {
    const p = join(testDir, 'CLAUDE.md');
    const original = '# My Rules';
    await fs.writeFile(p, original);
    const result = await ensureManagedSection(p);
    expect(result).toBe('appended');
    const text = await fs.readFile(p, 'utf8');
    // Original preserved byte-for-byte before markers
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain(MANAGED_BEGIN);
    expect(text).toContain(MANAGED_END);
  });

  it('returns noop when markers already exist', async () => {
    const p = join(testDir, 'CLAUDE.md');
    await fs.writeFile(p, `${MANAGED_BEGIN}\ncontent\n${MANAGED_END}\n`);
    const result = await ensureManagedSection(p);
    expect(result).toBe('noop');
  });

  it('is idempotent — second call is noop', async () => {
    const p = join(testDir, 'CLAUDE.md');
    await ensureManagedSection(p);
    const first = await fs.readFile(p, 'utf8');
    const result = await ensureManagedSection(p);
    expect(result).toBe('noop');
    const second = await fs.readFile(p, 'utf8');
    expect(second).toBe(first);
  });

  it('appends with double newline separator when file lacks trailing newline', async () => {
    const p = join(testDir, 'CLAUDE.md');
    await fs.writeFile(p, 'no trailing newline');
    await ensureManagedSection(p);
    const text = await fs.readFile(p, 'utf8');
    expect(text).toContain('no trailing newline\n\n' + MANAGED_BEGIN);
  });

  it('appends with single newline separator when file has trailing newline', async () => {
    const p = join(testDir, 'CLAUDE.md');
    await fs.writeFile(p, 'has trailing newline\n');
    await ensureManagedSection(p);
    const text = await fs.readFile(p, 'utf8');
    expect(text).toBe(
      `has trailing newline\n\n${MANAGED_BEGIN}\n${MANAGED_END}\n`,
    );
  });
});

describe('stripManagedSection', () => {
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
    await fs.writeFile(
      p,
      `before\n${MANAGED_BEGIN}${between}${MANAGED_END}\nafter\n`,
    );
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

  it('round-trip create→strip preserves original bytes exactly', async () => {
    const p = join(testDir, 'CLAUDE.md');
    const original = '# My Project Rules\n\nSome content here.\n';
    await fs.writeFile(p, original);
    await ensureManagedSection(p);
    // Verify markers were added
    const withMarkers = await fs.readFile(p, 'utf8');
    expect(withMarkers).toContain(MANAGED_BEGIN);
    // Strip them
    await stripManagedSection(p);
    const restored = await fs.readFile(p, 'utf8');
    expect(restored).toBe(original);
  });

  it('round-trip create→strip on file without trailing newline leaves at most one trailing newline', async () => {
    const p = join(testDir, 'CLAUDE.md');
    const original = '# Rules\nNo trailing newline';
    await fs.writeFile(p, original);
    await ensureManagedSection(p);
    await stripManagedSection(p);
    const restored = await fs.readFile(p, 'utf8');
    // Without trailing \n the separator is ambiguous; at most one \n is added
    expect(restored).toBe(original + '\n');
    expect(restored).not.toContain(MANAGED_BEGIN);
    expect(restored).not.toContain(MANAGED_END);
  });
});

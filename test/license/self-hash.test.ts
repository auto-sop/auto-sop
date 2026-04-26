import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeCliHash, listDistFiles, resetHashCache } from '../../src/license/self-hash.js';

describe('listDistFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'self-hash-list-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists .js and .cjs files sorted by name', () => {
    writeFileSync(join(tmpDir, 'b.js'), 'b');
    writeFileSync(join(tmpDir, 'a.cjs'), 'a');
    writeFileSync(join(tmpDir, 'c.ts'), 'c'); // should be excluded
    writeFileSync(join(tmpDir, 'README.md'), 'readme');

    const files = listDistFiles(tmpDir);
    expect(files).toEqual(['a.cjs', 'b.js']);
  });

  it('returns empty array for non-existent directory', () => {
    const files = listDistFiles('/nonexistent/path/xyz');
    expect(files).toEqual([]);
  });
});

describe('computeCliHash', () => {
  let fixtureDir: string;

  beforeEach(() => {
    resetHashCache();
    fixtureDir = mkdtempSync(join(tmpdir(), 'self-hash-'));
    writeFileSync(join(fixtureDir, 'cli.js'), 'console.log("hello");');
    writeFileSync(join(fixtureDir, 'index.cjs'), 'module.exports = {};');
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
    resetHashCache();
  });

  it('produces a 64-char hex SHA-256 hash', () => {
    const hash = computeCliHash(fixtureDir);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic — same input yields same hash', () => {
    const h1 = computeCliHash(fixtureDir);
    resetHashCache();
    const h2 = computeCliHash(fixtureDir);
    expect(h1).toBe(h2);
  });

  it('changes when a file is modified', () => {
    const before = computeCliHash(fixtureDir);
    resetHashCache();
    writeFileSync(join(fixtureDir, 'cli.js'), 'console.log("tampered");');
    const after = computeCliHash(fixtureDir);
    expect(before).not.toBe(after);
  });

  it('changes when a file is added', () => {
    const before = computeCliHash(fixtureDir);
    resetHashCache();
    writeFileSync(join(fixtureDir, 'new.js'), 'new file');
    const after = computeCliHash(fixtureDir);
    expect(before).not.toBe(after);
  });

  it('returns consistent hash for empty directory', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'self-hash-empty-'));
    const h1 = computeCliHash(emptyDir);
    resetHashCache();
    const h2 = computeCliHash(emptyDir);
    expect(h1).toBe(h2);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('caches the hash in memory (when no distDir override)', () => {
    // We can't easily test memory caching without mocking,
    // but we can verify that calling with explicit distDir
    // does NOT use the cache (returns fresh computation)
    const h1 = computeCliHash(fixtureDir);
    writeFileSync(join(fixtureDir, 'cli.js'), 'modified');
    // Without resetHashCache, explicit distDir should still re-compute
    const h2 = computeCliHash(fixtureDir);
    expect(h1).not.toBe(h2);
  });
});

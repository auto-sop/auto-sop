import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeCliHash, resetHashCache } from '../../src/license/self-hash.js';

describe('self-hash integration', () => {
  let fixtureDir: string;

  beforeEach(() => {
    resetHashCache();
    fixtureDir = mkdtempSync(join(tmpdir(), 'self-hash-int-'));
    writeFileSync(join(fixtureDir, 'cli.js'), 'console.log("v1");');
    writeFileSync(join(fixtureDir, 'lib.cjs'), 'module.exports = { v: 1 };');
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
    resetHashCache();
  });

  it('hash changes when a dist/ file is modified', () => {
    const before = computeCliHash(fixtureDir);
    resetHashCache();
    writeFileSync(join(fixtureDir, 'cli.js'), 'console.log("tampered");');
    const after = computeCliHash(fixtureDir);
    expect(before).not.toBe(after);
  });

  it('hash changes when a new .js file is added', () => {
    const before = computeCliHash(fixtureDir);
    resetHashCache();
    writeFileSync(join(fixtureDir, 'extra.js'), 'extra code');
    const after = computeCliHash(fixtureDir);
    expect(before).not.toBe(after);
  });

  it('hash is stable across multiple computations with same content', () => {
    const h1 = computeCliHash(fixtureDir);
    resetHashCache();
    const h2 = computeCliHash(fixtureDir);
    resetHashCache();
    const h3 = computeCliHash(fixtureDir);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('hash ignores non-.js/.cjs files', () => {
    const before = computeCliHash(fixtureDir);
    resetHashCache();
    writeFileSync(join(fixtureDir, 'README.md'), 'readme');
    writeFileSync(join(fixtureDir, 'config.json'), '{}');
    const after = computeCliHash(fixtureDir);
    expect(before).toBe(after);
  });

  it('hash is a valid SHA-256 hex string', () => {
    const hash = computeCliHash(fixtureDir);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash.length).toBe(64);
  });
});

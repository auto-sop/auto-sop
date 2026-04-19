import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readLastHash,
  writeLastHash,
  clearLastHash,
  sha256,
} from '../../src/managed-section/hash-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-hash-store-'));
}

describe('hash-store', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpDir();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const hashPath = () =>
    join(projectRoot, '.auto-sop', 'state', 'managed-section-hash.json');

  it('returns null when no hash file exists', () => {
    expect(readLastHash(projectRoot)).toBeNull();
  });

  it('writes a record and reads it back', () => {
    const hash = sha256('hello world');
    writeLastHash(projectRoot, hash);

    const rec = readLastHash(projectRoot);
    expect(rec).not.toBeNull();
    expect(rec!.lastHash).toBe(hash);
    expect(typeof rec!.updatedAt).toBe('string');
    // updatedAt is a valid ISO timestamp
    expect(() => new Date(rec!.updatedAt).toISOString()).not.toThrow();
  });

  it('overwrites the hash on subsequent writes', () => {
    writeLastHash(projectRoot, sha256('v1'));
    const first = readLastHash(projectRoot)!;
    writeLastHash(projectRoot, sha256('v2'));
    const second = readLastHash(projectRoot)!;

    expect(second.lastHash).not.toBe(first.lastHash);
    expect(second.lastHash).toBe(sha256('v2'));
  });

  it('writes the hash file with restrictive (0600) permissions', () => {
    writeLastHash(projectRoot, sha256('payload'));
    const stats = statSync(hashPath());
    // No bits for group/other.
    expect(stats.mode & 0o077).toBe(0);
  });

  it('APEX SEC-006: creates .auto-sop/state with user-only (0o700) mode', () => {
    // POSIX-only — on Windows, file-mode bits are not meaningful.
    if (process.platform === 'win32') return;
    writeLastHash(projectRoot, sha256('payload'));
    const dirStat = statSync(join(projectRoot, '.auto-sop', 'state'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it('clearLastHash deletes an existing hash file', () => {
    writeLastHash(projectRoot, sha256('payload'));
    expect(existsSync(hashPath())).toBe(true);
    clearLastHash(projectRoot);
    expect(existsSync(hashPath())).toBe(false);
    expect(readLastHash(projectRoot)).toBeNull();
  });

  it('clearLastHash is a no-op when nothing is stored', () => {
    expect(() => clearLastHash(projectRoot)).not.toThrow();
    expect(readLastHash(projectRoot)).toBeNull();
  });

  it('readLastHash returns null on malformed JSON', () => {
    mkdirSync(join(projectRoot, '.auto-sop', 'state'), { recursive: true });
    writeFileSync(hashPath(), '{not-json', { mode: 0o600 });
    expect(readLastHash(projectRoot)).toBeNull();
  });

  it('readLastHash returns null when JSON is the wrong shape', () => {
    mkdirSync(join(projectRoot, '.auto-sop', 'state'), { recursive: true });
    writeFileSync(hashPath(), JSON.stringify({ wrong: true }), { mode: 0o600 });
    expect(readLastHash(projectRoot)).toBeNull();
  });

  it('readLastHash returns null when lastHash is empty string', () => {
    mkdirSync(join(projectRoot, '.auto-sop', 'state'), { recursive: true });
    writeFileSync(
      hashPath(),
      JSON.stringify({ lastHash: '', updatedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    expect(readLastHash(projectRoot)).toBeNull();
  });

  it('writeLastHash refuses to write an empty hash', () => {
    expect(() => writeLastHash(projectRoot, '')).toThrow(/non-empty/);
  });

  it('rejects relative projectRoot', () => {
    expect(() => readLastHash('relative/path')).toThrow(/must be absolute/);
    expect(() => writeLastHash('relative/path', sha256('x'))).toThrow(
      /must be absolute/,
    );
    expect(() => clearLastHash('relative/path')).toThrow(/must be absolute/);
  });

  it('rejects projectRoot containing ..', () => {
    expect(() => readLastHash('/tmp/../etc')).toThrow(/must not contain/);
    expect(() => writeLastHash('/tmp/../etc', sha256('x'))).toThrow(
      /must not contain/,
    );
    expect(() => clearLastHash('/tmp/../etc')).toThrow(/must not contain/);
  });

  it('writeLastHash is atomic (no .tmp leftover)', () => {
    writeLastHash(projectRoot, sha256('payload'));
    expect(existsSync(hashPath() + '.tmp')).toBe(false);
  });

  it('sha256 produces the expected digest for a known input', () => {
    // Reference: echo -n "abc" | sha256sum
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('sha256 produces different digests for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
});

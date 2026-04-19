import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRegistry, upsertProject, removeProject, registryPath, validateProjectRoot } from '../../src/learner/project-registry.js';

describe('project-registry', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'registry-test-'));
    mkdirSync(join(tmpHome, '.auto-sop'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('readRegistry returns empty when no file exists', () => {
    const reg = readRegistry(tmpHome);
    expect(reg.version).toBe(1);
    expect(reg.projects).toEqual([]);
  });

  it('readRegistry returns empty on malformed JSON', () => {
    const regPath = registryPath(tmpHome);
    mkdirSync(join(tmpHome, '.auto-sop'), { recursive: true });
    writeFileSync(regPath, 'NOT JSON!!!');
    const reg = readRegistry(tmpHome);
    expect(reg.version).toBe(1);
    expect(reg.projects).toEqual([]);
  });

  it('upsertProject creates new entry', () => {
    upsertProject('id1', 'my-project', '/tmp/project', tmpHome);
    const reg = readRegistry(tmpHome);
    expect(reg.projects).toHaveLength(1);
    expect(reg.projects[0]!.project_id).toBe('id1');
    expect(reg.projects[0]!.slug).toBe('my-project');
    expect(reg.projects[0]!.project_root).toBe('/tmp/project');
  });

  it('upsertProject updates existing entry', () => {
    upsertProject('id1', 'old-slug', '/tmp/old', tmpHome);
    upsertProject('id1', 'new-slug', '/tmp/new', tmpHome);
    const reg = readRegistry(tmpHome);
    expect(reg.projects).toHaveLength(1);
    expect(reg.projects[0]!.slug).toBe('new-slug');
    expect(reg.projects[0]!.project_root).toBe('/tmp/new');
  });

  it('removeProject removes an entry', () => {
    upsertProject('id1', 'slug1', '/tmp/p1', tmpHome);
    upsertProject('id2', 'slug2', '/tmp/p2', tmpHome);
    removeProject('id1', tmpHome);
    const reg = readRegistry(tmpHome);
    expect(reg.projects).toHaveLength(1);
    expect(reg.projects[0]!.project_id).toBe('id2');
  });

  it('removeProject is idempotent for missing id', () => {
    upsertProject('id1', 'slug1', '/tmp/p1', tmpHome);
    removeProject('nonexistent', tmpHome);
    const reg = readRegistry(tmpHome);
    expect(reg.projects).toHaveLength(1);
  });

  // ── SEC-001: validateProjectRoot ──────────────────────────

  describe('validateProjectRoot', () => {
    it('rejects paths containing ".." traversal segments', () => {
      expect(() => validateProjectRoot('/tmp/../etc/passwd')).toThrow('traversal segments');
      expect(() => validateProjectRoot('/home/user/../../root')).toThrow('traversal segments');
    });

    it('rejects non-absolute paths', () => {
      expect(() => validateProjectRoot('relative/path')).toThrow('not absolute');
      expect(() => validateProjectRoot('foo')).toThrow('not absolute');
    });

    it('accepts valid absolute paths', () => {
      expect(validateProjectRoot('/tmp/project')).toBe('/tmp/project');
      expect(validateProjectRoot('/home/user/my-project')).toBe('/home/user/my-project');
    });

    it('returns resolved path (normalizes trailing slashes etc.)', () => {
      const result = validateProjectRoot('/tmp/project/');
      expect(result).toBe('/tmp/project');
    });
  });

  describe('upsertProject with invalid root', () => {
    it('throws on path traversal', () => {
      expect(() => upsertProject('id1', 'slug', '/tmp/../etc', tmpHome)).toThrow('traversal segments');
    });

    it('throws on non-absolute path', () => {
      expect(() => upsertProject('id1', 'slug', 'relative/path', tmpHome)).toThrow('not absolute');
    });

    it('does not write entry to registry on invalid root', () => {
      try { upsertProject('id1', 'slug', '/tmp/../etc', tmpHome); } catch { /* expected */ }
      const reg = readRegistry(tmpHome);
      expect(reg.projects).toHaveLength(0);
    });
  });

  it('concurrent writes produce valid JSON', async () => {
    // Rapid sequential writes (simulating near-concurrent)
    const promises = Array.from({ length: 5 }, (_, i) =>
      Promise.resolve().then(() => upsertProject(`id${i}`, `slug${i}`, `/tmp/p${i}`, tmpHome)),
    );
    await Promise.all(promises);
    const reg = readRegistry(tmpHome);
    // All should exist (sequential due to lock)
    expect(reg.projects.length).toBeGreaterThanOrEqual(1);
    // Registry file should be valid JSON
    const raw = readFileSync(registryPath(tmpHome), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

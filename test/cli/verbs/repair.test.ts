/**
 * Unit tests for the `auto-sop repair` CLI verb (V27 Task 2).
 *
 * Tests the core runRepair() function directly (no CLI harness needed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRepair } from '../../../src/cli/verbs/repair.js';
import { writeManagedSection } from '../../../src/managed-section/editor.js';
import { readLastHash } from '../../../src/managed-section/hash-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-repair-'));
}

describe('auto-sop repair', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpDir();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const claudeMd = () => join(projectRoot, 'CLAUDE.md');

  it('re-syncs hash when drift is detected', () => {
    // 1. Write a managed section (establishes hash)
    writeManagedSection({ projectRoot, content: { body: 'baseline' } });
    const hashBefore = readLastHash(projectRoot)!.lastHash;

    // 2. Simulate drift by editing the managed section
    const file = readFileSync(claudeMd(), 'utf-8');
    const tampered = file.replace('baseline', 'USER EDIT');
    writeFileSync(claudeMd(), tampered);

    // 3. Verify drift exists (hash mismatch)
    const hashAfterTamper = readLastHash(projectRoot)!.lastHash;
    expect(hashAfterTamper).toBe(hashBefore); // stored hash is still old

    // 4. Run repair
    const result = runRepair(projectRoot);

    // 5. Hash should be re-synced
    expect(result.hashResynced).toBe(true);
    expect(result.details.length).toBeGreaterThan(0);
    expect(result.details[0]).toContain('drift');

    // 6. Stored hash should now match current file
    const hashAfterRepair = readLastHash(projectRoot);
    expect(hashAfterRepair).not.toBeNull();
    expect(hashAfterRepair!.lastHash).not.toBe(hashBefore);
  });

  it('clears hash when no managed section markers exist', () => {
    // 1. Write a managed section (establishes hash)
    writeManagedSection({ projectRoot, content: { body: 'will be removed' } });
    expect(readLastHash(projectRoot)).not.toBeNull();

    // 2. Overwrite CLAUDE.md with content that has no markers
    writeFileSync(claudeMd(), '# CLAUDE.md\n\nUser content only.\n');

    // 3. Run repair
    const result = runRepair(projectRoot);

    // 4. Hash should be cleared
    expect(result.hashCleared).toBe(true);
    expect(result.details.some((d) => d.includes('cleared'))).toBe(true);
    expect(readLastHash(projectRoot)).toBeNull();
  });

  it('cleans stale current-turn markers', () => {
    // 1. Create state dir with stale turn markers
    const stateDir = join(projectRoot, '.auto-sop', 'state');
    mkdirSync(stateDir, { recursive: true });

    // Create a stale file (set mtime to 2 hours ago)
    const stalePath = join(stateDir, 'current-turn-abc123.json');
    writeFileSync(stalePath, '{}');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stalePath, twoHoursAgo, twoHoursAgo);

    // Create a fresh file (should NOT be removed)
    const freshPath = join(stateDir, 'current-turn-def456.json');
    writeFileSync(freshPath, '{}');

    // 2. Run repair
    const result = runRepair(projectRoot);

    // 3. Only the stale marker should be removed
    expect(result.staleTurnMarkersRemoved).toBe(1);
    expect(result.details.some((d) => d.includes('stale'))).toBe(true);

    // Fresh file should still exist
    expect(existsSync(freshPath)).toBe(true);
    expect(existsSync(stalePath)).toBe(false);
  });

  it('reports nothing to repair when everything is healthy', () => {
    // 1. Write a managed section with correct hash
    writeManagedSection({ projectRoot, content: { body: 'all good' } });

    // 2. Run repair — nothing should need fixing
    const result = runRepair(projectRoot);

    expect(result.hashResynced).toBe(false);
    expect(result.hashCleared).toBe(false);
    expect(result.staleTurnMarkersRemoved).toBe(0);
    expect(result.details).toEqual([]);
  });
});

/**
 * V27 Task 3 — Auto-recovery on drift detection.
 *
 * After 3 consecutive drifts, the editor auto-repairs by re-computing
 * the hash from the current file and proceeding with the write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeManagedSection } from '../../src/managed-section/editor.js';
import { readLastHash, clearLastHash } from '../../src/managed-section/hash-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-auto-recovery-'));
}

/**
 * Helper: write a managed section, then tamper with the file to create drift.
 * Returns the tampered content.
 */
function setupDrift(projectRoot: string, body: string, tamperWith: string): string {
  writeManagedSection({ projectRoot, content: { body } });
  const claudeMd = join(projectRoot, 'CLAUDE.md');
  const file = readFileSync(claudeMd, 'utf-8');
  const tampered = file.replace(body, tamperWith);
  writeFileSync(claudeMd, tampered);
  return tampered;
}

describe('ManagedSectionEditor — V27 auto-recovery on consecutive drifts', () => {
  let projectRoot: string;
  const events: Array<{ kind: string; data: unknown }> = [];
  const logger = (kind: string, data?: unknown) => events.push({ kind, data });

  beforeEach(() => {
    projectRoot = makeTmpDir();
    events.length = 0;
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const claudeMd = () => join(projectRoot, 'CLAUDE.md');

  it('1st and 2nd drift → abort (existing behavior preserved)', () => {
    // Establish baseline
    setupDrift(projectRoot, 'baseline', 'USER EDIT 1');

    // 1st drift attempt
    events.length = 0;
    const result1 = writeManagedSection({
      projectRoot,
      content: { body: 'attempt-1' },
      logger,
    });
    expect(result1.verdict).toBe('drift_aborted');

    // Verify consecutiveDrifts is tracked
    const hash1 = readLastHash(projectRoot);
    expect(hash1).not.toBeNull();
    expect(hash1!.consecutiveDrifts).toBe(1);

    // 2nd drift attempt (file still has USER EDIT 1, hash still old)
    events.length = 0;
    const result2 = writeManagedSection({
      projectRoot,
      content: { body: 'attempt-2' },
      logger,
    });
    expect(result2.verdict).toBe('drift_aborted');

    const hash2 = readLastHash(projectRoot);
    expect(hash2).not.toBeNull();
    expect(hash2!.consecutiveDrifts).toBe(2);

    // File should still have the user edit — NOT overwritten
    expect(readFileSync(claudeMd(), 'utf-8')).toContain('USER EDIT 1');
    expect(readFileSync(claudeMd(), 'utf-8')).not.toContain('attempt-1');
    expect(readFileSync(claudeMd(), 'utf-8')).not.toContain('attempt-2');
  });

  it('3rd consecutive drift → auto-repair + successful write', () => {
    // Establish baseline and tamper
    setupDrift(projectRoot, 'baseline', 'USER EDIT');

    // Drift 1
    writeManagedSection({ projectRoot, content: { body: 'x' }, logger });
    // Drift 2
    writeManagedSection({ projectRoot, content: { body: 'x' }, logger });

    // Verify we're at 2 consecutive drifts
    expect(readLastHash(projectRoot)!.consecutiveDrifts).toBe(2);

    // Drift 3 — should auto-repair
    events.length = 0;
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'auto-repaired content' },
      logger,
    });

    // Should have proceeded with write (not drift_aborted)
    expect(result.verdict).toBe('updated');

    // File should contain the new content
    expect(readFileSync(claudeMd(), 'utf-8')).toContain('auto-repaired content');

    // Auto-repair event should have been logged
    const repairEvent = events.find((e) => e.kind === 'managed_section_drift_auto_repaired');
    expect(repairEvent).toBeDefined();
    expect((repairEvent!.data as Record<string, unknown>).consecutiveDrifts).toBe(3);

    // Counter should be reset (new hash stored without consecutiveDrifts)
    const hashAfter = readLastHash(projectRoot);
    expect(hashAfter).not.toBeNull();
    expect(hashAfter!.consecutiveDrifts).toBeUndefined();
  });

  it('successful write resets consecutiveDrifts counter to 0', () => {
    // Establish baseline — write v1
    writeManagedSection({ projectRoot, content: { body: 'v1' }, logger });

    // Tamper the body only (not the markers — avoid replacing 'v1' in the
    // begin-marker string by targeting the body content specifically)
    const file = readFileSync(claudeMd(), 'utf-8');
    // The body sits between the generated comment and the end marker
    const tampered = file.replace('\nv1\n', '\ntampered-body\n');
    writeFileSync(claudeMd(), tampered);

    // 1st drift
    writeManagedSection({ projectRoot, content: { body: 'x' }, logger });
    expect(readLastHash(projectRoot)!.consecutiveDrifts).toBe(1);

    // Now clear the drift by clearing hash and writing fresh (simulates
    // a manual repair or CLI repair invocation)
    clearLastHash(projectRoot);

    // Normal successful write — write new content to the tampered file.
    // Since hash is cleared, the editor treats this as first-run.
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'fresh start' },
      logger,
    });
    expect(result.verdict).toBe('updated');

    // Counter should be reset — no consecutiveDrifts in the record
    const hash = readLastHash(projectRoot);
    expect(hash).not.toBeNull();
    expect(hash!.consecutiveDrifts).toBeUndefined();
  });
});

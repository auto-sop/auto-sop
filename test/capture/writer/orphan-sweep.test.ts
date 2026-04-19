import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  sweepOrphanedTurns,
  sweepOrphanTmpPayloads,
  TMP_MAX_AGE_MS,
  MAX_TMP_SWEEP_PER_PASS,
} from '~/capture/writer/orphan-sweep.js';
import { startMeta, writeMeta } from '~/capture/writer/meta.js';
import type { HookPayloadType } from '~/capture/events.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePayload(): HookPayloadType {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    prompt: 'test prompt',
  } as HookPayloadType;
}

/**
 * Create a .pending turn dir with meta.json inside capturesDir.
 * Returns the absolute path.
 */
function createPendingDir(capturesDir: string, name: string, mtime?: Date): string {
  const dirPath = join(capturesDir, name);
  mkdirSync(dirPath, { recursive: true });

  // Write a meta.json so finalizeMeta can read it
  const meta = startMeta(makePayload(), {
    projectId: 'test-id',
    projectSlug: 'test',
    turnId: name.replace('.pending', ''),
    agent: 'main',
    subagentType: null,
    hookShimVersion: '0.1.0',
  });
  writeMeta(dirPath, meta);

  // Set mtime on the dir and its files if specified
  if (mtime) {
    // Set mtime on meta.json
    utimesSync(join(dirPath, 'meta.json'), mtime, mtime);
    // Set mtime on the directory itself
    utimesSync(dirPath, mtime, mtime);
  }

  return dirPath;
}

/**
 * Set mtime on a dir and all its immediate children to the given time.
 */
function setDirMtime(dirPath: string, mtime: Date): void {
  utimesSync(dirPath, mtime, mtime);
  try {
    for (const entry of readdirSync(dirPath)) {
      try {
        utimesSync(join(dirPath, entry), mtime, mtime);
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
}

describe('orphan-sweep', () => {
  let capturesDir: string;
  let yarimKalanDir: string;

  beforeEach(() => {
    const base = makeTmpDir();
    capturesDir = join(base, 'captures');
    yarimKalanDir = join(base, 'captures', 'yarim-kalan');
    mkdirSync(capturesDir, { recursive: true });
  });

  describe('sweepOrphanedTurns', () => {
    it('does not touch a fresh pending dir (age < 30s)', () => {
      const now = Date.now();
      const pendingPath = createPendingDir(capturesDir, 'fresh-turn.pending');
      // mtime is "now" by default

      const result = sweepOrphanedTurns(capturesDir, yarimKalanDir, now);

      expect(result.finalized).toBe(0);
      expect(result.quarantined).toBe(0);
      expect(result.errors).toBe(0);
      expect(existsSync(pendingPath)).toBe(true);
    });

    it('finalizes a stale pending dir (age 45s) with reason timeout', () => {
      const now = Date.now();
      const staleTime = new Date(now - 45_000); // 45 seconds old
      const pendingPath = createPendingDir(capturesDir, 'stale-turn.pending', staleTime);
      setDirMtime(pendingPath, staleTime);

      const result = sweepOrphanedTurns(capturesDir, yarimKalanDir, now);

      expect(result.finalized).toBe(1);
      expect(result.quarantined).toBe(0);
      // .pending should be gone
      expect(existsSync(pendingPath)).toBe(false);
      // Finalized dir (without .pending) should exist
      const finalizedPath = pendingPath.replace('.pending', '');
      expect(existsSync(finalizedPath)).toBe(true);
      // Meta should have finalization_reason='timeout'
      const raw = readFileSync(join(finalizedPath, 'meta.json'), 'utf8');
      const meta = JSON.parse(raw);
      expect(meta.finalization_reason).toBe('timeout');
      expect(meta.finalized_at).toBeTruthy();
    });

    it('quarantines a very old pending dir (age 45 min) to yarim-kalan', () => {
      const now = Date.now();
      const oldTime = new Date(now - 45 * 60_000); // 45 minutes old
      const pendingPath = createPendingDir(capturesDir, 'ancient-turn.pending', oldTime);
      setDirMtime(pendingPath, oldTime);

      const result = sweepOrphanedTurns(capturesDir, yarimKalanDir, now);

      expect(result.quarantined).toBe(1);
      expect(result.finalized).toBe(0);
      // Original should be gone
      expect(existsSync(pendingPath)).toBe(false);
      // Should be in yarim-kalan/
      expect(existsSync(join(yarimKalanDir, 'ancient-turn.pending'))).toBe(true);
    });

    it('handles multiple dirs with mixed ages correctly', () => {
      const now = Date.now();

      // Fresh (5s old) — should stay
      const freshPath = createPendingDir(capturesDir, 'fresh.pending');
      // Don't change mtime — it's fresh

      // Stale (45s old) — should finalize
      const staleTime = new Date(now - 45_000);
      const stalePath = createPendingDir(capturesDir, 'stale.pending', staleTime);
      setDirMtime(stalePath, staleTime);

      // Ancient (45 min old) — should quarantine
      const ancientTime = new Date(now - 45 * 60_000);
      const ancientPath = createPendingDir(capturesDir, 'ancient.pending', ancientTime);
      setDirMtime(ancientPath, ancientTime);

      const result = sweepOrphanedTurns(capturesDir, yarimKalanDir, now);

      expect(result.finalized).toBe(1);
      expect(result.quarantined).toBe(1);
      expect(result.errors).toBe(0);

      // Fresh stays
      expect(existsSync(freshPath)).toBe(true);
      // Stale is finalized (no .pending)
      expect(existsSync(stalePath)).toBe(false);
      expect(existsSync(stalePath.replace('.pending', ''))).toBe(true);
      // Ancient is quarantined
      expect(existsSync(ancientPath)).toBe(false);
      expect(existsSync(join(yarimKalanDir, 'ancient.pending'))).toBe(true);
    });

    it('continues sweeping even if one dir errors', () => {
      const now = Date.now();
      const staleTime = new Date(now - 45_000);

      // Create two stale dirs
      const dir1 = createPendingDir(capturesDir, 'ok-dir.pending', staleTime);
      setDirMtime(dir1, staleTime);

      // Create a dir that will cause an error (remove meta.json so finalizeMeta throws)
      const badDir = join(capturesDir, 'bad-dir.pending');
      mkdirSync(badDir, { recursive: true });
      // No meta.json → finalizeMeta will throw
      utimesSync(badDir, staleTime, staleTime);

      const result = sweepOrphanedTurns(capturesDir, yarimKalanDir, now);

      // One succeeded, one errored
      expect(result.finalized).toBe(1);
      expect(result.errors).toBe(1);
    });

    it('returns zeros when capturesDir does not exist', () => {
      const result = sweepOrphanedTurns('/tmp/nonexistent-dir-' + randomUUID(), yarimKalanDir);
      expect(result).toEqual({ finalized: 0, quarantined: 0, errors: 0 });
    });
  });

  describe('sweepOrphanTmpPayloads', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = makeTmpDir();
    });

    it('deletes old files and keeps fresh ones', () => {
      const now = Date.now();
      const oldTime = new Date(now - TMP_MAX_AGE_MS - 10_000); // >1h old
      const freshTime = new Date(now - 1000); // 1s old

      // Create 40 old files
      for (let i = 0; i < 40; i++) {
        const f = join(tmpDir, `old-${i}.json`);
        writeFileSync(f, '{}');
        utimesSync(f, oldTime, oldTime);
      }

      // Create 20 fresh files
      for (let i = 0; i < 20; i++) {
        const f = join(tmpDir, `fresh-${i}.json`);
        writeFileSync(f, '{}');
        utimesSync(f, freshTime, freshTime);
      }

      const result = sweepOrphanTmpPayloads(tmpDir, now);

      expect(result.deleted).toBe(40);
      // Fresh files remain
      const remaining = readdirSync(tmpDir);
      expect(remaining).toHaveLength(20);
      expect(remaining.every((f) => f.startsWith('fresh-'))).toBe(true);
    });

    it('caps deletions at MAX_TMP_SWEEP_PER_PASS', () => {
      const now = Date.now();
      const oldTime = new Date(now - TMP_MAX_AGE_MS - 10_000);

      // Create 100 old files
      for (let i = 0; i < 100; i++) {
        const f = join(tmpDir, `old-${String(i).padStart(3, '0')}.json`);
        writeFileSync(f, '{}');
        utimesSync(f, oldTime, oldTime);
      }

      const result1 = sweepOrphanTmpPayloads(tmpDir, now);
      expect(result1.deleted).toBe(MAX_TMP_SWEEP_PER_PASS); // 50

      const remaining1 = readdirSync(tmpDir);
      expect(remaining1).toHaveLength(50);

      // Second pass cleans up the rest
      const result2 = sweepOrphanTmpPayloads(tmpDir, now);
      expect(result2.deleted).toBe(50);

      const remaining2 = readdirSync(tmpDir);
      expect(remaining2).toHaveLength(0);
    });

    it('returns zero when tmpDir does not exist', () => {
      const result = sweepOrphanTmpPayloads('/tmp/nonexistent-dir-' + randomUUID());
      expect(result.deleted).toBe(0);
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  isPaused,
  computeUsedBytes,
  enforceDiskBudget,
  DEFAULT_CAP_BYTES,
  PAUSE_RATIO,
} from '~/capture/writer/disk-budget.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('disk-budget.ts', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  describe('isPaused', () => {
    it('returns false when paused.flag does not exist', () => {
      expect(isPaused(join(tmpBase, 'paused.flag'))).toBe(false);
    });

    it('returns true when paused.flag exists', () => {
      const flagPath = join(tmpBase, 'paused.flag');
      writeFileSync(flagPath, '{}');
      expect(isPaused(flagPath)).toBe(true);
    });
  });

  describe('computeUsedBytes', () => {
    it('returns 0 for missing directory', () => {
      expect(computeUsedBytes(join(tmpBase, 'nonexistent'))).toBe(0);
    });

    it('returns 0 for empty directory', () => {
      const emptyDir = join(tmpBase, 'empty');
      mkdirSync(emptyDir);
      expect(computeUsedBytes(emptyDir)).toBe(0);
    });

    it('sums file sizes correctly', () => {
      const dir = join(tmpBase, 'data');
      mkdirSync(dir);
      writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100));
      writeFileSync(join(dir, 'b.txt'), 'y'.repeat(200));

      expect(computeUsedBytes(dir)).toBe(300);
    });

    it('recursively counts nested directory files', () => {
      const dir = join(tmpBase, 'nested');
      const sub = join(dir, 'sub', 'deep');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(dir, 'top.txt'), 'a'.repeat(50));
      writeFileSync(join(sub, 'bottom.txt'), 'b'.repeat(75));

      expect(computeUsedBytes(dir)).toBe(125);
    });
  });

  describe('enforceDiskBudget', () => {
    it('returns not paused when below threshold', () => {
      const capturesDir = join(tmpBase, 'captures');
      mkdirSync(capturesDir);
      writeFileSync(join(capturesDir, 'small.txt'), 'x'.repeat(100));

      const flagPath = join(tmpBase, 'paused.flag');
      const result = enforceDiskBudget(capturesDir, flagPath, 1000);

      expect(result.used).toBe(100);
      expect(result.paused).toBe(false);
      expect(result.justPaused).toBe(false);
      expect(existsSync(flagPath)).toBe(false);
    });

    it('creates paused.flag when crossing threshold', () => {
      const capturesDir = join(tmpBase, 'captures');
      mkdirSync(capturesDir);
      // Cap = 1000, threshold = 500 (50%). Write 600 bytes → crosses.
      writeFileSync(join(capturesDir, 'big.txt'), 'x'.repeat(600));

      const flagPath = join(tmpBase, 'paused.flag');
      const result = enforceDiskBudget(capturesDir, flagPath, 1000);

      expect(result.used).toBe(600);
      expect(result.paused).toBe(true);
      expect(result.justPaused).toBe(true);
      expect(existsSync(flagPath)).toBe(true);

      // Verify flag content
      const flagContent = JSON.parse(readFileSync(flagPath, 'utf8'));
      expect(flagContent.used).toBe(600);
      expect(flagContent.cap).toBe(1000);
      expect(flagContent.threshold).toBe(500);
      expect(flagContent.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('creates paused.flag with mode 0600', () => {
      const capturesDir = join(tmpBase, 'captures');
      mkdirSync(capturesDir);
      writeFileSync(join(capturesDir, 'big.txt'), 'x'.repeat(600));

      const flagPath = join(tmpBase, 'paused.flag');
      enforceDiskBudget(capturesDir, flagPath, 1000);

      const mode = statSync(flagPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('returns already paused when flag pre-exists (justPaused=false)', () => {
      const capturesDir = join(tmpBase, 'captures');
      mkdirSync(capturesDir);
      writeFileSync(join(capturesDir, 'big.txt'), 'x'.repeat(600));

      const flagPath = join(tmpBase, 'paused.flag');
      // Pre-create the flag
      writeFileSync(flagPath, '{"preexisting":true}');
      const result = enforceDiskBudget(capturesDir, flagPath, 1000);

      expect(result.paused).toBe(true);
      expect(result.justPaused).toBe(false);

      // Flag should not have been rewritten
      const content = readFileSync(flagPath, 'utf8');
      expect(JSON.parse(content).preexisting).toBe(true);
    });

    it('uses DEFAULT_CAP_BYTES (2GB) when no cap specified', () => {
      expect(DEFAULT_CAP_BYTES).toBe(2 * 1024 * 1024 * 1024);
      expect(PAUSE_RATIO).toBe(0.5);
    });

    it('treats exactly-at-threshold as crossing', () => {
      const capturesDir = join(tmpBase, 'captures');
      mkdirSync(capturesDir);
      // Cap = 200, threshold = 100. Write exactly 100 bytes.
      writeFileSync(join(capturesDir, 'exact.txt'), 'x'.repeat(100));

      const flagPath = join(tmpBase, 'paused.flag');
      const result = enforceDiskBudget(capturesDir, flagPath, 200);

      expect(result.paused).toBe(true);
      expect(result.justPaused).toBe(true);
    });
  });
});

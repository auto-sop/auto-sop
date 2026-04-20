import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../../src/cli/main.js';

describe('pause / resume verbs', () => {
  let tmpDir: string;
  let stdoutChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sop-pause-'));
    stdoutChunks = [];
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function stdout(): string {
    return stdoutChunks.join('');
  }

  function flagPath(): string {
    return path.join(tmpDir, '.auto-sop', 'paused.flag');
  }

  describe('pause', () => {
    it('creates paused.flag with paused_at timestamp', async () => {
      const code = await runCli(['node', 'auto-sop', 'pause', '--project', tmpDir]);
      expect(code).toBe(0);
      const content = await fs.readFile(flagPath(), 'utf8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.paused_at).toBeTypeOf('number');
      expect(parsed.paused_at).toBeGreaterThan(0);
    });

    it('creates .auto-sop dir if missing', async () => {
      await runCli(['node', 'auto-sop', 'pause', '--project', tmpDir]);
      const stat = await fs.stat(path.join(tmpDir, '.auto-sop'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('is idempotent — re-running overwrites flag without error', async () => {
      await runCli(['node', 'auto-sop', 'pause', '--project', tmpDir]);
      const code = await runCli(['node', 'auto-sop', 'pause', '--project', tmpDir]);
      expect(code).toBe(0);
      const content = await fs.readFile(flagPath(), 'utf8');
      expect(JSON.parse(content.trim()).paused_at).toBeTypeOf('number');
    });

    it('--json emits correct shape', async () => {
      await runCli(['node', 'auto-sop', '--json', 'pause', '--project', tmpDir]);
      const out = JSON.parse(stdout().trim());
      expect(out.ok).toBe(true);
      expect(out.verb).toBe('pause');
      expect(out.flag).toContain('paused.flag');
    });

    it('human mode prints confirmation', async () => {
      await runCli(['node', 'auto-sop', 'pause', '--project', tmpDir]);
      expect(stdout()).toContain('paused');
    });
  });

  describe('resume', () => {
    it('removes paused.flag when paused', async () => {
      // Pause first
      await runCli(['node', 'auto-sop', 'pause', '--project', tmpDir]);
      expect(
        await fs
          .access(flagPath())
          .then(() => true)
          .catch(() => false),
      ).toBe(true);

      // Resume
      const code = await runCli(['node', 'auto-sop', 'resume', '--project', tmpDir]);
      expect(code).toBe(0);
      expect(
        await fs
          .access(flagPath())
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    });

    it('is no-op if already resumed (no flag)', async () => {
      const code = await runCli(['node', 'auto-sop', 'resume', '--project', tmpDir]);
      expect(code).toBe(0);
      expect(stdout()).toContain('already resumed');
    });

    it('--json shows removed: true when flag existed', async () => {
      await runCli(['node', 'auto-sop', 'pause', '--project', tmpDir]);
      stdoutChunks = [];
      await runCli(['node', 'auto-sop', '--json', 'resume', '--project', tmpDir]);
      const out = JSON.parse(stdout().trim());
      expect(out.ok).toBe(true);
      expect(out.verb).toBe('resume');
      expect(out.removed).toBe(true);
    });

    it('--json shows removed: false when no flag', async () => {
      await runCli(['node', 'auto-sop', '--json', 'resume', '--project', tmpDir]);
      const out = JSON.parse(stdout().trim());
      expect(out.ok).toBe(true);
      expect(out.removed).toBe(false);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../../src/cli/main.js';

describe('errors verb', () => {
  let tmpDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sop-errors-'));
    stdoutChunks = [];
    stderrChunks = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function stdout(): string {
    return stdoutChunks.join('');
  }

  function errorsJsonlPath(): string {
    return path.join(tmpDir, '.claude-sop', 'errors.jsonl');
  }

  async function writeErrorsJsonl(entries: object[]): Promise<void> {
    await fs.mkdir(path.join(tmpDir, '.claude-sop'), { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(errorsJsonlPath(), lines, 'utf8');
  }

  function makeEntry(
    ts: number,
    kind: string,
    msg: string,
  ): { ts: number; kind: string; msg: string } {
    return { ts, kind, msg };
  }

  describe('missing errors.jsonl', () => {
    it('human mode prints (no errors)', async () => {
      const code = await runCli([
        'node',
        'claude-sop',
        'errors',
        '--project',
        tmpDir,
      ]);
      expect(code).toBe(0);
      expect(stdout()).toContain('no errors');
    });

    it('--json returns empty entries', async () => {
      await runCli([
        'node',
        'claude-sop',
        '--json',
        'errors',
        '--project',
        tmpDir,
      ]);
      const out = JSON.parse(stdout().trim());
      expect(out.ok).toBe(true);
      expect(out.verb).toBe('errors');
      expect(out.count).toBe(0);
      expect(out.entries).toEqual([]);
    });
  });

  describe('with entries', () => {
    it('shows all entries when count <= default tail', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry(Date.now() - (10 - i) * 1000, 'hook_crash', `error ${i}`),
      );
      await writeErrorsJsonl(entries);

      await runCli([
        'node',
        'claude-sop',
        '--json',
        'errors',
        '--project',
        tmpDir,
      ]);
      const out = JSON.parse(stdout().trim());
      expect(out.count).toBe(10);
      expect(out.entries).toHaveLength(10);
    });

    it('--tail limits output to last N entries', async () => {
      const entries = Array.from({ length: 50 }, (_, i) =>
        makeEntry(Date.now() - (50 - i) * 1000, 'hook_crash', `error ${i}`),
      );
      await writeErrorsJsonl(entries);

      await runCli([
        'node',
        'claude-sop',
        '--json',
        'errors',
        '--project',
        tmpDir,
        '--tail',
        '5',
      ]);
      const out = JSON.parse(stdout().trim());
      expect(out.count).toBe(5);
      expect(out.entries).toHaveLength(5);
      // Should be the LAST 5 entries
      expect(out.entries[0].msg).toBe('error 45');
      expect(out.entries[4].msg).toBe('error 49');
    });

    it('--since filters entries by timestamp', async () => {
      const now = Date.now();
      const entries = [
        makeEntry(now - 7200000, 'old_error', 'too old'), // 2h ago
        makeEntry(now - 1800000, 'recent_error', 'recent'), // 30m ago
        makeEntry(now - 60000, 'new_error', 'brand new'), // 1m ago
      ];
      await writeErrorsJsonl(entries);

      await runCli([
        'node',
        'claude-sop',
        '--json',
        'errors',
        '--project',
        tmpDir,
        '--since',
        '1h',
      ]);
      const out = JSON.parse(stdout().trim());
      expect(out.count).toBe(2);
      expect(out.entries[0].kind).toBe('recent_error');
      expect(out.entries[1].kind).toBe('new_error');
    });

    it('skips malformed JSON lines silently', async () => {
      await fs.mkdir(path.join(tmpDir, '.claude-sop'), { recursive: true });
      const content = [
        JSON.stringify(makeEntry(Date.now(), 'good', 'ok')),
        'this is not json{{{',
        JSON.stringify(makeEntry(Date.now(), 'also_good', 'fine')),
        '',
      ].join('\n');
      await fs.writeFile(errorsJsonlPath(), content, 'utf8');

      await runCli([
        'node',
        'claude-sop',
        '--json',
        'errors',
        '--project',
        tmpDir,
      ]);
      const out = JSON.parse(stdout().trim());
      expect(out.count).toBe(2);
    });

    it('human mode formats entries with timestamp and kind', async () => {
      const entries = [makeEntry(1700000000000, 'hook_crash', 'boom')];
      await writeErrorsJsonl(entries);

      await runCli([
        'node',
        'claude-sop',
        'errors',
        '--project',
        tmpDir,
      ]);
      const out = stdout();
      expect(out).toContain('hook_crash');
      expect(out).toContain('boom');
    });
  });

  describe('invalid --since', () => {
    it('exits with error for bogus value', async () => {
      const code = await runCli([
        'node',
        'claude-sop',
        'errors',
        '--project',
        tmpDir,
        '--since',
        'bogus',
      ]);
      expect(code).not.toBe(0);
    });
  });
});

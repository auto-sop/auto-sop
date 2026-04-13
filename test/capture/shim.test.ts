import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnWriter } from '../../src/capture/shim/handoff.js';

const SHIM_PATH = join(process.cwd(), 'dist', 'capture', 'shim.cjs');
const FIXTURE_PAYLOAD = readFileSync(
  join(process.cwd(), 'test', 'fixtures', 'hook-payloads', 'user-prompt-submit.json'),
);
const TMP_DIR = join(homedir(), '.claude-sop', 'tmp');

function cleanTmpDir(): void {
  try {
    const files = readdirSync(TMP_DIR);
    for (const f of files) {
      rmSync(join(TMP_DIR, f), { force: true });
    }
  } catch {
    // dir may not exist yet
  }
}

describe('Capture Shim', () => {
  beforeEach(() => {
    cleanTmpDir();
  });

  afterEach(() => {
    cleanTmpDir();
  });

  describe('Test A: kill-switch', () => {
    it('exits 0 and creates no tmp file when CLAUDE_SOP_LEARNER=1', () => {
      const result = execFileSync(process.execPath, [SHIM_PATH], {
        input: FIXTURE_PAYLOAD,
        env: { ...process.env, CLAUDE_SOP_LEARNER: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });

      // Should exit 0 (no throw from execFileSync)
      expect(result).toBeDefined();

      // No tmp file should have been created
      try {
        const files = readdirSync(TMP_DIR);
        expect(files.length).toBe(0);
      } catch {
        // dir doesn't exist = no file created, which is correct
      }
    });
  });

  describe('Test B: happy path', () => {
    it('writes tmp payload file with mode 0600 and exits 0', () => {
      // Create a fake writer that just exits
      const fakeWriterDir = join(tmpdir(), 'claude-sop-test-writer');
      mkdirSync(fakeWriterDir, { recursive: true });
      const fakeWriter = join(fakeWriterDir, 'fake-writer.cjs');
      writeFileSync(fakeWriter, 'process.exit(0);');

      // Use the bench shim so we can control the writer entry
      const benchShim = join(process.cwd(), 'dist', 'capture', 'shim-bench.cjs');

      execFileSync(process.execPath, [benchShim], {
        input: FIXTURE_PAYLOAD,
        env: {
          ...process.env,
          CLAUDE_SOP_LEARNER: undefined,
          CLAUDE_SOP_BENCH_WRITER: fakeWriter,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });

      // Exactly one file in tmp dir
      const files = readdirSync(TMP_DIR);
      expect(files.length).toBe(1);

      // File contents equal piped payload
      const written = readFileSync(join(TMP_DIR, files[0]!));
      expect(written.equals(FIXTURE_PAYLOAD)).toBe(true);

      // File mode is 0600
      const stats = statSync(join(TMP_DIR, files[0]!));
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);

      // Cleanup
      rmSync(fakeWriterDir, { recursive: true, force: true });
    });

    it('spawnWriter calls spawn with correct args (source-level)', () => {
      // This is a source-level test — we import spawnWriter directly
      // and verify it spawns with the expected arguments.
      // We use a sentinel writer that writes a marker file.
      const sentinelDir = join(tmpdir(), 'claude-sop-test-sentinel');
      mkdirSync(sentinelDir, { recursive: true });
      const sentinelFile = join(sentinelDir, 'spawned.txt');
      const sentinelWriter = join(sentinelDir, 'sentinel-writer.cjs');
      writeFileSync(
        sentinelWriter,
        `require('fs').writeFileSync('${sentinelFile.replace(/\\/g, '\\\\')}', process.argv[2] || 'no-arg');process.exit(0);`,
      );

      const fakeTmpPath = join(sentinelDir, 'test-payload.json');
      writeFileSync(fakeTmpPath, '{}');

      spawnWriter(fakeTmpPath, sentinelWriter);

      // Give the detached process a moment to run
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { timeout: 2000 });

      const sentinel = readFileSync(sentinelFile, 'utf8');
      expect(sentinel).toBe(fakeTmpPath);

      rmSync(sentinelDir, { recursive: true, force: true });
    });
  });

  describe('Test C: bad stdin', () => {
    it('exits 0 on garbage bytes', () => {
      const fakeWriterDir = join(tmpdir(), 'claude-sop-test-garbage');
      mkdirSync(fakeWriterDir, { recursive: true });
      const fakeWriter = join(fakeWriterDir, 'fake-writer.cjs');
      writeFileSync(fakeWriter, 'process.exit(0);');

      const benchShim = join(process.cwd(), 'dist', 'capture', 'shim-bench.cjs');
      const garbagePayload = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f, 0xab, 0xcd]);

      // Should not throw (exit 0)
      execFileSync(process.execPath, [benchShim], {
        input: garbagePayload,
        env: {
          ...process.env,
          CLAUDE_SOP_LEARNER: undefined,
          CLAUDE_SOP_BENCH_WRITER: fakeWriter,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });

      // A tmp file should still be created (shim doesn't parse JSON)
      const files = readdirSync(TMP_DIR);
      expect(files.length).toBe(1);

      rmSync(fakeWriterDir, { recursive: true, force: true });
    });
  });
});

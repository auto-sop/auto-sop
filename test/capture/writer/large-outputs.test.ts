import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { maybeOffloadLarge, LARGE_OUTPUT_THRESHOLD } from '~/capture/writer/large-outputs.js';
import { createScrubber, Scrubber } from '~/scrubber/index.js';
import { isWindows } from '../../setup/platform.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('large-outputs', () => {
  let turnDir: string;
  let scrubber: Scrubber;

  beforeEach(async () => {
    turnDir = makeTmpDir();
    scrubber = await createScrubber();
  });

  it('returns offloaded:false when content is under threshold', async () => {
    const content = 'x'.repeat(100 * 1024); // 100KB
    const result = await maybeOffloadLarge(turnDir, 'tu-small', 'out', content, scrubber);

    expect(result.offloaded).toBe(false);
    expect(result.ref).toBeUndefined();
    expect(existsSync(join(turnDir, 'large-outputs'))).toBe(false);
  });

  it('offloads content over threshold to gzipped file', async () => {
    const content = 'y'.repeat(300 * 1024); // 300KB
    const result = await maybeOffloadLarge(turnDir, 'tu-large', 'out', content, scrubber);

    expect(result.offloaded).toBe(true);
    expect(result.ref).toBe('large-outputs/tu-large.out.txt.gz');
    expect(result.bytes).toBe(Buffer.from(content, 'utf8').length);

    // Verify file exists and decompresses correctly
    const gzPath = join(turnDir, result.ref!);
    expect(existsSync(gzPath)).toBe(true);

    const compressed = readFileSync(gzPath);
    const decompressed = gunzipSync(compressed).toString('utf8');
    expect(decompressed).toBe(content);
  });

  it('offloads input (kind=in) with correct filename', async () => {
    const content = 'z'.repeat(300 * 1024);
    const result = await maybeOffloadLarge(turnDir, 'tu-in', 'in', content, scrubber);

    expect(result.offloaded).toBe(true);
    expect(result.ref).toBe('large-outputs/tu-in.in.txt.gz');
  });

  it('scrubs secrets from large content before compression', async () => {
    const secret = 'sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const padding = 'a'.repeat(300 * 1024);
    const content = `Secret: ${secret}\n${padding}`;

    const result = await maybeOffloadLarge(turnDir, 'tu-scrub', 'out', content, scrubber);

    expect(result.offloaded).toBe(true);
    expect(result.hitCount).toBeGreaterThanOrEqual(1);

    // Decompress and verify secret is not present
    const compressed = readFileSync(join(turnDir, result.ref!));
    const decompressed = gunzipSync(compressed).toString('utf8');
    expect(decompressed).not.toContain('sk-ant-api03');
  });

  it('creates large-outputs/ directory with mode 0700', async () => {
    const content = 'w'.repeat(300 * 1024);
    await maybeOffloadLarge(turnDir, 'tu-dir', 'out', content, scrubber);

    const dirStat = statSync(join(turnDir, 'large-outputs'));
    if (!isWindows) {
      expect(dirStat.mode & 0o777).toBe(0o700);
    }
  });

  it('creates gzipped file with mode 0600', async () => {
    const content = 'v'.repeat(300 * 1024);
    const result = await maybeOffloadLarge(turnDir, 'tu-perm', 'out', content, scrubber);

    const fileStat = statSync(join(turnDir, result.ref!));
    if (!isWindows) {
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it('accepts Buffer input', async () => {
    const buf = Buffer.alloc(300 * 1024, 'b');
    const result = await maybeOffloadLarge(turnDir, 'tu-buf', 'out', buf, scrubber);

    expect(result.offloaded).toBe(true);
    expect(result.bytes).toBe(buf.length);
  });

  it('exports LARGE_OUTPUT_THRESHOLD as 256KB', () => {
    expect(LARGE_OUTPUT_THRESHOLD).toBe(262144);
  });
});

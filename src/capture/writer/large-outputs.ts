/**
 * Large-output gzip offload.
 * Tool inputs or outputs exceeding the threshold are scrubbed, gzipped,
 * and written to large-outputs/<tool_use_id>.{in,out}.txt.gz.
 * The JSONL line carries an output_ref/input_ref pointer instead of inline content.
 */
import { mkdirSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Scrubber } from '../../scrubber/index.js';

export const LARGE_OUTPUT_THRESHOLD = 262144; // 256 KB

export interface OffloadResult {
  offloaded: boolean;
  ref?: string; // relative path inside turn dir, e.g. 'large-outputs/abc.out.txt.gz'
  bytes?: number; // original byte count (after scrubbing, before compression)
  hitCount: number;
}

/**
 * If the content exceeds the threshold, scrub it, gzip it to disk,
 * and return the relative path. Otherwise return {offloaded: false}.
 */
export async function maybeOffloadLarge(
  turnDir: string,
  toolUseId: string,
  kind: 'in' | 'out',
  rawContent: string | Buffer,
  scrubber: Scrubber,
  threshold: number = LARGE_OUTPUT_THRESHOLD,
): Promise<OffloadResult> {
  // Convert to string for scrubbing
  const contentStr = typeof rawContent === 'string' ? rawContent : rawContent.toString('utf8');

  // Scrub first
  const result = scrubber.scrub({ payload: contentStr });
  const scrubbed = result.scrubbed;
  const hitCount = result.redactionsApplied;

  // Measure after scrubbing
  const buf = Buffer.from(scrubbed, 'utf8');
  if (buf.length < threshold) {
    return { offloaded: false, hitCount };
  }

  // Create large-outputs/ directory
  const largeDir = join(turnDir, 'large-outputs');
  mkdirSync(largeDir, { recursive: true, mode: 0o700 });

  // Write gzipped file
  const fileName = `${toolUseId}.${kind}.txt.gz`;
  const destPath = join(largeDir, fileName);

  await pipeline(Readable.from(buf), createGzip(), createWriteStream(destPath, { mode: 0o600 }));

  return {
    offloaded: true,
    ref: `large-outputs/${fileName}`,
    bytes: buf.length,
    hitCount,
  };
}

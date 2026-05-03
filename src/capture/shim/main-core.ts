import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';
import { isCaptureDisabled } from '../kill-switch.js';

/**
 * Shim hot-path core logic.
 * Accepts spawnWriter + writerEntry as arguments so both production
 * (baked-in WRITER_ENTRY) and bench (env-driven) entrypoints share
 * the same code path.
 */
export default function main(
  spawnWriter: (payloadPath: string, writerEntry: string) => void,
  writerEntry: string,
): void {
  if (isCaptureDisabled(process.env)) {
    // Drain stdin to avoid SIGPIPE on the Claude Code parent
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.exit(0);
    });
    return;
  }

  const chunks: Buffer[] = [];

  process.stdin.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  process.stdin.on('end', () => {
    const payload = Buffer.concat(chunks);
    const tmpRoot = join(homedir(), '.auto-sop', 'tmp');
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });

    const tmpName = nanoid(16) + '.json';
    const tmpPath = join(tmpRoot, tmpName);
    writeFileSync(tmpPath, payload, { mode: 0o600 });

    spawnWriter(tmpPath, writerEntry);
    process.exit(0);
  });
}

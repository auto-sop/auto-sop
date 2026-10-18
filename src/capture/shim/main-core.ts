import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';
import { isCaptureDisabled } from '../kill-switch.js';
import { isEventCapturedInMode, resolveCaptureMode } from '../concurrency-mode.js';
import type { HookEventName } from '../writer/routes/types.js';

/**
 * Whether a hook payload must be handed to a writer process.
 *
 * Spawning the writer is the most expensive thing a hook does — a second node
 * process that loads the full capture bundle and resolves the project via git.
 * In lightweight multi-session mode the writer would only discard per-tool-call
 * events, so the shim drops them itself and never starts that process.
 *
 * Full mode hands off every payload without looking inside it, exactly as
 * before. In lightweight mode only a payload that is a JSON object naming its
 * event is dropped here; anything malformed still goes to the writer, which
 * owns validation and error logging.
 */
export function needsWriter(payload: Buffer, env: NodeJS.ProcessEnv): boolean {
  const mode = resolveCaptureMode(env);
  if (mode === 'full') return true;

  let event: unknown;
  try {
    event = (JSON.parse(payload.toString('utf8')) as { hook_event_name?: unknown })
      ?.hook_event_name;
  } catch {
    return true;
  }
  if (typeof event !== 'string') return true;
  // An unrecognised name is treated like any other event the mode does not list.
  return isEventCapturedInMode(event as HookEventName, mode);
}

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
    if (!needsWriter(payload, process.env)) {
      process.exit(0);
    }

    const tmpRoot = join(homedir(), '.auto-sop', 'tmp');
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });

    const tmpName = nanoid(16) + '.json';
    const tmpPath = join(tmpRoot, tmpName);
    writeFileSync(tmpPath, payload, { mode: 0o600 });

    spawnWriter(tmpPath, writerEntry);
    process.exit(0);
  });
}

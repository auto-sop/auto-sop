/**
 * Append pre/post tool-call lines to tool-calls.jsonl in a turn directory.
 *
 * W4: NO lockfile for turn-local JSONL files.
 * Single-writer-per-turn (Pattern 4) guarantees no concurrent writes;
 * plain O_APPEND via appendFileSync is safe.
 * Lockfile is only needed for the GLOBAL index.jsonl (plan 01-06).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scrubber } from '../../scrubber/index.js';

export const TOOL_CALLS_JSONL = 'tool-calls.jsonl';

export interface PreToolLine {
  event: 'pre';
  tool_use_id: string;
  tool: string;
  input: unknown;
  input_ref?: string;
  bytes?: number;
  t: string;
}

export interface PostToolLine {
  event: 'post';
  tool_use_id: string;
  output?: unknown;
  output_ref?: string;
  input_ref?: string;
  bytes?: number;
  duration_ms?: number;
  success: boolean;
  t: string;
}

/**
 * Ensure the JSONL file exists with 0600 permissions.
 * Uses wx flag exclusively — EEXIST catch handles the race;
 * no separate existsSync stat call needed on the hot path.
 */
function ensureJsonlFile(jsonlPath: string): void {
  try {
    writeFileSync(jsonlPath, '', { mode: 0o600, flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/**
 * Scrub a JSON string, re-parse to verify validity, and return the scrubbed
 * string plus hit count. If scrubbing broke JSON validity, return a safe fallback.
 */
function scrubJsonString(
  jsonStr: string,
  scrubber: Scrubber,
  fallbackObj: Record<string, unknown>,
): { scrubbed: string; hitCount: number } {
  const result = scrubber.scrub({ payload: jsonStr });
  if (result.redactionsApplied === 0) {
    return { scrubbed: jsonStr, hitCount: 0 };
  }
  // Verify scrubbed string is still valid JSON
  try {
    const parsed = JSON.parse(result.scrubbed);
    return { scrubbed: JSON.stringify(parsed), hitCount: result.redactionsApplied };
  } catch {
    // Scrubber broke JSON validity — use fallback
    return {
      scrubbed: JSON.stringify(fallbackObj),
      hitCount: result.redactionsApplied,
    };
  }
}

/**
 * Append a PreToolUse line to tool-calls.jsonl.
 * Scrubs the serialized JSON string before writing.
 */
export function appendPreToolLine(
  turnDir: string,
  line: PreToolLine,
  scrubber: Scrubber,
): { hitCount: number } {
  const jsonlPath = join(turnDir, TOOL_CALLS_JSONL);
  ensureJsonlFile(jsonlPath);

  const raw = JSON.stringify(line);
  const fallback: Record<string, unknown> = {
    event: 'pre',
    tool_use_id: line.tool_use_id,
    tool: line.tool,
    input: '[REDACTION_BROKE_JSON]',
    t: line.t,
  };
  const { scrubbed, hitCount } = scrubJsonString(raw, scrubber, fallback);
  appendFileSync(jsonlPath, scrubbed + '\n', { mode: 0o600 });
  return { hitCount };
}

/**
 * Append a PostToolUse line to tool-calls.jsonl.
 * Scrubs the serialized JSON string before writing.
 */
export function appendPostToolLine(
  turnDir: string,
  line: PostToolLine,
  scrubber: Scrubber,
): { hitCount: number } {
  const jsonlPath = join(turnDir, TOOL_CALLS_JSONL);
  ensureJsonlFile(jsonlPath);

  const raw = JSON.stringify(line);
  const fallback: Record<string, unknown> = {
    event: 'post',
    tool_use_id: line.tool_use_id,
    output: '[REDACTION_BROKE_JSON]',
    success: line.success,
    t: line.t,
  };
  const { scrubbed, hitCount } = scrubJsonString(raw, scrubber, fallback);
  appendFileSync(jsonlPath, scrubbed + '\n', { mode: 0o600 });
  return { hitCount };
}

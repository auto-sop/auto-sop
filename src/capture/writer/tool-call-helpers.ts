/**
 * Shared tool-call event processing for both main-thread and subagent routes.
 *
 * Eliminates ~120 lines of duplication between tool-calls-route.ts and subagent-route.ts.
 * Preserves all behavior: large-output offloading, scrubber hit tracking, meta updates.
 */
import type { PreToolUsePayload, PostToolUsePayload } from '../events.js';
import type { Scrubber } from '../../scrubber/index.js';
import { appendPreToolLine, appendPostToolLine } from './tool-calls.js';
import type { PreToolLine, PostToolLine } from './tool-calls.js';
import { maybeOffloadLarge, LARGE_OUTPUT_THRESHOLD } from './large-outputs.js';
import { updateMeta, readMeta } from './meta.js';

/**
 * Process a PreToolUse event: offload large input if needed, scrub, append to JSONL, update meta.
 */
export async function processPreToolEvent(
  turnDir: string,
  event: PreToolUsePayload,
  scrubber: Scrubber,
): Promise<void> {
  const now = new Date().toISOString();
  const inputStr = JSON.stringify(event.tool_input ?? null);

  const offload = await maybeOffloadLarge(
    turnDir,
    event.tool_use_id,
    'in',
    inputStr,
    scrubber,
    LARGE_OUTPUT_THRESHOLD,
  );

  let line: PreToolLine;
  if (offload.offloaded && offload.ref && offload.bytes) {
    line = {
      event: 'pre',
      tool_use_id: event.tool_use_id,
      tool: event.tool_name,
      input: null,
      input_ref: offload.ref,
      bytes: offload.bytes,
      t: now,
    };
  } else {
    line = {
      event: 'pre',
      tool_use_id: event.tool_use_id,
      tool: event.tool_name,
      input: event.tool_input,
      t: now,
    };
  }

  const { hitCount: appendHits } = appendPreToolLine(turnDir, line, scrubber);

  const totalHits = offload.hitCount + appendHits;
  if (totalHits > 0) {
    const meta = readMeta(turnDir);
    if (meta) {
      updateMeta(turnDir, {
        scrubber_hit_count: (meta.scrubber_hit_count ?? 0) + totalHits,
      });
    }
  }
}

/**
 * Process a PostToolUse event: offload large output if needed, scrub, append to JSONL,
 * bump tool_call_count + scrubber hits in meta.
 */
export async function processPostToolEvent(
  turnDir: string,
  event: PostToolUsePayload,
  scrubber: Scrubber,
): Promise<void> {
  const now = new Date().toISOString();
  const responseStr = JSON.stringify(event.tool_response ?? null);

  const offload = await maybeOffloadLarge(
    turnDir,
    event.tool_use_id,
    'out',
    responseStr,
    scrubber,
    LARGE_OUTPUT_THRESHOLD,
  );

  const success = event.tool_response !== undefined && event.tool_response !== null;

  let line: PostToolLine;
  if (offload.offloaded && offload.ref && offload.bytes) {
    line = {
      event: 'post',
      tool_use_id: event.tool_use_id,
      output_ref: offload.ref,
      bytes: offload.bytes,
      success,
      t: now,
    };
  } else {
    line = {
      event: 'post',
      tool_use_id: event.tool_use_id,
      output: event.tool_response,
      success,
      t: now,
    };
  }

  const { hitCount: appendHits } = appendPostToolLine(turnDir, line, scrubber);

  const meta = readMeta(turnDir);
  if (meta) {
    const totalHits = offload.hitCount + appendHits;
    updateMeta(turnDir, {
      tool_call_count: (meta.tool_call_count ?? 0) + 1,
      scrubber_hit_count: (meta.scrubber_hit_count ?? 0) + totalHits,
    });
  }
}

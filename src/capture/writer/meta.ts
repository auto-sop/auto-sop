/**
 * Turn meta.json lifecycle: start, update, finalize.
 * All writes are atomic (temp file + rename) — readers never see half-written meta.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_META_SCHEMA_VERSION, type TurnMeta } from '../types.js';
import type { HookPayloadType } from '../events.js';

export interface StartMetaParams {
  projectId: string;
  projectSlug: string;
  turnId: string;
  agent: string;
  subagentType: string | null;
  hookShimVersion: string;
}

/**
 * Create a fresh TurnMeta for the start of a turn.
 */
export function startMeta(payload: HookPayloadType, params: StartMetaParams): TurnMeta {
  return {
    schema_version: TURN_META_SCHEMA_VERSION as 1,
    project_id: params.projectId,
    project_slug: params.projectSlug,
    session_id: payload.session_id,
    turn_id: params.turnId,
    parent_turn_id: null,
    children_turn_ids: [],
    agent: params.agent,
    subagent_type: params.subagentType,
    started_at: new Date().toISOString(),
    finalized_at: null,
    finalization_reason: null,
    hook_shim_version: params.hookShimVersion,
    files_changed_count: 0,
    tool_call_count: 0,
    scrubber_hit_count: 0,
  };
}

/**
 * Atomically write meta.json to a turn directory (temp file + rename).
 */
export function writeMeta(turnDir: string, meta: TurnMeta): void {
  const metaPath = join(turnDir, 'meta.json');
  const tmpPath = join(turnDir, 'meta.json.tmp');
  writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpPath, metaPath);
}

/**
 * Read meta.json from a turn directory, or null if missing.
 */
export function readMeta(turnDir: string): TurnMeta | null {
  try {
    const raw = readFileSync(join(turnDir, 'meta.json'), 'utf8');
    return JSON.parse(raw) as TurnMeta;
  } catch {
    return null;
  }
}

/**
 * Read → merge partial → atomic write. Returns the updated meta.
 */
export function updateMeta(turnDir: string, patch: Partial<TurnMeta>): TurnMeta {
  const existing = readMeta(turnDir);
  if (!existing) {
    throw new Error(`meta.json not found in ${turnDir}`);
  }
  const updated: TurnMeta = { ...existing, ...patch };
  writeMeta(turnDir, updated);
  return updated;
}

/**
 * Finalize meta: set finalized_at and finalization_reason, then atomic write.
 */
export function finalizeMeta(
  turnDir: string,
  reason: 'stop' | 'subagent_stop' | 'timeout',
): TurnMeta {
  return updateMeta(turnDir, {
    finalized_at: new Date().toISOString(),
    finalization_reason: reason,
  });
}

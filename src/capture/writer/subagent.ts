/**
 * Subagent turn resolution and bidirectional parent-child linking.
 *
 * Each subagent (identified by session_id + agent_id) gets its own turn directory.
 * State markers: current-turn-<session_id>-<agent_id>.json in the state dir.
 *
 * Linking is bidirectional:
 *   - Child meta has parent_turn_id pointing to its parent turn
 *   - Parent meta has children_turn_ids[] containing all child turn IDs
 *
 * Unlimited nesting depth (E1): any subagent can spawn further subagents.
 * No depth cap in meta (E4: minimal).
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnMeta } from '../types.js';
import { readMeta, updateMeta } from './meta.js';
import type { CurrentTurnState } from './turn-dir.js';

/**
 * Resolve the currently-active subagent turn for a given session + agent.
 * Returns null if no marker exists (subagent not yet started).
 */
export function resolveSubagentTurn(
  stateDir: string,
  sessionId: string,
  agentId: string,
): CurrentTurnState | null {
  const markerPath = join(stateDir, `current-turn-${sessionId}-${agentId}.json`);
  try {
    const raw = readFileSync(markerPath, 'utf8');
    return JSON.parse(raw) as CurrentTurnState;
  } catch {
    return null;
  }
}

/**
 * Atomically write the current-turn marker for a subagent (temp + rename).
 */
export function setSubagentCurrentTurn(
  stateDir: string,
  sessionId: string,
  agentId: string,
  data: CurrentTurnState,
): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const markerPath = join(stateDir, `current-turn-${sessionId}-${agentId}.json`);
  const tmpPath = markerPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmpPath, markerPath);
}

/**
 * Remove the subagent current-turn marker. Ignores ENOENT.
 */
export function clearSubagentCurrentTurn(
  stateDir: string,
  sessionId: string,
  agentId: string,
): void {
  const markerPath = join(stateDir, `current-turn-${sessionId}-${agentId}.json`);
  try {
    unlinkSync(markerPath);
  } catch {
    // ENOENT or other — ignore
  }
}

/**
 * Bidirectional linking: append the child's turn_id to the parent's
 * meta.children_turn_ids (read-modify-write, deduped).
 *
 * If parentTurnDir is null, the child is an orphan subagent — no linking performed.
 */
export function linkChildToParent(childMeta: TurnMeta, parentTurnDir: string | null): void {
  if (!parentTurnDir) return; // orphan subagent — no parent found
  const parent = readMeta(parentTurnDir);
  if (!parent) return;
  const updated = {
    children_turn_ids: Array.from(
      new Set([...(parent.children_turn_ids ?? []), childMeta.turn_id]),
    ),
  };
  updateMeta(parentTurnDir, updated);
}

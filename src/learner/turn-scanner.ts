/**
 * Turn Scanner — walks project captures directory, reads meta.json for each turn.
 * Skips .pending dirs and poison (unparseable) meta.json files.
 * Filters by finalized_at > cursor.last_finalized_at (ISO8601 string compare).
 * Returns sorted (ascending) summaries, bounded by maxTurns.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnMeta } from '../capture/types.js';

// ── Types ──────────────────────────────────────────────────

export interface TurnSummary {
  turn_id: string;
  finalized_at: string;
  tool_call_count: number;
  scrubber_hit_count: number;
  files_changed_count: number;
  finalization_reason: string | null;
  turn_dir: string;
}

export interface ScanResult {
  turns: TurnSummary[];
  skipped_pending: number;
  skipped_poison: number;
  /**
   * Max finalized_at across the turns returned in this scan (ISO8601
   * string). Null when `turns` is empty. Used by the directive builder
   * so the rendered body carries a data-anchored timestamp instead of
   * wall-clock `Date.now()` — consecutive ticks over identical inputs
   * therefore produce byte-identical bodies (B4 fix).
   */
  newestTurnFinalizedAt: string | null;
}

// ── Scanner ────────────────────────────────────────────────

export function scanNewTurns(
  capturesDir: string,
  lastFinalizedAt: string,
  maxTurns: number = 500,
): ScanResult {
  const turns: TurnSummary[] = [];
  let skipped_pending = 0;
  let skipped_poison = 0;

  let entries: string[];
  try {
    entries = readdirSync(capturesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // captures dir doesn't exist or can't be read → empty scan
    return {
      turns: [],
      skipped_pending: 0,
      skipped_poison: 0,
      newestTurnFinalizedAt: null,
    };
  }

  for (const dirName of entries) {
    // Skip .pending turns (still being written)
    if (dirName.endsWith('.pending')) {
      skipped_pending++;
      continue;
    }

    const turnDir = join(capturesDir, dirName);
    const metaPath = join(turnDir, 'meta.json');

    let meta: TurnMeta;
    try {
      const raw = readFileSync(metaPath, 'utf8');
      meta = JSON.parse(raw) as TurnMeta;
    } catch {
      skipped_poison++;
      continue;
    }

    // Must be finalized
    if (!meta.finalized_at) continue;

    // Filter by cursor (ISO8601 string compare)
    if (lastFinalizedAt && meta.finalized_at <= lastFinalizedAt) continue;

    turns.push({
      turn_id: meta.turn_id,
      finalized_at: meta.finalized_at,
      tool_call_count: meta.tool_call_count ?? 0,
      scrubber_hit_count: meta.scrubber_hit_count ?? 0,
      files_changed_count: meta.files_changed_count ?? 0,
      finalization_reason: meta.finalization_reason ?? null,
      turn_dir: turnDir,
    });
  }

  // Sort ascending by finalized_at
  turns.sort((a, b) => a.finalized_at.localeCompare(b.finalized_at));

  // Bound to maxTurns (slice FIRST so the newest-timestamp we report
  // matches the newest turn that callers will actually see).
  const bounded = turns.slice(0, maxTurns);

  // Compute max finalized_at across the bounded turn set. Because
  // `bounded` is already sorted ascending, the last element is the
  // max; falls back to null when the set is empty.
  const newestTurnFinalizedAt =
    bounded.length > 0 ? bounded[bounded.length - 1]!.finalized_at : null;

  return {
    turns: bounded,
    skipped_pending,
    skipped_poison,
    newestTurnFinalizedAt,
  };
}

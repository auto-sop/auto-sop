/**
 * Recap Log — appends JSON-line recap entries to ~/.auto-sop/logs/recap.log.
 * 10MB rotation: stat before append, if >10_000_000 bytes rename to recap.log.1 (overwrite).
 * Each line is one JSON object (per-project recap or tick summary).
 */
import { appendFileSync, statSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ──────────────────────────────────────────────

const MAX_RECAP_BYTES = 10_000_000; // 10MB

// ── Types ──────────────────────────────────────────────────

export interface PerProjectRecap {
  v: 1;
  t: string; // ISO8601
  tick_id: string;
  project_id: string;
  project_slug: string;
  turns_new: number;
  turns_total_seen: number;
  tool_calls_new: number;
  scrubber_hits_new: number;
  files_changed_new: number;
  finalization_failures_new: number;
  skipped_poison: number;
  oldest_new_turn_at: string | null;
  newest_new_turn_at: string | null;
  duration_ms: number;
  llm_mode: boolean;
  directive_written?:
    | 'created'
    | 'updated'
    | 'unchanged'
    | 'dry_run'
    | 'error'
    | 'drift_aborted'
    | 'git_busy'
    | null;
  directive_bytes?: number;
  directive_backup?: boolean;
  /** Number of validated directive proposals written to the managed section. */
  directives_active?: number;
  /** Number of below-threshold candidate patterns (1-2 sessions). */
  directives_candidates?: number;
  /** Count of detectors that executed this tick. */
  detectors_run?: number;
  /** Count of detectors that threw during execution (fail-open). */
  detectors_failed?: number;
  /**
   * (E4) Number of proposals dropped by the semantic-fingerprint dedup
   * pass — the total count of losers across all duplicate groups. Does
   * NOT include id-based dedup losses or items dropped by the cap.
   */
  merge_deduped_count?: number;
  /**
   * (E5) Number of directives the history module pruned from the active
   * set this tick — the difference between "proposals that reached the
   * history stage" and "directives that actually rendered into CLAUDE.md".
   * Includes both TTL expiries and cap overflow.
   */
  directives_pruned_count?: number;

  // ── LLM analysis fields (PLAN-v14) ────────────────────────
  // All optional so existing recap entries deserialize unchanged.
  /** How long the `claude -p` subprocess took, in ms. 0 when offline. */
  llm_duration_ms?: number;
  /** Count of directives the LLM proposed before schema validation. */
  llm_directives_proposed?: number;
  /** Count of LLM directives that survived schema + merge into the final
   *  managed-section payload. */
  llm_directives_accepted?: number;
  /** Count of LLM directives that were rejected or dropped post-proposal. */
  llm_directives_rejected?: number;
  /** Stable error code emitted by runLlmAnalysis (e.g. 'claude_not_found',
   *  'timeout', 'claude_exit_1'). `null`/`undefined` when the call
   *  succeeded. */
  llm_error?: string | null;
  /** True when the LLM call errored and we fell back to rule-based only.
   *  Intentionally NOT set for optimization skips (e.g. turns_new == 0)
   *  — those are captured in `llm_skipped` instead. */
  llm_fallback?: boolean;

  // ── Incremental candidate fields (PLAN-v29) ──────────────
  /** Count of new pattern candidates extracted by the LLM this tick. */
  llm_candidates_new?: number;
  /** Count of existing candidates the LLM matched against new turns. */
  llm_candidates_matched?: number;
  /** Count of candidates that graduated to directives this tick. */
  llm_candidates_graduated?: number;
  /** Total candidates in the store after this tick (including graduated). */
  llm_candidates_total?: number;

  // ── LLM skip optimization (PLAN-v17 I8) ──────────────────
  /**
   * Optimization code indicating why the LLM was skipped this tick
   * (not an error). Current values:
   *   - 'no_new_turns' — scan.turns_new === 0 and CLAUDE_SOP_FORCE_LLM
   *     was not set, so we short-circuited before spawning `claude -p`.
   *   - 'just_restored' — directives were restored from a previous install
   *     (I9), so LLM analysis is skipped to prevent false-negative heuristic.
   * `undefined` when the LLM actually ran (or failed while running).
   */
  llm_skipped?: 'no_new_turns' | 'just_restored' | null;
}

export interface TickSummary {
  v: 1;
  t: string; // ISO8601
  tick_id: string;
  summary: true;
  projects_processed: number;
  projects_skipped: number;
  projects_locked: number;
  projects_missing: number;
  total_turns_new: number;
  total_duration_ms: number;
  errors: string[];
  /**
   * (PLAN-v17 I6) True when the learner was killed by the 600s
   * hard-timeout watchdog. The summary is a "partial" recap written
   * from the timeout handler — counts are best-effort and may be zero
   * because the timeout can fire before any project is processed.
   * Absent/undefined on normal ticks.
   */
  hard_timeout?: boolean;
}

// ── Paths ──────────────────────────────────────────────────

export function recapLogPath(home?: string): string {
  return join(home ?? homedir(), '.auto-sop', 'logs', 'recap.log');
}

// ── Rotation ───────────────────────────────────────────────

function rotateIfNeeded(logPath: string): void {
  try {
    if (!existsSync(logPath)) return;
    const { size } = statSync(logPath);
    if (size >= MAX_RECAP_BYTES) {
      renameSync(logPath, logPath + '.1');
    }
  } catch {
    // rotation failure is non-fatal
  }
}

// ── Append ─────────────────────────────────────────────────

export function appendRecap(entry: PerProjectRecap | TickSummary, home?: string): void {
  const logPath = recapLogPath(home);
  mkdirSync(dirname(logPath), { recursive: true });
  rotateIfNeeded(logPath);
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(logPath, line, { mode: 0o600 });
}

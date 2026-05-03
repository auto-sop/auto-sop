/**
 * Stats aggregation — computes per-project metrics from directive-fire events,
 * directive history, error prevention data, and session metrics.
 *
 * Entry point: {@link aggregateStats} reads fire events (filtered by `since`),
 * groups them by directive, looks up rule_text from directive history, and
 * returns a {@link ProjectStats} object ready for CLI display or JSON output.
 *
 * V31: adds fires_by_category, real_errors_prevented, session_comparison,
 * and severity on per-directive entries.
 *
 * Dependencies:
 *   - readFires() from capture/writer/directive-fire.ts (fire event I/O)
 *   - loadHistory() from managed-section/directive-history.ts (directive metadata)
 *   - readPreventedErrors() from learner/error-prevention.ts (error prevention I/O)
 *   - buildSessionSummaries, compareBeforeAfter from learner/session-metrics.ts
 *   - loadTurnsForDetection from learner/turn-loader.ts
 */
import { readFires, type FireCategory } from '../../capture/writer/directive-fire.js';
import { loadHistory } from '../../managed-section/directive-history.js';
import { readPreventedErrors } from '../../learner/error-prevention.js';
import {
  buildSessionSummaries,
  compareBeforeAfter,
  estimateTokenSavings,
  type BeforeAfterComparison,
} from '../../learner/session-metrics.js';
import { readSyncEntries } from '../../learner/sync-queue.js';
import { loadTurnsForDetection } from '../../learner/turn-loader.js';
import { shortDirectiveId } from '../../learner/directive-builder.js';
import { countPreventedSince } from '../../metrics/error-prevention.js';
import { calculateTimeSavings } from '../../metrics/time-savings.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadMetricsState } from '../../metrics/state.js';

// ─── Constants ───────────────────────────────────────────

const DEFAULT_MINUTES_PER_ERROR = 15;
const DEFAULT_SINCE_DAYS = 30;
const PREVIEW_MAX_LENGTH = 80;
/** Max turns to load for session comparison — matches learner MAX_TURNS_FIRST_RUN */
const MAX_TURNS_FOR_STATS = 500;

// ─── Types ───────────────────────────────────────────────

export interface FireByDirective {
  directive_id: string;
  rule_text_preview: string;
  fire_count: number;
  last_fired: string;
  /** V31: directive severity (for emoji display). */
  severity?: 'error' | 'warning' | 'info';
}

export interface FiresByCategory {
  error_preventing: number;
  efficiency: number;
  best_practice: number;
}

export interface ProjectStats {
  project_path: string;
  project_slug: string;
  period: { since: string; until: string };
  total_fires: number;
  unique_directives_fired: number;
  active_directives: number;
  fires_by_directive: FireByDirective[];
  estimated_errors_prevented: number;
  estimated_minutes_saved: number;
  ticks_in_period: number;
  /** V31: fires grouped by category. */
  fires_by_category: FiresByCategory;
  /** V31: count of real errors prevented (from error-prevention.jsonl). */
  real_errors_prevented: number;
  /** V31: before/after session comparison. Null if insufficient data. */
  session_comparison: BeforeAfterComparison | null;
  /** V32: number of entries in the sync queue (pending cloud push). */
  sync_queue_size: number;
  /** V32-P7: errors prevented this month (from error-prevention metrics). */
  errors_prevented_this_month: number;
  /** V32-P7: time saved from session duration comparison (minutes). Null if insufficient data. */
  duration_time_saved_minutes: number | null;
  /** V32-P7: token savings from session comparison. Null if insufficient data. */
  token_savings_total: number | null;
  /** V32-P7: token savings percentage. Null if insufficient data. */
  token_savings_pct: number | null;
  /** V44: estimation method used for token savings. */
  token_estimation_method: 'byte_counted' | 'tool_call_heuristic' | 'hybrid' | null;
  /** V46: total confirmed directive fires from Claude self-reports. */
  confirmed_fires_total: number;
  /** V46: per-directive confirmed fire counts with rule text. */
  confirmed_fires_by_directive: Array<{
    directive_id: string;
    rule_text_preview: string;
    fire_count: number;
  }>;
  /** V48: short ID → first ~10 words of rule_text (from MetricsState). */
  directive_previews: Record<string, string>;
  /** V53: confidence level for time-saved estimate. */
  confidence: 'low' | 'medium' | 'high';
  /** V53: number of baseline sessions used to derive confidence. */
  baseline_sessions: number;
}

export interface AggregateStatsOptions {
  stateDir: string;
  projectRoot: string;
  projectSlug: string;
  since?: string;
  minutesPerError?: number;
  /** Home directory for MetricsState lookup. Defaults to os.homedir(). */
  homeDir?: string;
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Truncate text to `maxLen` chars, appending '…' if truncated.
 */
function truncatePreview(text: string, maxLen: number = PREVIEW_MAX_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Compute a default "since" ISO string: 30 days before now.
 */
function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - DEFAULT_SINCE_DAYS);
  return d.toISOString();
}

/**
 * Map fire category string to FiresByCategory key.
 * Falls back to 'best_practice' for old fires without category.
 */
function categoryKey(category?: FireCategory): keyof FiresByCategory {
  switch (category) {
    case 'error-preventing':
      return 'error_preventing';
    case 'efficiency':
      return 'efficiency';
    case 'best-practice':
      return 'best_practice';
    default:
      return 'best_practice';
  }
}

// ─── Aggregation ─────────────────────────────────────────

/**
 * Aggregate stats from directive-fire events and directive history.
 *
 * Reads fires from `stateDir` (filtered by `since`), groups by directive_id,
 * looks up rule_text from directive history at `projectRoot`, and computes
 * estimated metrics.
 *
 * V31: adds category grouping, real error prevention count, and session comparison.
 */
export function aggregateStats(opts: AggregateStatsOptions): ProjectStats {
  const since = opts.since ?? defaultSince();
  const minutesPerError = opts.minutesPerError ?? DEFAULT_MINUTES_PER_ERROR;
  const now = new Date().toISOString();

  // Read fire events (filtered by since)
  const fires = readFires(opts.stateDir, since);

  // Load directive history for rule_text lookup and active count
  const history = loadHistory(opts.projectRoot);
  const activeDirectives = Object.values(history.entries).filter((e) => !e.pruned).length;

  // Build a rule_text + severity lookup map from history entries
  const ruleTextMap = new Map<string, string>();
  const severityMap = new Map<string, 'error' | 'warning' | 'info'>();
  for (const entry of Object.values(history.entries)) {
    const shortId = shortDirectiveId(entry.id);
    ruleTextMap.set(entry.id, entry.rule_text);
    ruleTextMap.set(shortId, entry.rule_text);
    severityMap.set(entry.id, entry.severity);
    severityMap.set(shortId, entry.severity);
  }

  // Group fires by directive_id + count by category
  const grouped = new Map<string, { count: number; lastFired: string }>();
  const firesByCategory: FiresByCategory = {
    error_preventing: 0,
    efficiency: 0,
    best_practice: 0,
  };

  for (const fire of fires) {
    const existing = grouped.get(fire.directive_id);
    if (existing !== undefined) {
      existing.count++;
      if (fire.t > existing.lastFired) {
        existing.lastFired = fire.t;
      }
    } else {
      grouped.set(fire.directive_id, { count: 1, lastFired: fire.t });
    }

    // V31: group by category
    const key = categoryKey(fire.category);
    firesByCategory[key]++;
  }

  // Build fires_by_directive sorted by count descending
  const firesByDirective: FireByDirective[] = [];
  for (const [directiveId, data] of grouped) {
    const ruleText = ruleTextMap.get(directiveId) ?? '(unknown directive)';
    const entry: FireByDirective = {
      directive_id: directiveId,
      rule_text_preview: truncatePreview(ruleText),
      fire_count: data.count,
      last_fired: data.lastFired,
    };
    const severity = severityMap.get(directiveId);
    if (severity !== undefined) {
      entry.severity = severity;
    }
    firesByDirective.push(entry);
  }

  // Sort by fire_count descending, then directive_id ascending for stability
  firesByDirective.sort((a, b) => {
    const countDiff = b.fire_count - a.fire_count;
    if (countDiff !== 0) return countDiff;
    return a.directive_id.localeCompare(b.directive_id);
  });

  const totalFires = fires.length;

  // Read error prevention data once (reused by V31 + P7 blocks)
  let preventedErrors: ReturnType<typeof readPreventedErrors> = [];
  try {
    preventedErrors = readPreventedErrors(opts.stateDir);
  } catch {
    // graceful degradation — no prevention data yet
  }

  // V31: Real error prevention count (filtered by since)
  const filteredPrevented = since
    ? preventedErrors.filter((pe) => pe.t >= since)
    : preventedErrors;
  const realErrorsPrevented = filteredPrevented.length;

  // Load turn data once — shared by session comparison and V46 confirmed fires
  let sharedTurnData: ReturnType<typeof loadTurnsForDetection> = [];
  try {
    const capturesDir = join(opts.projectRoot, '.auto-sop', 'captures');
    if (existsSync(capturesDir)) {
      sharedTurnData = loadTurnsForDetection(capturesDir, MAX_TURNS_FOR_STATS);
    }
  } catch {
    // graceful degradation — no capture data yet
  }

  // V31: Build session comparison
  let sessionComparison: BeforeAfterComparison | null = null;
  try {
    if (sharedTurnData.length > 0) {
      const sessions = buildSessionSummaries(sharedTurnData);
      // Use earliest directive first_seen as the cutoff
      let earliestFirstSeen: string | null = null;
      for (const entry of Object.values(history.entries)) {
        if (!entry.pruned) {
          if (earliestFirstSeen === null || entry.first_seen < earliestFirstSeen) {
            earliestFirstSeen = entry.first_seen;
          }
        }
      }
      if (earliestFirstSeen !== null) {
        sessionComparison = compareBeforeAfter(sessions, earliestFirstSeen);
      }
    }
  } catch {
    // graceful degradation — no session data yet
  }

  // V32-P7: metrics from new metrics modules (supersedes old V32 token estimate)
  const p7TimeSavings = calculateTimeSavings(sessionComparison);
  // V44: unified token estimation (byte_counted → hybrid → tool_call_heuristic)
  const tokenEstimate = estimateTokenSavings(sessionComparison);

  // V32: Sync queue size
  let syncQueueSize = 0;
  try {
    const syncEntries = readSyncEntries(opts.stateDir);
    syncQueueSize = syncEntries.length;
  } catch {
    // graceful degradation — no sync queue yet
  }

  // V32-P7: Errors prevented this month (reuses preventedErrors read above)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const errorsPreventedThisMonth = countPreventedSince(preventedErrors, thirtyDaysAgo);

  // V46: Accumulate confirmed fires from shared turn data (self-reported by Claude)
  let confirmedFiresTotal = 0;
  const confirmedByDirective = new Map<string, number>();
  for (const turn of sharedTurnData) {
    if (Array.isArray(turn.self_reported_fires)) {
      for (const id of turn.self_reported_fires) {
        confirmedFiresTotal++;
        confirmedByDirective.set(id, (confirmedByDirective.get(id) ?? 0) + 1);
      }
    }
  }

  // Build confirmed fires by directive with rule text previews
  const confirmedFiresByDirective: Array<{
    directive_id: string;
    rule_text_preview: string;
    fire_count: number;
  }> = [];
  for (const [directiveId, count] of confirmedByDirective) {
    const ruleText = ruleTextMap.get(directiveId) ?? '(unknown directive)';
    confirmedFiresByDirective.push({
      directive_id: directiveId,
      rule_text_preview: truncatePreview(ruleText),
      fire_count: count,
    });
  }
  confirmedFiresByDirective.sort((a, b) => b.fire_count - a.fire_count);

  // V48: Load directive previews + V53: confidence from persisted MetricsState
  let directivePreviews: Record<string, string> = {};
  let confidence: 'low' | 'medium' | 'high' = 'low';
  let baselineSessions = 0;
  try {
    const home = opts.homeDir ?? homedir();
    const metrics = loadMetricsState(home, opts.projectRoot);
    if (metrics?.directive_previews !== undefined) {
      directivePreviews = metrics.directive_previews;
    }
    if (metrics?.confidence !== undefined) {
      confidence = metrics.confidence;
    }
    if (metrics?.baseline_sessions !== undefined) {
      baselineSessions = metrics.baseline_sessions;
    }
  } catch {
    // graceful degradation — no previews yet
  }

  return {
    project_path: opts.projectRoot,
    project_slug: opts.projectSlug,
    period: { since, until: now },
    total_fires: totalFires,
    unique_directives_fired: grouped.size,
    active_directives: activeDirectives,
    fires_by_directive: firesByDirective,
    estimated_errors_prevented: totalFires,
    estimated_minutes_saved: totalFires * minutesPerError,
    ticks_in_period: 0,
    fires_by_category: firesByCategory,
    real_errors_prevented: realErrorsPrevented,
    session_comparison: sessionComparison,
    sync_queue_size: syncQueueSize,
    errors_prevented_this_month: errorsPreventedThisMonth,
    duration_time_saved_minutes: p7TimeSavings?.total_minutes_saved ?? null,
    token_savings_total: tokenEstimate?.savings_per_session ?? null,
    token_savings_pct: tokenEstimate?.savings_pct ?? null,
    token_estimation_method: tokenEstimate?.method ?? null,
    confirmed_fires_total: confirmedFiresTotal,
    confirmed_fires_by_directive: confirmedFiresByDirective,
    directive_previews: directivePreviews,
    confidence,
    baseline_sessions: baselineSessions,
  };
}

/**
 * Stats aggregation — computes per-project metrics from directive-fire events
 * and directive history.
 *
 * Entry point: {@link aggregateStats} reads fire events (filtered by `since`),
 * groups them by directive, looks up rule_text from directive history, and
 * returns a {@link ProjectStats} object ready for CLI display or JSON output.
 *
 * Dependencies:
 *   - readFires() from capture/writer/directive-fire.ts (fire event I/O)
 *   - loadHistory() from managed-section/directive-history.ts (directive metadata)
 */
import { readFires } from '../../capture/writer/directive-fire.js';
import { loadHistory } from '../../managed-section/directive-history.js';

// ─── Constants ───────────────────────────────────────────

const DEFAULT_MINUTES_PER_ERROR = 15;
const DEFAULT_SINCE_DAYS = 30;
const PREVIEW_MAX_LENGTH = 80;

// ─── Types ───────────────────────────────────────────────

export interface FireByDirective {
  directive_id: string;
  rule_text_preview: string;
  fire_count: number;
  last_fired: string;
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
}

export interface AggregateStatsOptions {
  stateDir: string;
  projectRoot: string;
  projectSlug: string;
  since?: string;
  minutesPerError?: number;
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

// ─── Aggregation ─────────────────────────────────────────

/**
 * Aggregate stats from directive-fire events and directive history.
 *
 * Reads fires from `stateDir` (filtered by `since`), groups by directive_id,
 * looks up rule_text from directive history at `projectRoot`, and computes
 * estimated metrics.
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

  // Build a rule_text lookup map from history entries
  const ruleTextMap = new Map<string, string>();
  for (const entry of Object.values(history.entries)) {
    ruleTextMap.set(entry.id, entry.rule_text);
  }

  // Group fires by directive_id
  const grouped = new Map<string, { count: number; lastFired: string }>();
  for (const fire of fires) {
    const existing = grouped.get(fire.directive_id);
    if (existing !== undefined) {
      existing.count++;
      // Track the latest fire timestamp
      if (fire.t > existing.lastFired) {
        existing.lastFired = fire.t;
      }
    } else {
      grouped.set(fire.directive_id, { count: 1, lastFired: fire.t });
    }
  }

  // Build fires_by_directive sorted by count descending
  const firesByDirective: FireByDirective[] = [];
  for (const [directiveId, data] of grouped) {
    const ruleText = ruleTextMap.get(directiveId) ?? '(unknown directive)';
    firesByDirective.push({
      directive_id: directiveId,
      rule_text_preview: truncatePreview(ruleText),
      fire_count: data.count,
      last_fired: data.lastFired,
    });
  }

  // Sort by fire_count descending, then directive_id ascending for stability
  firesByDirective.sort((a, b) => {
    const countDiff = b.fire_count - a.fire_count;
    if (countDiff !== 0) return countDiff;
    return a.directive_id.localeCompare(b.directive_id);
  });

  const totalFires = fires.length;

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
    ticks_in_period: 0, // placeholder — can be enhanced from recap.log
  };
}

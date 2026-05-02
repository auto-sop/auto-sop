/**
 * Unit tests for src/cli/stats/aggregator.ts
 *
 * Covers:
 *   - Aggregation with sample fire data
 *   - Empty fires
 *   - Missing history file
 *   - since filter (only count fires after date)
 *   - Correct sorting (most fires first)
 *   - rule_text_preview truncation at 80 chars
 *   - Multiple directives with varying fire counts
 *   - Default minutesPerError = 15
 *   - Unknown directives (not in history) get fallback preview
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateStats, type ProjectStats } from '../../../src/cli/stats/aggregator.js';
import type { DirectiveFire } from '../../../src/capture/writer/directive-fire.js';
import type { DirectiveHistory } from '../../../src/managed-section/directive-history.js';
import { saveMetricsState, emptyMetricsState } from '../../../src/metrics/state.js';

// ─── Helpers ─────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-stats-'));
}

function stateDir(root: string): string {
  return join(root, '.auto-sop', 'state');
}

function writeFires(root: string, fires: DirectiveFire[]): void {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const lines = fires.map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(join(dir, 'directive-fires.jsonl'), lines);
}

function writeHistory(root: string, history: DirectiveHistory): void {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'directive-history.json'), JSON.stringify(history));
}

function makeFire(overrides: Partial<DirectiveFire> = {}): DirectiveFire {
  return {
    t: '2026-04-10T12:00:00.000Z',
    directive_id: 'det-default',
    session_id: 'sess-001',
    project_id: 'proj-001',
    keyword_hits: 3,
    keyword_total: 5,
    match_ratio: 0.6,
    ...overrides,
  };
}

function makeHistory(
  entries: Record<
    string,
    {
      rule_text: string;
      severity?: 'error' | 'warning' | 'info';
      pruned?: boolean;
    }
  >,
): DirectiveHistory {
  const histEntries: Record<string, DirectiveHistory['entries'][string]> = {};
  for (const [id, val] of Object.entries(entries)) {
    histEntries[id] = {
      id,
      rule_text: val.rule_text,
      severity: val.severity ?? 'warning',
      first_seen: '2026-01-01T00:00:00.000Z',
      last_reinforced: '2026-04-01T00:00:00.000Z',
      occurrence_count: 1,
      pruned: val.pruned ?? false,
    };
  }
  return { entries: histEntries, updated_at: '2026-04-01T00:00:00.000Z' };
}

// ─── Tests ───────────────────────────────────────────────

describe('aggregateStats', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('aggregates fire data with sample fires and history', () => {
    const fires = [
      makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' }),
      makeFire({ directive_id: 'det-a', t: '2026-04-10T11:00:00.000Z' }),
      makeFire({ directive_id: 'det-b', t: '2026-04-10T12:00:00.000Z' }),
    ];
    writeFires(root, fires);
    writeHistory(
      root,
      makeHistory({
        'det-a': { rule_text: 'Never use var, always use const or let.' },
        'det-b': { rule_text: 'Always validate input before processing.' },
      }),
    );

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'test-project',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.total_fires).toBe(3);
    expect(stats.unique_directives_fired).toBe(2);
    expect(stats.active_directives).toBe(2);
    expect(stats.fires_by_directive).toHaveLength(2);
    expect(stats.fires_by_directive[0]!.directive_id).toBe('det-a');
    expect(stats.fires_by_directive[0]!.fire_count).toBe(2);
    expect(stats.fires_by_directive[1]!.directive_id).toBe('det-b');
    expect(stats.fires_by_directive[1]!.fire_count).toBe(1);
    expect(stats.project_path).toBe(root);
    expect(stats.project_slug).toBe('test-project');
    expect(stats.estimated_errors_prevented).toBe(3);
    expect(stats.estimated_minutes_saved).toBe(3 * 15); // default 15 min/error
    expect(stats.ticks_in_period).toBe(0);
  });

  it('returns zeros for empty fires', () => {
    // No fires file at all
    writeHistory(
      root,
      makeHistory({
        'det-a': { rule_text: 'Some directive text.' },
      }),
    );

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'empty-project',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.total_fires).toBe(0);
    expect(stats.unique_directives_fired).toBe(0);
    expect(stats.fires_by_directive).toHaveLength(0);
    expect(stats.estimated_errors_prevented).toBe(0);
    expect(stats.estimated_minutes_saved).toBe(0);
    expect(stats.active_directives).toBe(1);
  });

  it('handles missing history file gracefully', () => {
    const fires = [
      makeFire({ directive_id: 'det-orphan', t: '2026-04-10T10:00:00.000Z' }),
    ];
    writeFires(root, fires);
    // No history file written — loadHistory returns empty

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'no-history',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.total_fires).toBe(1);
    expect(stats.active_directives).toBe(0);
    // Orphan directive gets fallback preview
    expect(stats.fires_by_directive[0]!.rule_text_preview).toBe('(unknown directive)');
  });

  it('respects since filter — only counts fires after date', () => {
    const fires = [
      makeFire({ directive_id: 'det-a', t: '2026-03-15T00:00:00.000Z' }), // before since
      makeFire({ directive_id: 'det-a', t: '2026-04-05T00:00:00.000Z' }), // after since
      makeFire({ directive_id: 'det-a', t: '2026-04-10T00:00:00.000Z' }), // after since
    ];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Test rule.' } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'filtered',
      since: '2026-04-01T00:00:00.000Z',
    });

    // readFires filters out fires on or before since (uses >)
    expect(stats.total_fires).toBe(2);
    expect(stats.fires_by_directive[0]!.fire_count).toBe(2);
  });

  it('sorts by fire count descending (most fires first)', () => {
    const fires = [
      makeFire({ directive_id: 'det-low', t: '2026-04-10T10:00:00.000Z' }),
      makeFire({ directive_id: 'det-high', t: '2026-04-10T11:00:00.000Z' }),
      makeFire({ directive_id: 'det-high', t: '2026-04-10T12:00:00.000Z' }),
      makeFire({ directive_id: 'det-high', t: '2026-04-10T13:00:00.000Z' }),
      makeFire({ directive_id: 'det-mid', t: '2026-04-10T14:00:00.000Z' }),
      makeFire({ directive_id: 'det-mid', t: '2026-04-10T15:00:00.000Z' }),
    ];
    writeFires(root, fires);
    writeHistory(
      root,
      makeHistory({
        'det-low': { rule_text: 'Low fire rule.' },
        'det-mid': { rule_text: 'Mid fire rule.' },
        'det-high': { rule_text: 'High fire rule.' },
      }),
    );

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'sorted',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.fires_by_directive.map((f) => f.directive_id)).toEqual([
      'det-high',
      'det-mid',
      'det-low',
    ]);
    expect(stats.fires_by_directive.map((f) => f.fire_count)).toEqual([3, 2, 1]);
  });

  it('truncates rule_text_preview at 80 characters', () => {
    const longRuleText =
      'This is an extremely long directive rule text that goes well beyond eighty characters and should be truncated properly in the preview field.';
    expect(longRuleText.length).toBeGreaterThan(80);

    const fires = [makeFire({ directive_id: 'det-long', t: '2026-04-10T10:00:00.000Z' })];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-long': { rule_text: longRuleText } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'truncated',
      since: '2026-04-01T00:00:00.000Z',
    });

    const preview = stats.fires_by_directive[0]!.rule_text_preview;
    expect(preview.length).toBe(80);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('does not truncate rule_text_preview at exactly 80 characters', () => {
    const exactText = 'x'.repeat(80);

    const fires = [makeFire({ directive_id: 'det-exact', t: '2026-04-10T10:00:00.000Z' })];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-exact': { rule_text: exactText } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'exact',
      since: '2026-04-01T00:00:00.000Z',
    });

    const preview = stats.fires_by_directive[0]!.rule_text_preview;
    expect(preview).toBe(exactText);
    expect(preview.length).toBe(80);
  });

  it('handles multiple directives with varying fire counts', () => {
    const fires: DirectiveFire[] = [];
    // det-alpha: 5 fires
    for (let i = 0; i < 5; i++) {
      fires.push(makeFire({ directive_id: 'det-alpha', t: `2026-04-${10 + i}T10:00:00.000Z` }));
    }
    // det-beta: 1 fire
    fires.push(makeFire({ directive_id: 'det-beta', t: '2026-04-10T11:00:00.000Z' }));
    // det-gamma: 3 fires
    for (let i = 0; i < 3; i++) {
      fires.push(makeFire({ directive_id: 'det-gamma', t: `2026-04-${10 + i}T12:00:00.000Z` }));
    }

    writeFires(root, fires);
    writeHistory(
      root,
      makeHistory({
        'det-alpha': { rule_text: 'Alpha rule.' },
        'det-beta': { rule_text: 'Beta rule.' },
        'det-gamma': { rule_text: 'Gamma rule.' },
      }),
    );

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'multi',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.total_fires).toBe(9);
    expect(stats.unique_directives_fired).toBe(3);
    expect(stats.fires_by_directive[0]!.directive_id).toBe('det-alpha');
    expect(stats.fires_by_directive[0]!.fire_count).toBe(5);
    expect(stats.fires_by_directive[1]!.directive_id).toBe('det-gamma');
    expect(stats.fires_by_directive[1]!.fire_count).toBe(3);
    expect(stats.fires_by_directive[2]!.directive_id).toBe('det-beta');
    expect(stats.fires_by_directive[2]!.fire_count).toBe(1);
    expect(stats.estimated_errors_prevented).toBe(9);
    expect(stats.estimated_minutes_saved).toBe(9 * 15);
  });

  it('uses custom minutesPerError when provided', () => {
    const fires = [
      makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' }),
      makeFire({ directive_id: 'det-a', t: '2026-04-10T11:00:00.000Z' }),
    ];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'custom-mpe',
      since: '2026-04-01T00:00:00.000Z',
      minutesPerError: 30,
    });

    expect(stats.estimated_minutes_saved).toBe(2 * 30);
    expect(stats.estimated_errors_prevented).toBe(2);
  });

  it('tracks correct last_fired timestamp per directive', () => {
    const fires = [
      makeFire({ directive_id: 'det-a', t: '2026-04-10T08:00:00.000Z' }),
      makeFire({ directive_id: 'det-a', t: '2026-04-10T16:00:00.000Z' }),
      makeFire({ directive_id: 'det-a', t: '2026-04-10T12:00:00.000Z' }),
    ];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Rule text.' } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'last-fired',
      since: '2026-04-01T00:00:00.000Z',
    });

    // readFires sorts by timestamp ascending, so fires arrive in order.
    // The aggregator tracks the latest t seen per directive.
    expect(stats.fires_by_directive[0]!.last_fired).toBe('2026-04-10T16:00:00.000Z');
  });

  it('counts only non-pruned directives as active', () => {
    const fires = [makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' })];
    writeFires(root, fires);
    writeHistory(root, {
      entries: {
        'det-a': {
          id: 'det-a',
          rule_text: 'Active rule.',
          severity: 'warning',
          first_seen: '2026-01-01T00:00:00.000Z',
          last_reinforced: '2026-04-01T00:00:00.000Z',
          occurrence_count: 1,
          pruned: false,
        },
        'det-pruned': {
          id: 'det-pruned',
          rule_text: 'Pruned rule.',
          severity: 'info',
          first_seen: '2026-01-01T00:00:00.000Z',
          last_reinforced: '2026-02-01T00:00:00.000Z',
          occurrence_count: 1,
          pruned: true,
          pruned_at: '2026-03-01T00:00:00.000Z',
        },
      },
      updated_at: '2026-04-01T00:00:00.000Z',
    });

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'pruned-check',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.active_directives).toBe(1); // only det-a is active
  });

  it('uses default since (30 days ago) when not provided', () => {
    const recentTimestamp = new Date().toISOString();
    const fires = [makeFire({ directive_id: 'det-recent', t: recentTimestamp })];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-recent': { rule_text: 'Recent rule.' } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'default-since',
      // since omitted — defaults to 30 days ago
    });

    expect(stats.total_fires).toBe(1);
    expect(stats.period.since).toBeDefined();
    // The since should be approximately 30 days ago
    const sinceDate = new Date(stats.period.since);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    // Allow 1 second tolerance for test execution time
    expect(Math.abs(sinceDate.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(1000);
  });

  it('directive_id tiebreak is alphabetical when fire counts are equal', () => {
    const fires = [
      makeFire({ directive_id: 'det-zebra', t: '2026-04-10T10:00:00.000Z' }),
      makeFire({ directive_id: 'det-alpha', t: '2026-04-10T11:00:00.000Z' }),
    ];
    writeFires(root, fires);
    writeHistory(
      root,
      makeHistory({
        'det-zebra': { rule_text: 'Zebra rule.' },
        'det-alpha': { rule_text: 'Alpha rule.' },
      }),
    );

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'tiebreak',
      since: '2026-04-01T00:00:00.000Z',
    });

    // Same fire count → alphabetical by directive_id
    expect(stats.fires_by_directive[0]!.directive_id).toBe('det-alpha');
    expect(stats.fires_by_directive[1]!.directive_id).toBe('det-zebra');
  });

  // ─── V48: directive_previews from MetricsState ──────────

  describe('V48: directive_previews', () => {
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), 'auto-sop-home-'));
    });

    afterEach(() => {
      rmSync(tmpHome, { recursive: true, force: true });
    });

    it('populates directive_previews from persisted MetricsState', () => {
      writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));
      const state = emptyMetricsState('test-project');
      state.directive_previews = {
        'sop-7ced': 'Never add comments that describe WHAT a function...',
        'det-0000': 'Always validate input before processing external data from...',
      };
      saveMetricsState(tmpHome, root, state);

      const stats = aggregateStats({
        stateDir: stateDir(root),
        projectRoot: root,
        projectSlug: 'test-project',
        since: '2026-04-01T00:00:00.000Z',
        homeDir: tmpHome,
      });

      expect(stats.directive_previews).toEqual({
        'sop-7ced': 'Never add comments that describe WHAT a function...',
        'det-0000': 'Always validate input before processing external data from...',
      });
    });

    it('returns empty directive_previews when MetricsState has no previews', () => {
      writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));
      const state = emptyMetricsState('test-project');
      // No directive_previews set (undefined)
      saveMetricsState(tmpHome, root, state);

      const stats = aggregateStats({
        stateDir: stateDir(root),
        projectRoot: root,
        projectSlug: 'test-project',
        since: '2026-04-01T00:00:00.000Z',
        homeDir: tmpHome,
      });

      expect(stats.directive_previews).toEqual({});
    });

    it('returns empty directive_previews when no MetricsState file exists', () => {
      writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));
      // No MetricsState saved — tmpHome has no state directory

      const stats = aggregateStats({
        stateDir: stateDir(root),
        projectRoot: root,
        projectSlug: 'test-project',
        since: '2026-04-01T00:00:00.000Z',
        homeDir: tmpHome,
      });

      expect(stats.directive_previews).toEqual({});
    });

    it('returns empty directive_previews when directive_previews is empty object', () => {
      writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));
      const state = emptyMetricsState('test-project');
      state.directive_previews = {};
      saveMetricsState(tmpHome, root, state);

      const stats = aggregateStats({
        stateDir: stateDir(root),
        projectRoot: root,
        projectSlug: 'test-project',
        since: '2026-04-01T00:00:00.000Z',
        homeDir: tmpHome,
      });

      expect(stats.directive_previews).toEqual({});
    });
  });
});

/**
 * Integration tests — directive-fire detection → storage → aggregation → compaction.
 *
 * Tests the full pipeline: detect fires from prompts matching active directives,
 * persist them as JSONL, aggregate into ProjectStats, and compact old entries.
 *
 * Uses real temp directories, real file I/O — no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectDirectiveFires,
  appendFires,
  readFires,
  compactFires,
  FIRES_FILENAME,
} from '~/capture/writer/directive-fire.js';
import type { DirectiveFire, DirectiveInput } from '~/capture/writer/directive-fire.js';
import { aggregateStats } from '~/cli/stats/aggregator.js';
import type { ProjectStats } from '~/cli/stats/aggregator.js';
import { saveHistory } from '~/managed-section/directive-history.js';
import type {
  DirectiveHistory,
  DirectiveHistoryEntry,
} from '~/managed-section/directive-history.js';

// ─── Helpers ────────────────────────────────────────────────

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-fire-integ-'));
}

function stateDir(projectRoot: string): string {
  return join(projectRoot, '.auto-sop', 'state');
}

function makeDirective(id: string, ruleText: string, pruned = false): DirectiveHistoryEntry {
  const now = new Date().toISOString();
  return {
    id,
    rule_text: ruleText,
    severity: 'warning',
    first_seen: now,
    last_reinforced: now,
    occurrence_count: 1,
    pruned,
  };
}

function makeHistory(entries: DirectiveHistoryEntry[]): DirectiveHistory {
  const map: Record<string, DirectiveHistoryEntry> = {};
  for (const e of entries) {
    map[e.id] = e;
  }
  return { entries: map, updated_at: new Date().toISOString() };
}

function makeFire(overrides: Partial<DirectiveFire> = {}): DirectiveFire {
  return {
    t: new Date().toISOString(),
    directive_id: 'dir-default',
    session_id: 'sess-default',
    project_id: 'proj-default',
    keyword_hits: 3,
    keyword_total: 5,
    match_ratio: 0.6,
    ...overrides,
  };
}

// ─── Suite ──────────────────────────────────────────────────

describe('directive-fire integration: detect → store → aggregate', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpRoot();
    mkdirSync(stateDir(projectRoot), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // ── Detection + persistence ─────────────────────────────

  it('detects fires from prompt matching active directives and persists them', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-validate', rule_text: 'Always validate input before database queries' },
      { id: 'dir-strict', rule_text: 'Use TypeScript strict mode everywhere in config' },
    ];

    // Save directive history so aggregator can look up rule_text
    saveHistory(
      projectRoot,
      makeHistory([
        makeDirective('dir-validate', 'Always validate input before database queries'),
        makeDirective('dir-strict', 'Use TypeScript strict mode everywhere in config'),
      ]),
    );

    // Prompt matches dir-validate (validate, input, database, queries)
    const prompt = 'make sure to validate user input before running database queries';
    const fires = detectDirectiveFires(prompt, directives, 'sess-001', 'proj-xyz');

    expect(fires.length).toBeGreaterThanOrEqual(1);
    const matchedIds = fires.map((f) => f.directive_id);
    expect(matchedIds).toContain('dir-validate');

    // Persist
    appendFires(stateDir(projectRoot), fires);

    // Read back
    const stored = readFires(stateDir(projectRoot));
    expect(stored).toHaveLength(fires.length);
    expect(stored[0]!.directive_id).toBe(fires[0]!.directive_id);
    expect(stored[0]!.session_id).toBe('sess-001');
    expect(stored[0]!.project_id).toBe('proj-xyz');
  });

  it('PRIV-02: prompt text never appears in stored fire events', () => {
    const secret = 'my super secret API key abc123xyz789';
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'super secret handling key management' },
    ];

    const fires = detectDirectiveFires(secret, directives, 'sess', 'proj');
    appendFires(stateDir(projectRoot), fires);

    // Check raw file content — prompt text must never appear
    const rawContent = readFileSync(join(stateDir(projectRoot), FIRES_FILENAME), 'utf8');
    expect(rawContent).not.toContain('my super secret API key abc123xyz789');
    expect(rawContent).not.toContain('abc123xyz789');
  });

  // ── Multi-session aggregation ───────────────────────────

  it('aggregates 10 fires across 3 sessions correctly', () => {
    const dir1 = makeDirective('dir-alpha', 'Validate all user input parameters carefully');
    const dir2 = makeDirective('dir-beta', 'Run linter before committing code changes');
    const dir3 = makeDirective('dir-gamma', 'Handle errors with proper try-catch blocks');

    saveHistory(projectRoot, makeHistory([dir1, dir2, dir3]));

    // Session 1: 4 fires (3× dir-alpha, 1× dir-beta)
    const session1Fires: DirectiveFire[] = [
      makeFire({ t: '2026-04-01T10:00:00Z', directive_id: 'dir-alpha', session_id: 'sess-1', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-01T10:05:00Z', directive_id: 'dir-alpha', session_id: 'sess-1', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-01T10:10:00Z', directive_id: 'dir-alpha', session_id: 'sess-1', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-01T10:15:00Z', directive_id: 'dir-beta', session_id: 'sess-1', project_id: 'proj-A' }),
    ];
    appendFires(stateDir(projectRoot), session1Fires);

    // Session 2: 3 fires (2× dir-beta, 1× dir-gamma)
    const session2Fires: DirectiveFire[] = [
      makeFire({ t: '2026-04-02T09:00:00Z', directive_id: 'dir-beta', session_id: 'sess-2', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-02T09:05:00Z', directive_id: 'dir-beta', session_id: 'sess-2', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-02T09:10:00Z', directive_id: 'dir-gamma', session_id: 'sess-2', project_id: 'proj-A' }),
    ];
    appendFires(stateDir(projectRoot), session2Fires);

    // Session 3: 3 fires (2× dir-gamma, 1× dir-alpha)
    const session3Fires: DirectiveFire[] = [
      makeFire({ t: '2026-04-03T14:00:00Z', directive_id: 'dir-gamma', session_id: 'sess-3', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-03T14:05:00Z', directive_id: 'dir-gamma', session_id: 'sess-3', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-03T14:10:00Z', directive_id: 'dir-alpha', session_id: 'sess-3', project_id: 'proj-A' }),
    ];
    appendFires(stateDir(projectRoot), session3Fires);

    // Aggregate
    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: '2026-03-01T00:00:00Z',
    });

    // Total fires
    expect(stats.total_fires).toBe(10);

    // Unique directives fired
    expect(stats.unique_directives_fired).toBe(3);

    // Active directives (all 3 are not pruned)
    expect(stats.active_directives).toBe(3);

    // fires_by_directive: dir-alpha=4, dir-beta=3, dir-gamma=3
    // Sorted by count desc, then id asc
    expect(stats.fires_by_directive).toHaveLength(3);
    expect(stats.fires_by_directive[0]!.directive_id).toBe('dir-alpha');
    expect(stats.fires_by_directive[0]!.fire_count).toBe(4);
    // dir-beta and dir-gamma both have 3 — sorted alphabetically
    expect(stats.fires_by_directive[1]!.directive_id).toBe('dir-beta');
    expect(stats.fires_by_directive[1]!.fire_count).toBe(3);
    expect(stats.fires_by_directive[2]!.directive_id).toBe('dir-gamma');
    expect(stats.fires_by_directive[2]!.fire_count).toBe(3);

    // Estimated metrics: errors_prevented = total_fires, minutes_saved = fires * 15
    expect(stats.estimated_errors_prevented).toBe(10);
    expect(stats.estimated_minutes_saved).toBe(150); // 10 * 15
  });

  it('aggregates with custom minutesPerError', () => {
    saveHistory(
      projectRoot,
      makeHistory([makeDirective('dir-1', 'Test directive for time calculation')]),
    );

    const fires: DirectiveFire[] = [
      makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-10T11:00:00Z', directive_id: 'dir-1', session_id: 'sess-1', project_id: 'proj-A' }),
    ];
    appendFires(stateDir(projectRoot), fires);

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: '2026-04-01T00:00:00Z',
      minutesPerError: 30,
    });

    expect(stats.total_fires).toBe(2);
    expect(stats.estimated_minutes_saved).toBe(60); // 2 * 30
  });

  // ── Compaction ──────────────────────────────────────────

  it('compaction removes fires older than 90 days, keeps recent', () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
    const recentDate = new Date().toISOString();

    const oldFires = [
      makeFire({ t: oldDate, directive_id: 'dir-old-1', session_id: 'sess-old' }),
      makeFire({ t: oldDate, directive_id: 'dir-old-2', session_id: 'sess-old' }),
    ];
    const recentFires = [
      makeFire({ t: recentDate, directive_id: 'dir-recent-1', session_id: 'sess-recent' }),
      makeFire({ t: recentDate, directive_id: 'dir-recent-2', session_id: 'sess-recent' }),
      makeFire({ t: recentDate, directive_id: 'dir-recent-3', session_id: 'sess-recent' }),
    ];

    appendFires(stateDir(projectRoot), oldFires);
    appendFires(stateDir(projectRoot), recentFires);

    // Before compaction: 5 fires
    expect(readFires(stateDir(projectRoot))).toHaveLength(5);

    // Compact with 90-day retention
    const removed = compactFires(stateDir(projectRoot), 90);
    expect(removed).toBe(2);

    // After compaction: only 3 recent fires remain
    const remaining = readFires(stateDir(projectRoot));
    expect(remaining).toHaveLength(3);

    // All remaining fires should be recent
    const remainingIds = remaining.map((f) => f.directive_id);
    expect(remainingIds).toContain('dir-recent-1');
    expect(remainingIds).toContain('dir-recent-2');
    expect(remainingIds).toContain('dir-recent-3');
    expect(remainingIds).not.toContain('dir-old-1');
    expect(remainingIds).not.toContain('dir-old-2');
  });

  it('compaction retains recent events and aggregation still works after', () => {
    saveHistory(
      projectRoot,
      makeHistory([makeDirective('dir-kept', 'Directive that should survive compaction')]),
    );

    // Mix old + recent
    const oldDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    appendFires(stateDir(projectRoot), [
      makeFire({ t: oldDate, directive_id: 'dir-kept', session_id: 'sess-old' }),
      makeFire({ t: oldDate, directive_id: 'dir-kept', session_id: 'sess-old' }),
      makeFire({ t: recentDate, directive_id: 'dir-kept', session_id: 'sess-recent' }),
    ]);

    compactFires(stateDir(projectRoot), 90);

    // Aggregate should only see the 1 recent fire
    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(stats.total_fires).toBe(1);
    expect(stats.fires_by_directive[0]!.directive_id).toBe('dir-kept');
    expect(stats.fires_by_directive[0]!.fire_count).toBe(1);
  });

  // ── Edge cases ──────────────────────────────────────────

  it('fresh install — no fires file → aggregation returns zero stats', () => {
    saveHistory(
      projectRoot,
      makeHistory([makeDirective('dir-1', 'Some directive')]),
    );

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'fresh-project',
    });

    expect(stats.total_fires).toBe(0);
    expect(stats.unique_directives_fired).toBe(0);
    expect(stats.fires_by_directive).toEqual([]);
    expect(stats.estimated_errors_prevented).toBe(0);
    expect(stats.estimated_minutes_saved).toBe(0);
    expect(stats.active_directives).toBe(1);
  });

  it('single fire → stats reflect exactly one event', () => {
    saveHistory(
      projectRoot,
      makeHistory([makeDirective('dir-single', 'Single fire test directive')]),
    );

    appendFires(stateDir(projectRoot), [
      makeFire({ t: '2026-04-15T12:00:00Z', directive_id: 'dir-single', session_id: 'sess-1', project_id: 'proj-A' }),
    ]);

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: '2026-04-01T00:00:00Z',
    });

    expect(stats.total_fires).toBe(1);
    expect(stats.unique_directives_fired).toBe(1);
    expect(stats.fires_by_directive).toHaveLength(1);
    expect(stats.fires_by_directive[0]!.fire_count).toBe(1);
  });

  it('all directives pruned → active_directives is 0', () => {
    saveHistory(
      projectRoot,
      makeHistory([
        makeDirective('dir-pruned-1', 'First pruned directive', true),
        makeDirective('dir-pruned-2', 'Second pruned directive', true),
      ]),
    );

    appendFires(stateDir(projectRoot), [
      makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-pruned-1', session_id: 'sess-1', project_id: 'proj-A' }),
    ]);

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: '2026-04-01T00:00:00Z',
    });

    expect(stats.active_directives).toBe(0);
    // Fires still counted even if directive is now pruned
    expect(stats.total_fires).toBe(1);
  });

  it('very long rule_text is truncated in preview (max 80 chars)', () => {
    const longRuleText =
      'This is a very long directive rule text that should be truncated when displayed in the preview because it exceeds the 80-character limit set by the aggregator module';
    saveHistory(
      projectRoot,
      makeHistory([makeDirective('dir-long', longRuleText)]),
    );

    appendFires(stateDir(projectRoot), [
      makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-long', session_id: 'sess-1', project_id: 'proj-A' }),
    ]);

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: '2026-04-01T00:00:00Z',
    });

    expect(stats.fires_by_directive).toHaveLength(1);
    const preview = stats.fires_by_directive[0]!.rule_text_preview;
    expect(preview.length).toBeLessThanOrEqual(80);
    // Should end with ellipsis if truncated
    expect(preview.endsWith('…')).toBe(true);
  });

  it('since filter excludes older fires from aggregation', () => {
    saveHistory(
      projectRoot,
      makeHistory([makeDirective('dir-1', 'Test directive for since filter')]),
    );

    appendFires(stateDir(projectRoot), [
      makeFire({ t: '2026-01-15T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-old', project_id: 'proj-A' }),
      makeFire({ t: '2026-02-15T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-mid', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-15T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-new', project_id: 'proj-A' }),
    ]);

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: '2026-03-01T00:00:00Z',
    });

    // Only the April fire should be included (since > March 1)
    expect(stats.total_fires).toBe(1);
    expect(stats.fires_by_directive[0]!.fire_count).toBe(1);
  });

  it('fires_by_directive.last_fired tracks the most recent fire per directive', () => {
    saveHistory(
      projectRoot,
      makeHistory([makeDirective('dir-1', 'Directive for last_fired test')]),
    );

    appendFires(stateDir(projectRoot), [
      makeFire({ t: '2026-04-01T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-05T15:30:00Z', directive_id: 'dir-1', session_id: 'sess-2', project_id: 'proj-A' }),
      makeFire({ t: '2026-04-03T12:00:00Z', directive_id: 'dir-1', session_id: 'sess-3', project_id: 'proj-A' }),
    ]);

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: '2026-03-01T00:00:00Z',
    });

    expect(stats.fires_by_directive[0]!.last_fired).toBe('2026-04-05T15:30:00Z');
  });

  it('unknown directive_id falls back to "(unknown directive)" in preview', () => {
    // Save history without the directive that fired
    saveHistory(
      projectRoot,
      makeHistory([makeDirective('dir-known', 'Known directive')]),
    );

    appendFires(stateDir(projectRoot), [
      makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-deleted', session_id: 'sess-1', project_id: 'proj-A' }),
    ]);

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'test-proj',
      since: '2026-04-01T00:00:00Z',
    });

    expect(stats.fires_by_directive[0]!.rule_text_preview).toBe('(unknown directive)');
  });

  it('project_slug and project_path are set correctly in stats output', () => {
    saveHistory(projectRoot, makeHistory([]));

    const stats = aggregateStats({
      stateDir: stateDir(projectRoot),
      projectRoot,
      projectSlug: 'my-awesome-project',
    });

    expect(stats.project_slug).toBe('my-awesome-project');
    expect(stats.project_path).toBe(projectRoot);
  });
});

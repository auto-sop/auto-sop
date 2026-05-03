/**
 * Integration tests for V32 sync queue + token estimation + stats display.
 *
 * Covers:
 * 1. Sync queue: buildSyncEntry with realistic data → append → read → compact
 * 2. Token estimation: BeforeAfterComparison → estimateTokenSavings math + edge cases
 * 3. M3 verification: error prevention count flows into stats aggregator
 * 4. Stats aggregator: sync_queue_size populated correctly
 * 5. Backward compat: projects without sync-queue.jsonl produce sync_queue_size = 0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSyncEntry,
  appendSyncEntry,
  readSyncEntries,
  compactSyncQueue,
  type BuildSyncEntryOpts,
} from '../../src/learner/sync-queue.js';
import {
  estimateTokenSavings,
  TOKENS_PER_CALL,
  type BeforeAfterComparison,
} from '../../src/learner/session-metrics.js';
import { appendPreventedErrors, type PreventedError } from '../../src/learner/error-prevention.js';
import { aggregateStats } from '../../src/cli/stats/aggregator.js';
import type { DirectiveFire } from '../../src/capture/writer/directive-fire.js';
import type { DirectiveHistory } from '../../src/managed-section/directive-history.js';

// ─── Helpers ───────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'v32-integ-'));
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
    { rule_text: string; severity?: 'error' | 'warning' | 'info'; pruned?: boolean }
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

function makeComparison(
  beforeAvgToolCalls: number,
  afterAvgToolCalls: number,
  overrides?: Partial<BeforeAfterComparison>,
): BeforeAfterComparison {
  return {
    cutoff: '2026-04-22T00:00:00Z',
    before: {
      sessions: 5,
      avg_duration_min: 10,
      avg_tool_calls: beforeAvgToolCalls,
      avg_bash_failures: 2,
      avg_input_bytes: 0,
      avg_output_bytes: 0,
    },
    after: {
      sessions: 5,
      avg_duration_min: 8,
      avg_tool_calls: afterAvgToolCalls,
      avg_bash_failures: 1,
      avg_input_bytes: 0,
      avg_output_bytes: 0,
    },
    improvement: { duration_pct: -20, tool_calls_pct: -40, bash_failures_pct: -50 },
    ...overrides,
  };
}

function makeRealisticSyncOpts(): BuildSyncEntryOpts {
  return {
    projectId: 'proj-abc-123',
    projectSlug: 'my-real-project',
    tickId: 'tick-20260425-001',
    directivesActive: 12,
    firesTotal: 47,
    firesByCategory: { error_preventing: 15, efficiency: 22, best_practice: 10 },
    errorsPrevented: 8,
    sessionComparison: makeComparison(25, 15),
    tokenEstimate: {
      method: 'tool_call_heuristic',
      tokens_per_call: TOKENS_PER_CALL,
      before_avg_tokens: 5000,
      after_avg_tokens: 3000,
      savings_per_session: 2000,
      savings_pct: 40,
    },
  };
}

// ─── 1. Sync queue integration ─────────────────────────────

describe('Sync queue integration: realistic data flow', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('buildSyncEntry produces complete entry from realistic opts', () => {
    const opts = makeRealisticSyncOpts();
    const entry = buildSyncEntry(opts);

    // Verify all fields map correctly from opts
    expect(entry.v).toBe(1);
    expect(entry.project_id).toBe('proj-abc-123');
    expect(entry.project_slug).toBe('my-real-project');
    expect(entry.tick_id).toBe('tick-20260425-001');
    expect(entry.directives_active).toBe(12);
    expect(entry.fires_total).toBe(47);
    expect(entry.fires_by_category).toEqual({
      error_preventing: 15,
      efficiency: 22,
      best_practice: 10,
    });
    expect(entry.errors_prevented_total).toBe(8);
    expect(entry.session_comparison).not.toBeNull();
    expect(entry.session_comparison!.before.avg_tool_calls).toBe(25);
    expect(entry.session_comparison!.after.avg_tool_calls).toBe(15);
    expect(entry.token_estimate).not.toBeNull();
    expect(entry.token_estimate!.savings_per_session).toBe(2000);
    // ISO timestamp is present and valid
    expect(Date.parse(entry.t)).not.toBeNaN();
  });

  it('append → read roundtrip preserves all fields including nested objects', () => {
    const opts = makeRealisticSyncOpts();
    const entry = buildSyncEntry(opts);

    appendSyncEntry(testDir, entry);

    const entries = readSyncEntries(testDir);
    expect(entries).toHaveLength(1);

    const read = entries[0]!;
    expect(read.v).toBe(entry.v);
    expect(read.project_id).toBe(entry.project_id);
    expect(read.project_slug).toBe(entry.project_slug);
    expect(read.tick_id).toBe(entry.tick_id);
    expect(read.directives_active).toBe(entry.directives_active);
    expect(read.fires_total).toBe(entry.fires_total);
    expect(read.fires_by_category).toEqual(entry.fires_by_category);
    expect(read.errors_prevented_total).toBe(entry.errors_prevented_total);
    // Deep equality for nested objects
    expect(read.session_comparison).toEqual(entry.session_comparison);
    expect(read.token_estimate).toEqual(entry.token_estimate);
  });

  it('compact with short max age removes old entries, keeps recent', () => {
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const justNow = new Date(now - 1000).toISOString();

    const opts = makeRealisticSyncOpts();
    const old1 = buildSyncEntry(opts);
    old1.t = twoDaysAgo;
    old1.tick_id = 'tick-old-1';

    const recent = buildSyncEntry(opts);
    recent.t = justNow;
    recent.tick_id = 'tick-recent';

    appendSyncEntry(testDir, old1);
    appendSyncEntry(testDir, recent);

    // maxAge=1 day → old1 removed, recent kept
    const result = compactSyncQueue(testDir, 1);
    expect(result).toEqual({ removed: 1, kept: 1 });

    const remaining = readSyncEntries(testDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.tick_id).toBe('tick-recent');
  });

  it('multiple appends accumulate correctly', () => {
    const opts = makeRealisticSyncOpts();

    for (let i = 0; i < 5; i++) {
      const entry = buildSyncEntry({ ...opts, tickId: `tick-${i}` });
      appendSyncEntry(testDir, entry);
    }

    const entries = readSyncEntries(testDir);
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.tick_id)).toEqual([
      'tick-0',
      'tick-1',
      'tick-2',
      'tick-3',
      'tick-4',
    ]);
  });
});

// ─── 2. Token estimation integration ───────────────────────

describe('Token estimation integration: math verification', () => {
  it('correct math: 25 → 15 tool calls = 2000 tokens saved (40%)', () => {
    const comparison = makeComparison(25, 15);
    const result = estimateTokenSavings(comparison)!;

    expect(result).not.toBeNull();
    expect(result.method).toBe('tool_call_heuristic');
    expect(result.tokens_per_call).toBe(200);
    expect(result.before_avg_tokens).toBe(25 * 200); // 5000
    expect(result.after_avg_tokens).toBe(15 * 200); // 3000
    expect(result.savings_per_session).toBe(2000);
    expect(result.savings_pct).toBe(40);
  });

  it('correct math: 10 → 8 tool calls = 400 tokens saved (20%)', () => {
    const comparison = makeComparison(10, 8);
    const result = estimateTokenSavings(comparison)!;

    expect(result.before_avg_tokens).toBe(2000);
    expect(result.after_avg_tokens).toBe(1600);
    expect(result.savings_per_session).toBe(400);
    expect(result.savings_pct).toBe(20);
  });

  it('null comparison returns null', () => {
    expect(estimateTokenSavings(null)).toBeNull();
  });

  it('zero tool calls before → 0 savings, 0% (no division by zero)', () => {
    const comparison = makeComparison(0, 5);
    const result = estimateTokenSavings(comparison)!;

    expect(result.before_avg_tokens).toBe(0);
    expect(result.after_avg_tokens).toBe(1000);
    expect(result.savings_per_session).toBe(0); // clamped to 0
    expect(result.savings_pct).toBe(0);
  });

  it('no improvement (after > before) → savings clamped to 0', () => {
    // After has MORE tool calls than before (regression)
    const comparison = makeComparison(10, 20);
    const result = estimateTokenSavings(comparison)!;

    expect(result.before_avg_tokens).toBe(2000);
    expect(result.after_avg_tokens).toBe(4000);
    expect(result.savings_per_session).toBe(0); // clamped, not negative
    expect(result.savings_pct).toBe(0);
  });

  it('0 sessions in before bucket → returns null', () => {
    const comparison = makeComparison(20, 10, {
      before: {
        sessions: 0,
        avg_duration_min: 0,
        avg_tool_calls: 20,
        avg_bash_failures: 0,
        avg_input_bytes: 0,
        avg_output_bytes: 0,
      },
    });
    expect(estimateTokenSavings(comparison)).toBeNull();
  });

  it('0 sessions in after bucket → returns null', () => {
    const comparison = makeComparison(20, 10, {
      after: {
        sessions: 0,
        avg_duration_min: 0,
        avg_tool_calls: 10,
        avg_bash_failures: 0,
        avg_input_bytes: 0,
        avg_output_bytes: 0,
      },
    });
    expect(estimateTokenSavings(comparison)).toBeNull();
  });

  it('fractional tool calls round correctly', () => {
    // avg_tool_calls can be fractional (averages)
    const comparison = makeComparison(15.5, 10.3);
    const result = estimateTokenSavings(comparison)!;

    expect(result.before_avg_tokens).toBe(3100); // 15.5 * 200
    expect(result.after_avg_tokens).toBe(2060); // 10.3 * 200
    expect(result.savings_per_session).toBe(1040); // 3100 - 2060
    // 1040 / 3100 * 100 = 33.548... → rounded to 33.55
    expect(result.savings_pct).toBe(33.55);
  });
});

// ─── 3. M3 verification: error prevention in stats ──────────

describe('M3 verification: error prevention count in stats aggregator', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('aggregator reads error-prevention.jsonl and populates real_errors_prevented', () => {
    // Set up fires + history (required for aggregateStats)
    const fires = [makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' })];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));

    // Write prevention events to state dir
    const sd = stateDir(root);
    const preventionEvents: PreventedError[] = [
      {
        t: '2026-04-15T12:00:00.000Z',
        directive_id: 'det-a',
        source_fingerprint: 'fp-001',
        session_id: 'sess-new',
        command_preview: 'npm test',
      },
      {
        t: '2026-04-16T14:00:00.000Z',
        directive_id: 'det-a',
        source_fingerprint: 'fp-002',
        session_id: 'sess-new2',
        command_preview: 'npm run build',
      },
      {
        t: '2026-04-17T09:00:00.000Z',
        directive_id: 'det-a',
        source_fingerprint: 'fp-001',
        session_id: 'sess-new3',
        command_preview: 'npm test',
      },
    ];
    appendPreventedErrors(sd, preventionEvents);

    const stats = aggregateStats({
      stateDir: sd,
      projectRoot: root,
      projectSlug: 'prevention-test',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.real_errors_prevented).toBe(3);
  });

  it('real_errors_prevented respects since filter', () => {
    const fires = [makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' })];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));

    const sd = stateDir(root);
    const preventionEvents: PreventedError[] = [
      {
        t: '2026-03-01T12:00:00.000Z', // before since
        directive_id: 'det-a',
        source_fingerprint: 'fp-old',
        session_id: 'sess-old',
        command_preview: 'old command',
      },
      {
        t: '2026-04-15T12:00:00.000Z', // after since
        directive_id: 'det-a',
        source_fingerprint: 'fp-new',
        session_id: 'sess-new',
        command_preview: 'new command',
      },
    ];
    appendPreventedErrors(sd, preventionEvents);

    const stats = aggregateStats({
      stateDir: sd,
      projectRoot: root,
      projectSlug: 'since-filter',
      since: '2026-04-01T00:00:00.000Z',
    });

    // Only the prevention event after since should count
    expect(stats.real_errors_prevented).toBe(1);
  });

  it('real_errors_prevented = 0 when no prevention file exists', () => {
    const fires = [makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' })];
    writeFires(root, fires);
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'no-prevention',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.real_errors_prevented).toBe(0);
  });
});

// ─── 4. Stats aggregator: V32 fields ───────────────────────

describe('Stats aggregator: V32 sync_queue_size', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('sync_queue_size reflects number of entries in sync-queue.jsonl', () => {
    writeFires(root, [makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' })]);
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));

    // Write 3 sync entries to the state dir
    const sd = stateDir(root);
    const opts = makeRealisticSyncOpts();
    for (let i = 0; i < 3; i++) {
      appendSyncEntry(sd, buildSyncEntry({ ...opts, tickId: `tick-${i}` }));
    }

    const stats = aggregateStats({
      stateDir: sd,
      projectRoot: root,
      projectSlug: 'sync-size-test',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.sync_queue_size).toBe(3);
  });

  it('sync_queue_size = 0 when sync-queue.jsonl does not exist (backward compat)', () => {
    writeFires(root, [makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' })]);
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'no-sync-queue',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.sync_queue_size).toBe(0);
  });
});

// ─── 5. Backward compat: old projects ───────────────────────

describe('Backward compat: projects without V32 files produce valid stats', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('project with fires but no sync-queue.jsonl: sync_queue_size = 0', () => {
    const fires = [
      makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' }),
      makeFire({ directive_id: 'det-b', t: '2026-04-11T10:00:00.000Z' }),
    ];
    writeFires(root, fires);
    writeHistory(
      root,
      makeHistory({
        'det-a': { rule_text: 'Rule A.' },
        'det-b': { rule_text: 'Rule B.' },
      }),
    );

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'legacy-project',
      since: '2026-04-01T00:00:00.000Z',
    });

    // V32 fields have safe defaults
    expect(stats.sync_queue_size).toBe(0);

    // V31 fields still work
    expect(stats.total_fires).toBe(2);
    expect(stats.real_errors_prevented).toBe(0);
    expect(stats.fires_by_category).toBeDefined();
    expect(stats.session_comparison).toBeNull();
  });

  it('empty project (no fires, no sync queue): all V32 fields safe', () => {
    // Only create state dir + history, no fires, no sync queue
    writeHistory(root, makeHistory({ 'det-a': { rule_text: 'Unused rule.' } }));

    const stats = aggregateStats({
      stateDir: stateDir(root),
      projectRoot: root,
      projectSlug: 'empty-legacy',
      since: '2026-04-01T00:00:00.000Z',
    });

    expect(stats.total_fires).toBe(0);
    expect(stats.sync_queue_size).toBe(0);
    expect(stats.real_errors_prevented).toBe(0);
    expect(stats.session_comparison).toBeNull();
  });
});

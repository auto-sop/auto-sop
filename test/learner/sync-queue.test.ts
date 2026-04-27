/**
 * Unit tests for src/learner/sync-queue.ts
 *
 * Covers:
 * - buildSyncEntry: produces valid schema
 * - appendSyncEntry + readSyncEntries: roundtrip
 * - readSyncEntries: skips malformed lines
 * - compactSyncQueue: removes old entries, keeps recent
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { nanoid } from 'nanoid';
import {
  buildSyncEntry,
  appendSyncEntry,
  readSyncEntries,
  compactSyncQueue,
} from '../../src/learner/sync-queue.js';
import type { SyncEntry } from '../../src/learner/sync-queue.js';

// ── Fixture helpers ──────────────────────────────────────

function makeSyncEntry(overrides?: Partial<SyncEntry>): SyncEntry {
  return {
    v: 1,
    t: '2026-04-25T10:00:00.000Z',
    project_id: 'proj-abc',
    project_slug: 'my-project',
    tick_id: 'tick-001',
    directives_active: 5,
    fires_total: 12,
    fires_by_category: { error_preventing: 3, efficiency: 5, best_practice: 4 },
    errors_prevented_total: 3,
    session_comparison: null,
    token_estimate: null,
    ...overrides,
  };
}

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sync-queue-test-${nanoid(10)}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ─── buildSyncEntry ────────────────────────────────────

describe('buildSyncEntry', () => {
  it('produces valid SyncEntry with v: 1 and ISO timestamp', () => {
    const entry = buildSyncEntry({
      projectId: 'proj-123',
      projectSlug: 'test-proj',
      tickId: 'tick-42',
      directivesActive: 8,
      firesTotal: 20,
      firesByCategory: { error_preventing: 5, efficiency: 10, best_practice: 5 },
      errorsPrevented: 5,
      sessionComparison: null,
      tokenEstimate: null,
    });

    expect(entry.v).toBe(1);
    expect(entry.project_id).toBe('proj-123');
    expect(entry.project_slug).toBe('test-proj');
    expect(entry.tick_id).toBe('tick-42');
    expect(entry.directives_active).toBe(8);
    expect(entry.fires_total).toBe(20);
    expect(entry.fires_by_category).toEqual({ error_preventing: 5, efficiency: 10, best_practice: 5 });
    expect(entry.errors_prevented_total).toBe(5);
    expect(entry.session_comparison).toBeNull();
    expect(entry.token_estimate).toBeNull();
    // ISO timestamp
    expect(Date.parse(entry.t)).not.toBeNaN();
  });

  it('includes session comparison and token estimate when provided', () => {
    const comparison = {
      cutoff: '2026-04-22T00:00:00Z',
      before: { sessions: 5, avg_duration_min: 15, avg_tool_calls: 20, avg_bash_failures: 4, avg_input_bytes: 0, avg_output_bytes: 0 },
      after: { sessions: 5, avg_duration_min: 10, avg_tool_calls: 12, avg_bash_failures: 2, avg_input_bytes: 0, avg_output_bytes: 0 },
      improvement: { duration_pct: -33.33, tool_calls_pct: -40, bash_failures_pct: -50 },
    };
    const tokenEst = {
      method: 'tool_call_heuristic' as const,
      tokens_per_call: 200,
      before_avg_tokens: 4000,
      after_avg_tokens: 2400,
      savings_per_session: 1600,
      savings_pct: 40,
    };

    const entry = buildSyncEntry({
      projectId: 'p1',
      projectSlug: 'slug',
      tickId: 't1',
      directivesActive: 3,
      firesTotal: 5,
      firesByCategory: { error_preventing: 1, efficiency: 2, best_practice: 2 },
      errorsPrevented: 1,
      sessionComparison: comparison,
      tokenEstimate: tokenEst,
    });

    expect(entry.session_comparison).toEqual(comparison);
    expect(entry.token_estimate).toEqual(tokenEst);
  });
});

// ─── appendSyncEntry + readSyncEntries ─────────────────

describe('appendSyncEntry + readSyncEntries roundtrip', () => {
  it('appends and reads back entries', () => {
    const entry1 = makeSyncEntry({ tick_id: 'tick-1' });
    const entry2 = makeSyncEntry({ tick_id: 'tick-2' });

    appendSyncEntry(testDir, entry1);
    appendSyncEntry(testDir, entry2);

    const entries = readSyncEntries(testDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.tick_id).toBe('tick-1');
    expect(entries[1]!.tick_id).toBe('tick-2');
  });

  it('returns empty array when file does not exist', () => {
    const entries = readSyncEntries(testDir);
    expect(entries).toEqual([]);
  });

  it('never throws on append (best-effort)', () => {
    // Pass a non-existent deeply nested path — appendSyncEntry should not throw
    const badDir = join(testDir, 'a', 'b', 'c', 'd');
    expect(() => appendSyncEntry(badDir, makeSyncEntry())).not.toThrow();
  });
});

// ─── readSyncEntries: malformed lines ──────────────────

describe('readSyncEntries malformed handling', () => {
  it('skips malformed JSON lines', () => {
    const filePath = join(testDir, 'sync-queue.jsonl');
    const validEntry = makeSyncEntry({ tick_id: 'good' });
    const content = [
      JSON.stringify(validEntry),
      'not valid json at all',
      '{"v": 1, "incomplete',
      JSON.stringify(makeSyncEntry({ tick_id: 'also-good' })),
    ].join('\n');
    writeFileSync(filePath, content + '\n', 'utf8');

    const entries = readSyncEntries(testDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.tick_id).toBe('good');
    expect(entries[1]!.tick_id).toBe('also-good');
  });

  it('skips entries missing required fields', () => {
    const filePath = join(testDir, 'sync-queue.jsonl');
    const content = [
      '{"v": 2, "t": "2026-01-01T00:00:00Z", "project_id": "p1"}',
      '{"v": 1, "project_id": "p2"}',
      JSON.stringify(makeSyncEntry({ tick_id: 'valid' })),
    ].join('\n');
    writeFileSync(filePath, content + '\n', 'utf8');

    const entries = readSyncEntries(testDir);
    // First line has v:2 (not 1), second has no t, third is valid
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tick_id).toBe('valid');
  });
});

// ─── compactSyncQueue ──────────────────────────────────

describe('compactSyncQueue', () => {
  it('removes entries older than maxAgeDays and returns { removed, kept }', () => {
    const now = Date.now();
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(); // 31 days ago
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

    appendSyncEntry(testDir, makeSyncEntry({ t: old, tick_id: 'old-tick' }));
    appendSyncEntry(testDir, makeSyncEntry({ t: recent, tick_id: 'recent-tick' }));

    const result = compactSyncQueue(testDir, 30);
    expect(result).toEqual({ removed: 1, kept: 1 });

    const remaining = readSyncEntries(testDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.tick_id).toBe('recent-tick');
  });

  it('returns { removed: 0, kept: N } when no entries need removal', () => {
    const recent = new Date().toISOString();
    appendSyncEntry(testDir, makeSyncEntry({ t: recent }));

    const result = compactSyncQueue(testDir, 30);
    expect(result).toEqual({ removed: 0, kept: 1 });
  });

  it('returns { removed: 0, kept: 0 } for empty queue', () => {
    const result = compactSyncQueue(testDir, 30);
    expect(result).toEqual({ removed: 0, kept: 0 });
  });

  it('removes all entries when all are old', () => {
    const old1 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const old2 = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

    appendSyncEntry(testDir, makeSyncEntry({ t: old1, tick_id: 't1' }));
    appendSyncEntry(testDir, makeSyncEntry({ t: old2, tick_id: 't2' }));

    const result = compactSyncQueue(testDir, 30);
    expect(result).toEqual({ removed: 2, kept: 0 });

    const remaining = readSyncEntries(testDir);
    expect(remaining).toHaveLength(0);
  });
});

/**
 * Unit tests for src/managed-section/directive-history.ts
 *
 * Covers:
 *   - load returns empty on missing / corrupt file
 *   - save writes atomic 0600 file
 *   - updateFromProposals bumps count + clears pruned flag
 *   - applyTTLAndCap prunes stale entries (TTL), keeps within cap
 *   - env var overrides defaults
 *   - re-seeing a pruned directive returns it to active
 *   - history file is preserved when entries are pruned
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadHistory,
  saveHistory,
  emptyHistory,
  updateFromProposals,
  applyTTLAndCap,
  applyDirectiveHistory,
  getDirectiveConfig,
  DEFAULT_TTL_DAYS,
  DEFAULT_MAX_DIRECTIVES,
  ENV_TTL_DAYS,
  ENV_MAX_DIRECTIVES,
  type DirectiveHistory,
  type DirectiveHistoryEntry,
  type DirectiveProposalLike,
} from '../../src/managed-section/directive-history.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-dh-'));
}

function makeEntry(overrides: Partial<DirectiveHistoryEntry> = {}): DirectiveHistoryEntry {
  return {
    id: 'det-default-0000',
    rule_text: 'Default rule text body long enough to be realistic.',
    severity: 'warning',
    first_seen: '2026-01-01T00:00:00.000Z',
    last_reinforced: '2026-01-01T00:00:00.000Z',
    occurrence_count: 1,
    pruned: false,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<DirectiveProposalLike> = {}): DirectiveProposalLike {
  return {
    id: 'det-default-0000',
    rule_text: 'Default rule text body long enough to be realistic.',
    severity: 'warning',
    evidence: { first_seen: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

function historyFile(root: string): string {
  return join(root, '.auto-sop', 'state', 'directive-history.json');
}

// ─── load / save ─────────────────────────────────────────

describe('directive-history load/save', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty history when file does not exist', () => {
    const h = loadHistory(root);
    expect(h.entries).toEqual({});
    expect(typeof h.updated_at).toBe('string');
  });

  it('returns empty history when file is corrupt JSON', () => {
    mkdirSync(join(root, '.auto-sop', 'state'), { recursive: true });
    writeFileSync(historyFile(root), 'this is not JSON{{');
    const h = loadHistory(root);
    expect(h.entries).toEqual({});
  });

  it('returns empty history when schema is missing fields', () => {
    mkdirSync(join(root, '.auto-sop', 'state'), { recursive: true });
    // Entries not an object → treat as empty.
    writeFileSync(historyFile(root), JSON.stringify({ entries: 'bad' }));
    const h = loadHistory(root);
    expect(h.entries).toEqual({});
  });

  it('round-trips via save → load', () => {
    const input: DirectiveHistory = {
      entries: {
        'det-a': makeEntry({ id: 'det-a' }),
        'det-b': makeEntry({
          id: 'det-b',
          severity: 'error',
          pruned: true,
          pruned_at: '2026-02-01T00:00:00.000Z',
        }),
      },
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    saveHistory(root, input);
    const loaded = loadHistory(root);
    expect(loaded.entries).toEqual(input.entries);
    expect(loaded.updated_at).toBe(input.updated_at);
  });

  it('save writes file with 0600 mode', () => {
    saveHistory(root, emptyHistory());
    const st = statSync(historyFile(root));
    // Check user-rw, no group/world perms on non-Windows.
    if (process.platform !== 'win32') {
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('skips malformed individual entries but keeps good ones', () => {
    mkdirSync(join(root, '.auto-sop', 'state'), { recursive: true });
    writeFileSync(
      historyFile(root),
      JSON.stringify({
        entries: {
          good: {
            id: 'det-good',
            rule_text: 'Good rule text here right enough.',
            severity: 'warning',
            first_seen: '2026-01-01T00:00:00.000Z',
            last_reinforced: '2026-01-01T00:00:00.000Z',
            occurrence_count: 2,
            pruned: false,
          },
          bad: { id: 'det-bad' /* missing fields */ },
          badSeverity: {
            id: 'det-sev',
            rule_text: 'text',
            severity: 'critical', // not a valid severity
            first_seen: '2026-01-01T00:00:00.000Z',
            last_reinforced: '2026-01-01T00:00:00.000Z',
            occurrence_count: 1,
            pruned: false,
          },
        },
        updated_at: '2026-03-01T00:00:00.000Z',
      }),
    );
    const h = loadHistory(root);
    expect(Object.keys(h.entries)).toEqual(['good']);
  });
});

// ─── updateFromProposals ─────────────────────────────────

describe('updateFromProposals', () => {
  it('adds new entries the first time they are seen', () => {
    const empty = emptyHistory('2026-04-01T00:00:00.000Z');
    const updated = updateFromProposals(
      empty,
      [makeProposal({ id: 'new-1' })],
      '2026-04-02T12:00:00.000Z',
    );
    expect(updated.entries['new-1']).toBeDefined();
    expect(updated.entries['new-1']!.occurrence_count).toBe(1);
    expect(updated.entries['new-1']!.first_seen).toBe('2026-01-01T00:00:00.000Z');
    expect(updated.entries['new-1']!.last_reinforced).toBe('2026-04-02T12:00:00.000Z');
    expect(updated.entries['new-1']!.pruned).toBe(false);
  });

  it('bumps occurrence_count and last_reinforced on existing entries', () => {
    const history: DirectiveHistory = {
      entries: {
        'existing-1': makeEntry({
          id: 'existing-1',
          occurrence_count: 4,
          last_reinforced: '2026-03-01T00:00:00.000Z',
        }),
      },
      updated_at: '2026-03-01T00:00:00.000Z',
    };
    const updated = updateFromProposals(
      history,
      [makeProposal({ id: 'existing-1' })],
      '2026-04-01T00:00:00.000Z',
    );
    expect(updated.entries['existing-1']!.occurrence_count).toBe(5);
    expect(updated.entries['existing-1']!.last_reinforced).toBe('2026-04-01T00:00:00.000Z');
  });

  it('clears pruned flag when a pruned directive is re-seen', () => {
    const history: DirectiveHistory = {
      entries: {
        'rev-1': makeEntry({
          id: 'rev-1',
          pruned: true,
          pruned_at: '2026-02-01T00:00:00.000Z',
          occurrence_count: 3,
        }),
      },
      updated_at: '2026-02-01T00:00:00.000Z',
    };
    const updated = updateFromProposals(
      history,
      [makeProposal({ id: 'rev-1' })],
      '2026-04-01T00:00:00.000Z',
    );
    expect(updated.entries['rev-1']!.pruned).toBe(false);
    expect(updated.entries['rev-1']!.pruned_at).toBeUndefined();
    expect(updated.entries['rev-1']!.occurrence_count).toBe(4);
  });

  it('does not mutate the input history', () => {
    const history: DirectiveHistory = {
      entries: { a: makeEntry({ id: 'a' }) },
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const snapshot = JSON.parse(JSON.stringify(history));
    updateFromProposals(history, [makeProposal({ id: 'a' })], '2026-04-01T00:00:00.000Z');
    expect(history).toEqual(snapshot);
  });
});

// ─── applyTTLAndCap ──────────────────────────────────────

describe('applyTTLAndCap', () => {
  it('prunes entries older than TTL (active set excludes them; history flags them)', () => {
    const history: DirectiveHistory = {
      entries: {
        fresh: makeEntry({
          id: 'fresh',
          last_reinforced: '2026-04-01T00:00:00.000Z',
        }),
        stale: makeEntry({
          id: 'stale',
          last_reinforced: '2026-02-15T00:00:00.000Z', // >30 days before 2026-04-01
        }),
      },
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap(history, now, 30, 25);
    expect(res.active.map((e) => e.id)).toEqual(['fresh']);
    expect(res.history.entries['stale']!.pruned).toBe(true);
    expect(res.history.entries['stale']!.pruned_at).toBe('2026-04-01T00:00:00.000Z');
    expect(res.history.entries['fresh']!.pruned).toBe(false);
  });

  it('30-day expiry boundary — exactly TTL is within the active window', () => {
    const history: DirectiveHistory = {
      entries: {
        edge: makeEntry({
          id: 'edge',
          last_reinforced: '2026-03-02T00:00:00.000Z', // exactly 30d before
        }),
      },
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap(history, now, 30, 25);
    expect(res.active.map((e) => e.id)).toEqual(['edge']);
  });

  it('caps active set at maxDirectives, drops lowest severity first', () => {
    const entries: Record<string, DirectiveHistoryEntry> = {};
    // 4 infos, 2 warnings, 1 error — cap at 3. Expect error + 2 warnings.
    for (let i = 0; i < 4; i++) {
      const id = `info-${i}`;
      entries[id] = makeEntry({
        id,
        severity: 'info',
        last_reinforced: '2026-04-01T00:00:00.000Z',
      });
    }
    for (let i = 0; i < 2; i++) {
      const id = `warn-${i}`;
      entries[id] = makeEntry({
        id,
        severity: 'warning',
        last_reinforced: '2026-04-01T00:00:00.000Z',
      });
    }
    entries['err-0'] = makeEntry({
      id: 'err-0',
      severity: 'error',
      last_reinforced: '2026-04-01T00:00:00.000Z',
    });

    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap({ entries, updated_at: '2026-04-01T00:00:00.000Z' }, now, 30, 3);
    expect(res.active).toHaveLength(3);
    expect(res.active.map((e) => e.severity)).toEqual(['error', 'warning', 'warning']);
    // All 4 infos are pruned in the history.
    for (let i = 0; i < 4; i++) {
      expect(res.history.entries[`info-${i}`]!.pruned).toBe(true);
    }
    // Error + both warnings remain un-pruned.
    expect(res.history.entries['err-0']!.pruned).toBe(false);
    expect(res.history.entries['warn-0']!.pruned).toBe(false);
    expect(res.history.entries['warn-1']!.pruned).toBe(false);
  });

  it('within same severity, drops oldest-reinforced first when capping', () => {
    const entries: Record<string, DirectiveHistoryEntry> = {
      old: makeEntry({
        id: 'old',
        severity: 'info',
        last_reinforced: '2026-03-15T00:00:00.000Z',
      }),
      recent: makeEntry({
        id: 'recent',
        severity: 'info',
        last_reinforced: '2026-03-30T00:00:00.000Z',
      }),
    };
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap({ entries, updated_at: '2026-04-01T00:00:00.000Z' }, now, 30, 1);
    expect(res.active.map((e) => e.id)).toEqual(['recent']);
    expect(res.history.entries['old']!.pruned).toBe(true);
  });

  it('sorts active set by severity DESC, last_reinforced DESC, id ASC', () => {
    const entries: Record<string, DirectiveHistoryEntry> = {
      a: makeEntry({
        id: 'a',
        severity: 'warning',
        last_reinforced: '2026-04-01T00:00:00.000Z',
      }),
      b: makeEntry({
        id: 'b',
        severity: 'error',
        last_reinforced: '2026-03-20T00:00:00.000Z',
      }),
      c: makeEntry({
        id: 'c',
        severity: 'warning',
        last_reinforced: '2026-04-01T00:00:00.000Z',
      }),
    };
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap({ entries, updated_at: '2026-04-01T00:00:00.000Z' }, now, 30, 25);
    expect(res.active.map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('clears stale-pruned flag when entry is fresh again', () => {
    const entries: Record<string, DirectiveHistoryEntry> = {
      revived: makeEntry({
        id: 'revived',
        pruned: true,
        pruned_at: '2026-02-01T00:00:00.000Z',
        last_reinforced: '2026-03-30T00:00:00.000Z',
      }),
    };
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap({ entries, updated_at: '2026-04-01T00:00:00.000Z' }, now, 30, 25);
    expect(res.active.map((e) => e.id)).toEqual(['revived']);
    expect(res.history.entries['revived']!.pruned).toBe(false);
    expect(res.history.entries['revived']!.pruned_at).toBeUndefined();
  });

  it('never mutates the input history', () => {
    const history: DirectiveHistory = {
      entries: { a: makeEntry({ id: 'a' }) },
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const snapshot = JSON.parse(JSON.stringify(history));
    applyTTLAndCap(history, new Date('2026-04-01T00:00:00.000Z'), 30, 25);
    expect(history).toEqual(snapshot);
  });
});

// ─── getDirectiveConfig ──────────────────────────────────

describe('getDirectiveConfig', () => {
  it('returns defaults when env is empty', () => {
    const c = getDirectiveConfig({});
    expect(c.ttlDays).toBe(DEFAULT_TTL_DAYS);
    expect(c.maxDirectives).toBe(DEFAULT_MAX_DIRECTIVES);
  });

  it('respects CLAUDE_SOP_DIRECTIVE_TTL_DAYS override', () => {
    const env = { [ENV_TTL_DAYS]: '7' } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.ttlDays).toBe(7);
    expect(c.maxDirectives).toBe(DEFAULT_MAX_DIRECTIVES);
  });

  it('respects CLAUDE_SOP_DIRECTIVE_MAX override', () => {
    const env = { [ENV_MAX_DIRECTIVES]: '12' } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.ttlDays).toBe(DEFAULT_TTL_DAYS);
    expect(c.maxDirectives).toBe(12);
  });

  it('ignores invalid env values and falls back to defaults', () => {
    const env = {
      [ENV_TTL_DAYS]: 'abc',
      [ENV_MAX_DIRECTIVES]: '-1',
    } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.ttlDays).toBe(DEFAULT_TTL_DAYS);
    expect(c.maxDirectives).toBe(DEFAULT_MAX_DIRECTIVES);
  });

  it('ignores non-integer values like floats', () => {
    const env = {
      [ENV_TTL_DAYS]: '1.5',
      [ENV_MAX_DIRECTIVES]: '10.7',
    } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.ttlDays).toBe(DEFAULT_TTL_DAYS);
    expect(c.maxDirectives).toBe(DEFAULT_MAX_DIRECTIVES);
  });
});

// ─── applyDirectiveHistory (integration) ─────────────────

describe('applyDirectiveHistory (end-to-end)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists history file and returns active set on first run', () => {
    const proposals = [
      makeProposal({ id: 'a', severity: 'error', rule_text: 'Alpha rule text here.' }),
      makeProposal({ id: 'b', severity: 'warning', rule_text: 'Beta rule text here.' }),
    ];
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyDirectiveHistory(root, proposals, {
      now,
      config: { ttlDays: 30, maxDirectives: 25 },
    });
    expect(res.active.map((e) => e.id)).toEqual(['a', 'b']);
    // File written.
    expect(existsSync(historyFile(root))).toBe(true);
    // Load it back.
    const loaded = loadHistory(root);
    expect(Object.keys(loaded.entries).sort()).toEqual(['a', 'b']);
  });

  it('history file persists after directives are pruned from active', () => {
    // Seed history with 3 infos; cap at 2 → one prunes.
    const seeded: DirectiveHistory = {
      entries: {
        i1: makeEntry({ id: 'i1', severity: 'info', last_reinforced: '2026-04-01T00:00:00.000Z' }),
        i2: makeEntry({ id: 'i2', severity: 'info', last_reinforced: '2026-04-01T00:00:00.000Z' }),
        i3: makeEntry({ id: 'i3', severity: 'info', last_reinforced: '2026-03-10T00:00:00.000Z' }),
      },
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    saveHistory(root, seeded);

    // No new proposals; just enforce the cap.
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyDirectiveHistory(root, [], {
      now,
      config: { ttlDays: 30, maxDirectives: 2 },
    });

    expect(res.active).toHaveLength(2);
    // History file STILL contains all 3 entries, but oldest is pruned.
    const loaded = loadHistory(root);
    expect(Object.keys(loaded.entries).sort()).toEqual(['i1', 'i2', 'i3']);
    expect(loaded.entries['i3']!.pruned).toBe(true);
  });

  it('re-seeing a pruned directive brings it back into the active set', () => {
    // Seed with a pruned entry.
    const seeded: DirectiveHistory = {
      entries: {
        comeback: makeEntry({
          id: 'comeback',
          rule_text: 'Old rule text that got pruned a while back.',
          severity: 'warning',
          pruned: true,
          pruned_at: '2026-02-01T00:00:00.000Z',
          last_reinforced: '2026-01-15T00:00:00.000Z',
        }),
      },
      updated_at: '2026-02-01T00:00:00.000Z',
    };
    saveHistory(root, seeded);

    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyDirectiveHistory(
      root,
      [
        makeProposal({
          id: 'comeback',
          severity: 'warning',
          rule_text: 'New-and-improved rule text on second appearance.',
        }),
      ],
      { now, config: { ttlDays: 30, maxDirectives: 25 } },
    );
    expect(res.active.map((e) => e.id)).toEqual(['comeback']);
    const loaded = loadHistory(root);
    expect(loaded.entries['comeback']!.pruned).toBe(false);
    expect(loaded.entries['comeback']!.pruned_at).toBeUndefined();
    expect(loaded.entries['comeback']!.last_reinforced).toBe('2026-04-01T00:00:00.000Z');
    // rule_text refreshed.
    expect(loaded.entries['comeback']!.rule_text).toContain('second appearance');
    // occurrence_count bumped.
    expect(loaded.entries['comeback']!.occurrence_count).toBe(2);
  });

  it('filters semantically duplicate proposals against existing active directives', () => {
    // Seed history with an existing directive.
    const seeded: DirectiveHistory = {
      entries: {
        existing: makeEntry({
          id: 'existing',
          severity: 'warning',
          rule_text: 'Never store API credentials directly in source code files',
          last_reinforced: '2026-03-30T00:00:00.000Z',
        }),
      },
      updated_at: '2026-03-30T00:00:00.000Z',
    };
    saveHistory(root, seeded);

    // Propose a near-duplicate — should be silently dropped.
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyDirectiveHistory(
      root,
      [
        makeProposal({
          id: 'dup-attempt',
          severity: 'warning',
          rule_text: 'Never store API credentials directly in your code files',
        }),
      ],
      { now, config: { ttlDays: 30, maxDirectives: 25 } },
    );

    // Only the original should remain — duplicate was dropped.
    expect(res.active).toHaveLength(1);
    expect(res.active[0]!.id).toBe('existing');
    // History should NOT contain the duplicate.
    const loaded = loadHistory(root);
    expect(loaded.entries['dup-attempt']).toBeUndefined();
  });

  it('allows non-duplicate proposals through alongside existing directives', () => {
    // Seed history with an existing directive.
    const seeded: DirectiveHistory = {
      entries: {
        existing: makeEntry({
          id: 'existing',
          severity: 'warning',
          rule_text: 'Never store API credentials directly in source code files',
          last_reinforced: '2026-03-30T00:00:00.000Z',
        }),
      },
      updated_at: '2026-03-30T00:00:00.000Z',
    };
    saveHistory(root, seeded);

    // Propose a completely different directive — should pass through.
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyDirectiveHistory(
      root,
      [
        makeProposal({
          id: 'brand-new',
          severity: 'info',
          rule_text: 'Always run tests before committing code changes to the repository',
        }),
      ],
      { now, config: { ttlDays: 30, maxDirectives: 25 } },
    );

    // Both should be active.
    expect(res.active).toHaveLength(2);
    expect(res.active.map((e) => e.id).sort()).toEqual(['brand-new', 'existing']);
  });

  it('honours env var overrides via getDirectiveConfig', () => {
    const proposals = Array.from({ length: 6 }, (_, i) =>
      makeProposal({
        id: `p-${i}`,
        severity: 'info',
        rule_text: `Rule number ${i} with distinct text content here.`,
      }),
    );
    const now = new Date('2026-04-01T00:00:00.000Z');

    const originalMax = process.env[ENV_MAX_DIRECTIVES];
    try {
      process.env[ENV_MAX_DIRECTIVES] = '2';
      const res = applyDirectiveHistory(root, proposals, { now });
      expect(res.active).toHaveLength(2);
    } finally {
      if (originalMax === undefined) delete process.env[ENV_MAX_DIRECTIVES];
      else process.env[ENV_MAX_DIRECTIVES] = originalMax;
    }
  });
});

// ─── APEX SEC-002 — long-pruned entry eviction ───────────

describe('APEX SEC-002: evicts entries pruned > 2×TTL ago', () => {
  it('removes an entry whose pruned_at is more than 2×ttlDays old', () => {
    // TTL 30 days → eviction threshold is 60 days.
    // Now = 2026-04-01; ancient pruned 90d ago, recent 45d ago. Both
    // have stale last_reinforced so the TTL pass keeps them pruned.
    const history: DirectiveHistory = {
      entries: {
        ancient: makeEntry({
          id: 'ancient',
          pruned: true,
          pruned_at: '2026-01-01T00:00:00.000Z',
          last_reinforced: '2025-12-01T00:00:00.000Z', // long-expired
        }),
        recent: makeEntry({
          id: 'recent',
          pruned: true,
          pruned_at: '2026-02-15T00:00:00.000Z', // ~45d ago
          last_reinforced: '2026-01-15T00:00:00.000Z', // also expired
        }),
      },
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap(history, now, 30, 25);
    // `ancient` evicted entirely (pruned_at > 60d ago).
    expect(res.history.entries['ancient']).toBeUndefined();
    // `recent` preserved — pruned_at is only ~45d ago, within 2×TTL.
    expect(res.history.entries['recent']).toBeDefined();
    expect(res.history.entries['recent']!.pruned).toBe(true);
  });

  it('does NOT evict entries pruned exactly at the 2×TTL boundary', () => {
    // Exactly 60 days — boundary is > 2×TTL, so equal = keep.
    const prunedAt = new Date(
      Date.UTC(2026, 1, 1, 0, 0, 0), // 2026-02-01 00:00 UTC
    );
    const now = new Date(prunedAt.getTime() + 60 * 24 * 60 * 60 * 1000);
    const history: DirectiveHistory = {
      entries: {
        boundary: makeEntry({
          id: 'boundary',
          pruned: true,
          pruned_at: prunedAt.toISOString(),
          last_reinforced: prunedAt.toISOString(),
        }),
      },
      updated_at: now.toISOString(),
    };
    const res = applyTTLAndCap(history, now, 30, 25);
    expect(res.history.entries['boundary']).toBeDefined();
  });

  it('leaves non-pruned entries alone even if last_reinforced is ancient', () => {
    // TTL would prune this via the normal pass, but SEC-002 must not
    // delete entries whose `pruned` flag is still false — the TTL
    // pass is responsible for flagging them first.
    const history: DirectiveHistory = {
      entries: {
        stale: makeEntry({
          id: 'stale',
          pruned: false,
          last_reinforced: '2025-12-01T00:00:00.000Z',
        }),
      },
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap(history, now, 30, 25);
    // The TTL pass prunes it — but it must still be present, just flagged.
    expect(res.history.entries['stale']).toBeDefined();
    expect(res.history.entries['stale']!.pruned).toBe(true);
  });

  it('ignores entries with non-parseable pruned_at (defensive)', () => {
    const history: DirectiveHistory = {
      entries: {
        garbled: {
          ...makeEntry({ id: 'garbled', pruned: true }),
          pruned_at: 'not a real iso timestamp',
        },
      },
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    const now = new Date('2026-04-01T00:00:00.000Z');
    const res = applyTTLAndCap(history, now, 30, 25);
    // Parse failure → no eviction (fail-safe).
    expect(res.history.entries['garbled']).toBeDefined();
  });
});

// ─── APEX SEC-003 — prototype pollution defense ──────────

describe('APEX SEC-003: __proto__ key in history file does not pollute Object.prototype', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not pollute Object.prototype when history file has __proto__ key', () => {
    mkdirSync(join(root, '.auto-sop', 'state'), { recursive: true });
    // Craft a JSON file whose entries contains a `__proto__` key with
    // an otherwise-valid entry shape. If the loader used a plain
    // object, assigning to `entriesOut['__proto__']` could pollute the
    // shared prototype.
    writeFileSync(
      historyFile(root),
      JSON.stringify({
        entries: {
          __proto__: {
            id: 'det-proto',
            rule_text: 'Attacker-controlled rule text that is long enough.',
            severity: 'warning',
            first_seen: '2026-01-01T00:00:00.000Z',
            last_reinforced: '2026-04-01T00:00:00.000Z',
            occurrence_count: 1,
            pruned: false,
            polluted: true, // this would be the leak-target
          },
        },
        updated_at: '2026-04-01T00:00:00.000Z',
      }),
    );

    const before = ({} as Record<string, unknown>).polluted;
    loadHistory(root);
    const after = ({} as Record<string, unknown>).polluted;
    expect(before).toBeUndefined();
    expect(after).toBeUndefined();
  });

  it('does not pollute Object.prototype via constructor key either', () => {
    mkdirSync(join(root, '.auto-sop', 'state'), { recursive: true });
    writeFileSync(
      historyFile(root),
      JSON.stringify({
        entries: {
          constructor: {
            id: 'det-ctor',
            rule_text: 'Another attacker-controlled rule text here and there.',
            severity: 'error',
            first_seen: '2026-01-01T00:00:00.000Z',
            last_reinforced: '2026-04-01T00:00:00.000Z',
            occurrence_count: 1,
            pruned: false,
          },
        },
        updated_at: '2026-04-01T00:00:00.000Z',
      }),
    );
    // Load must succeed and not mutate Object.prototype.constructor
    // (we can't directly assert that since it's already defined, but
    // we can at least confirm load doesn't throw and gives us the
    // entry under the expected key).
    const h = loadHistory(root);
    expect(h.entries).toBeDefined();
  });
});

// ─── APEX SEC-005 — env var caps ─────────────────────────

describe('APEX SEC-005: env var overrides capped at sane upper bounds', () => {
  it('rejects CLAUDE_SOP_DIRECTIVE_TTL_DAYS above 3650 → fallback to default', () => {
    const env = { [ENV_TTL_DAYS]: '4000' } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.ttlDays).toBe(DEFAULT_TTL_DAYS);
  });

  it('accepts CLAUDE_SOP_DIRECTIVE_TTL_DAYS at exactly 3650', () => {
    const env = { [ENV_TTL_DAYS]: '3650' } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.ttlDays).toBe(3650);
  });

  it('rejects CLAUDE_SOP_DIRECTIVE_MAX above 1000 → fallback to default', () => {
    const env = { [ENV_MAX_DIRECTIVES]: '10000' } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.maxDirectives).toBe(DEFAULT_MAX_DIRECTIVES);
  });

  it('accepts CLAUDE_SOP_DIRECTIVE_MAX at exactly 1000', () => {
    const env = { [ENV_MAX_DIRECTIVES]: '1000' } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.maxDirectives).toBe(1000);
  });

  it('rejects absurd values (Number.MAX_SAFE_INTEGER) gracefully', () => {
    const env = {
      [ENV_TTL_DAYS]: String(Number.MAX_SAFE_INTEGER),
      [ENV_MAX_DIRECTIVES]: String(Number.MAX_SAFE_INTEGER),
    } as NodeJS.ProcessEnv;
    const c = getDirectiveConfig(env);
    expect(c.ttlDays).toBe(DEFAULT_TTL_DAYS);
    expect(c.maxDirectives).toBe(DEFAULT_MAX_DIRECTIVES);
  });
});

// ─── APEX SEC-006 — state dir mode ───────────────────────

describe('APEX SEC-006: saveHistory creates 0700 state directory', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates .auto-sop/state with user-only (0o700) mode', () => {
    // POSIX-only — on Windows, file-mode bits are not meaningful.
    if (process.platform === 'win32') return;
    saveHistory(root, emptyHistory());
    const dirStat = statSync(join(root, '.auto-sop', 'state'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});

// ─── SEC-L01 / SEC-L02 hardening tests ─────────────────

describe('SEC-L01: string length capping in coerceEntry', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('truncates oversized id and rule_text on load', () => {
    const longId = 'x'.repeat(100_000);
    const longRule = 'r'.repeat(100_000);
    const raw = {
      entries: {
        [longId]: {
          id: longId,
          rule_text: longRule,
          severity: 'info',
          first_seen: '2025-01-01T00:00:00.000Z',
          last_reinforced: '2025-01-01T00:00:00.000Z',
          occurrence_count: 1,
          pruned: false,
        },
      },
      updated_at: '2025-01-01T00:00:00.000Z',
    };
    mkdirSync(join(root, '.auto-sop', 'state'), { recursive: true });
    writeFileSync(join(root, '.auto-sop', 'state', 'directive-history.json'), JSON.stringify(raw));
    const h = loadHistory(root);
    const entries = Object.values(h.entries);
    expect(entries.length).toBe(1);
    expect(entries[0].id.length).toBeLessThanOrEqual(256);
    expect(entries[0].rule_text.length).toBeLessThanOrEqual(2048);
  });
});

describe('SEC-L02: reserved key filtering in applyTTLAndCap', () => {
  it('skips __proto__, constructor, prototype keys', () => {
    const now = new Date('2025-06-01T00:00:00.000Z');
    const entry = makeEntry({
      id: 'legit',
      rule_text: 'legit rule',
      first_seen: '2025-05-01T00:00:00.000Z',
      last_reinforced: '2025-05-30T00:00:00.000Z',
    });
    const poisoned: DirectiveHistory = {
      entries: Object.create(null) as Record<string, DirectiveHistoryEntry>,
      updated_at: '2025-05-30T00:00:00.000Z',
    };
    // Add legitimate + reserved keys
    poisoned.entries['legit'] = entry;
    // Force reserved keys via Object.defineProperty to bypass Object.create(null)
    Object.defineProperty(poisoned.entries, '__proto__', {
      value: { ...entry, id: '__proto__' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(poisoned.entries, 'constructor', {
      value: { ...entry, id: 'constructor' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(poisoned.entries, 'prototype', {
      value: { ...entry, id: 'prototype' },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const result = applyTTLAndCap(poisoned, now, 30, 25);
    // Only 'legit' should survive
    expect(result.active.length).toBe(1);
    expect(result.active[0].id).toBe('legit');
    const historyKeys = Object.keys(result.history.entries);
    expect(historyKeys).not.toContain('__proto__');
    expect(historyKeys).not.toContain('constructor');
    expect(historyKeys).not.toContain('prototype');
  });
});

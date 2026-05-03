/**
 * Unit tests for src/learner/pattern-store.ts
 *
 * Covers:
 *   - read/write round-trip
 *   - merge with overlapping session_ids
 *   - graduation threshold (3+ distinct sessions)
 *   - prune stale candidates
 *   - malformed line handling
 *   - empty file / missing file handling
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  readCandidates,
  writeCandidates,
  mergeCandidateEvidence,
  graduateCandidates,
  pruneStaleCandidates,
  isSemanticallyDuplicate,
  timeWindowKey,
  type PatternCandidate,
} from '../../src/learner/pattern-store.js';
import { generateProposalId } from '../../src/learner/directive-schema.js';

// ── Test helpers ──────────────────────────────────────────

function makeCandidate(overrides: Partial<PatternCandidate> = {}): PatternCandidate {
  const pattern = overrides.pattern ?? 'test pattern';
  return {
    id: generateProposalId('llm-inc', pattern),
    pattern,
    severity: 'warning',
    rule_text: 'Always check exit codes before proceeding with the next step.',
    session_ids: ['s1'],
    turn_ids: ['t1'],
    occurrence_count: 1,
    first_seen: '2026-04-01T00:00:00.000Z',
    last_seen: '2026-04-20T00:00:00.000Z',
    graduated: false,
    ...overrides,
  };
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `pattern-store-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ── Read / Write ──────────────────────────────────────────

describe('readCandidates', () => {
  it('returns empty array when file is missing', () => {
    const result = readCandidates(testDir);
    expect(result).toEqual([]);
  });

  it('returns empty array when file is empty', () => {
    writeFileSync(join(testDir, 'pattern-candidates.jsonl'), '');
    const result = readCandidates(testDir);
    expect(result).toEqual([]);
  });

  it('skips malformed lines and returns valid ones', () => {
    const valid = makeCandidate({ pattern: 'good pattern' });
    const content = [
      JSON.stringify(valid),
      'this is not json',
      '{"id": "bad", "missing": "fields"}',
      '',
    ].join('\n');
    writeFileSync(join(testDir, 'pattern-candidates.jsonl'), content);

    const result = readCandidates(testDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.pattern).toBe('good pattern');
  });

  it('handles file with only blank lines', () => {
    writeFileSync(join(testDir, 'pattern-candidates.jsonl'), '\n\n\n');
    const result = readCandidates(testDir);
    expect(result).toEqual([]);
  });
});

describe('writeCandidates', () => {
  it('creates the file if it does not exist', () => {
    const candidates = [makeCandidate()];
    writeCandidates(testDir, candidates);

    const raw = readFileSync(join(testDir, 'pattern-candidates.jsonl'), 'utf8');
    expect(raw.trim().length).toBeGreaterThan(0);
  });

  it('overwrites existing content atomically', () => {
    const first = [makeCandidate({ pattern: 'first' })];
    writeCandidates(testDir, first);

    const second = [makeCandidate({ pattern: 'second' })];
    writeCandidates(testDir, second);

    const result = readCandidates(testDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.pattern).toBe('second');
  });

  it('creates parent directories if needed', () => {
    const nested = join(testDir, 'deep', 'nested', 'dir');
    writeCandidates(nested, [makeCandidate()]);
    const result = readCandidates(nested);
    expect(result).toHaveLength(1);
  });
});

describe('read/write round-trip', () => {
  it('preserves all fields through write then read', () => {
    const candidate = makeCandidate({
      pattern: 'round-trip test',
      severity: 'error',
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1', 't2', 't3', 't4'],
      occurrence_count: 7,
      first_seen: '2026-01-15T08:30:00.000Z',
      last_seen: '2026-04-20T14:22:00.000Z',
      graduated: true,
      graduated_at: '2026-04-20T14:22:00.000Z',
    });

    writeCandidates(testDir, [candidate]);
    const result = readCandidates(testDir);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(candidate);
  });

  it('round-trips multiple candidates', () => {
    const candidates = [
      makeCandidate({ pattern: 'alpha' }),
      makeCandidate({ pattern: 'beta', severity: 'info' }),
      makeCandidate({ pattern: 'gamma', severity: 'error' }),
    ];

    writeCandidates(testDir, candidates);
    const result = readCandidates(testDir);

    expect(result).toHaveLength(3);
    expect(result).toEqual(candidates);
  });

  it('round-trips empty array', () => {
    writeCandidates(testDir, []);
    const result = readCandidates(testDir);
    expect(result).toEqual([]);
  });
});

// ── Merge ──────────────────────────────────────────────────

describe('mergeCandidateEvidence', () => {
  it('appends new candidates that have no id match', () => {
    const existing = [
      makeCandidate({
        pattern: 'existing',
        rule_text: 'Always run tests before committing code changes to the repository',
      }),
    ];
    const incoming = [
      makeCandidate({
        pattern: 'brand new',
        rule_text: 'Never store API credentials directly in source code files',
      }),
    ];

    const result = mergeCandidateEvidence(existing, incoming);
    expect(result).toHaveLength(2);
  });

  it('merges session_ids as union for matching ids', () => {
    const id = generateProposalId('llm-inc', 'same pattern');
    const existing = [makeCandidate({ id, pattern: 'same pattern', session_ids: ['s1', 's2'] })];
    const incoming = [makeCandidate({ id, pattern: 'same pattern', session_ids: ['s2', 's3'] })];

    const result = mergeCandidateEvidence(existing, incoming);
    expect(result).toHaveLength(1);
    expect(new Set(result[0]!.session_ids)).toEqual(new Set(['s1', 's2', 's3']));
  });

  it('merges turn_ids as union for matching ids', () => {
    const id = generateProposalId('llm-inc', 'same pattern');
    const existing = [makeCandidate({ id, pattern: 'same pattern', turn_ids: ['t1', 't2'] })];
    const incoming = [makeCandidate({ id, pattern: 'same pattern', turn_ids: ['t2', 't3'] })];

    const result = mergeCandidateEvidence(existing, incoming);
    expect(result).toHaveLength(1);
    expect(new Set(result[0]!.turn_ids)).toEqual(new Set(['t1', 't2', 't3']));
  });

  it('sums occurrence_count on merge', () => {
    const id = generateProposalId('llm-inc', 'counted');
    const existing = [makeCandidate({ id, pattern: 'counted', occurrence_count: 3 })];
    const incoming = [makeCandidate({ id, pattern: 'counted', occurrence_count: 2 })];

    const result = mergeCandidateEvidence(existing, incoming);
    expect(result[0]!.occurrence_count).toBe(5);
  });

  it('uses latest last_seen timestamp', () => {
    const id = generateProposalId('llm-inc', 'timed');
    const existing = [
      makeCandidate({ id, pattern: 'timed', last_seen: '2026-04-10T00:00:00.000Z' }),
    ];
    const incoming = [
      makeCandidate({ id, pattern: 'timed', last_seen: '2026-04-20T00:00:00.000Z' }),
    ];

    const result = mergeCandidateEvidence(existing, incoming);
    expect(result[0]!.last_seen).toBe('2026-04-20T00:00:00.000Z');
  });

  it('keeps existing last_seen if it is later', () => {
    const id = generateProposalId('llm-inc', 'timed');
    const existing = [
      makeCandidate({ id, pattern: 'timed', last_seen: '2026-04-25T00:00:00.000Z' }),
    ];
    const incoming = [
      makeCandidate({ id, pattern: 'timed', last_seen: '2026-04-10T00:00:00.000Z' }),
    ];

    const result = mergeCandidateEvidence(existing, incoming);
    expect(result[0]!.last_seen).toBe('2026-04-25T00:00:00.000Z');
  });

  it('does not mutate input arrays', () => {
    const existing = [
      makeCandidate({
        pattern: 'immutable',
        rule_text: 'First immutable rule text for testing mutation safety',
      }),
    ];
    const incoming = [
      makeCandidate({
        pattern: 'immutable2',
        rule_text: 'Second immutable rule text completely different content',
      }),
    ];
    const existingCopy = JSON.parse(JSON.stringify(existing));
    const incomingCopy = JSON.parse(JSON.stringify(incoming));

    mergeCandidateEvidence(existing, incoming);

    expect(existing).toEqual(existingCopy);
    expect(incoming).toEqual(incomingCopy);
  });

  it('handles empty existing array', () => {
    const incoming = [
      makeCandidate({
        pattern: 'fresh',
        rule_text: 'Fresh candidate rule text for testing empty array handling',
      }),
    ];
    const result = mergeCandidateEvidence([], incoming);
    expect(result).toHaveLength(1);
  });

  it('handles empty incoming array', () => {
    const existing = [
      makeCandidate({
        pattern: 'stable',
        rule_text: 'Stable candidate rule text for testing empty array handling',
      }),
    ];
    const result = mergeCandidateEvidence(existing, []);
    expect(result).toHaveLength(1);
  });
});

// ── Graduate ───────────────────────────────────────────────

describe('graduateCandidates', () => {
  it('graduates candidates with >= 3 distinct session_ids', () => {
    const candidate = makeCandidate({
      pattern: 'ready to graduate',
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1', 't2', 't3'],
      occurrence_count: 5,
    });

    const { graduated } = graduateCandidates([candidate]);

    expect(graduated).toHaveLength(1);
    expect(graduated[0]!.id).toBe(candidate.id);
    expect(graduated[0]!.detector).toBe('llm-inc');
    expect(graduated[0]!.severity).toBe('warning');
    expect(graduated[0]!.rule_text).toBe(candidate.rule_text);
    expect(graduated[0]!.evidence.session_ids).toEqual(['s1', 's2', 's3']);
    expect(graduated[0]!.evidence.turn_ids).toEqual(['t1', 't2', 't3']);
    expect(graduated[0]!.evidence.pattern).toBe('ready to graduate');
    expect(graduated[0]!.evidence.occurrence_count).toBe(5);
    expect(graduated[0]!.created_at).toBeDefined();
  });

  it('marks graduated candidates in updated array', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's3'],
    });

    const { updated } = graduateCandidates([candidate]);

    expect(updated[0]!.graduated).toBe(true);
    expect(updated[0]!.graduated_at).toBeDefined();
  });

  it('does NOT graduate candidates with < 3 distinct sessions', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2'],
    });

    const { graduated, updated } = graduateCandidates([candidate]);

    expect(graduated).toHaveLength(0);
    expect(updated[0]!.graduated).toBe(false);
  });

  it('does NOT re-graduate already graduated candidates', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's3', 's4'],
      graduated: true,
      graduated_at: '2026-04-15T00:00:00.000Z',
    });

    const { graduated, updated } = graduateCandidates([candidate]);

    expect(graduated).toHaveLength(0);
    expect(updated[0]!.graduated).toBe(true);
    // Should preserve original graduated_at, not update it
    expect(updated[0]!.graduated_at).toBe('2026-04-15T00:00:00.000Z');
  });

  it('handles duplicate session_ids — counts distinct only', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's1', 's2', 's1'],
    });

    const { graduated } = graduateCandidates([candidate]);
    expect(graduated).toHaveLength(0);
  });

  it('graduates exactly at threshold of 3 distinct sessions', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1'],
      occurrence_count: 3,
    });

    const { graduated } = graduateCandidates([candidate]);
    expect(graduated).toHaveLength(1);
  });

  it('handles mixed graduated and non-graduated candidates', () => {
    const candidates = [
      makeCandidate({
        pattern: 'already done',
        graduated: true,
        session_ids: ['s1', 's2', 's3'],
      }),
      makeCandidate({
        pattern: 'ready now',
        session_ids: ['s1', 's2', 's3'],
      }),
      makeCandidate({
        pattern: 'not yet',
        session_ids: ['s1'],
      }),
    ];

    const { graduated, updated } = graduateCandidates(candidates);
    expect(graduated).toHaveLength(1);
    expect(graduated[0]!.evidence.pattern).toBe('ready now');
    expect(updated).toHaveLength(3);
  });

  it('returns empty graduated array when none qualify', () => {
    const { graduated } = graduateCandidates([
      makeCandidate({ session_ids: ['s1'] }),
      makeCandidate({ pattern: 'p2', session_ids: ['s1', 's2'] }),
    ]);
    expect(graduated).toEqual([]);
  });

  it('handles empty input', () => {
    const { graduated, updated } = graduateCandidates([]);
    expect(graduated).toEqual([]);
    expect(updated).toEqual([]);
  });
});

// ── Prune ──────────────────────────────────────────────────

describe('pruneStaleCandidates', () => {
  it('removes non-graduated candidates older than maxAgeDays', () => {
    const old = makeCandidate({
      pattern: 'old',
      last_seen: '2025-01-01T00:00:00.000Z',
      graduated: false,
    });
    const fresh = makeCandidate({
      pattern: 'fresh',
      last_seen: new Date().toISOString(),
      graduated: false,
    });

    const result = pruneStaleCandidates([old, fresh], 30);
    expect(result).toHaveLength(1);
    expect(result[0]!.pattern).toBe('fresh');
  });

  it('never prunes graduated candidates regardless of age', () => {
    const oldGraduated = makeCandidate({
      pattern: 'old graduated',
      last_seen: '2020-01-01T00:00:00.000Z',
      graduated: true,
    });

    const result = pruneStaleCandidates([oldGraduated], 30);
    expect(result).toHaveLength(1);
  });

  it('uses default maxAgeDays of 30 when not specified', () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();

    const old = makeCandidate({ pattern: 'old', last_seen: thirtyOneDaysAgo });
    const recent = makeCandidate({ pattern: 'recent', last_seen: twentyNineDaysAgo });

    const result = pruneStaleCandidates([old, recent]);
    expect(result).toHaveLength(1);
    expect(result[0]!.pattern).toBe('recent');
  });

  it('handles empty array', () => {
    const result = pruneStaleCandidates([], 30);
    expect(result).toEqual([]);
  });

  it('keeps all candidates when none are stale', () => {
    const now = new Date().toISOString();
    const candidates = [
      makeCandidate({ pattern: 'a', last_seen: now }),
      makeCandidate({ pattern: 'b', last_seen: now }),
    ];

    const result = pruneStaleCandidates(candidates, 30);
    expect(result).toHaveLength(2);
  });
});

// ── BUG-D1: Semantic dedup ───────────────────────────────

describe('isSemanticallyDuplicate', () => {
  it('detects near-duplicate rule texts (same meaning, different words)', () => {
    const a = 'Never store API credentials directly in source code files';
    const b = 'Never store API credentials directly in your code files';
    expect(isSemanticallyDuplicate(a, b)).toBe(true);
  });

  it('returns false for completely different rule texts', () => {
    const a = 'Always run tests before committing code changes';
    const b = 'Never store API credentials directly in source code files';
    expect(isSemanticallyDuplicate(a, b)).toBe(false);
  });

  it('returns false when one text has too few keywords (empty extraction)', () => {
    const a = 'Do it';
    const b = 'Never store API credentials directly in source code files';
    expect(isSemanticallyDuplicate(a, b)).toBe(false);
  });

  it('returns false when both texts are very short', () => {
    expect(isSemanticallyDuplicate('ab', 'cd')).toBe(false);
  });

  it('detects exact duplicates', () => {
    const text = 'Always check exit codes before proceeding with the next step';
    expect(isSemanticallyDuplicate(text, text)).toBe(true);
  });

  it('detects duplicates with minor wording changes', () => {
    const a = 'Always verify database connection before running queries against the database';
    const b = 'Always verify database connection before executing queries against the database';
    expect(isSemanticallyDuplicate(a, b)).toBe(true);
  });

  it('does NOT treat "unit tests" vs "integration tests" as duplicates (Jaccard 0.714 < 0.75)', () => {
    // These share 5/7 keywords → Jaccard = 0.714.
    // At 0.75 threshold this should NOT be a duplicate — they are
    // meaningfully different directives.
    const a = 'Always run unit tests before committing changes';
    const b = 'Always run integration tests before committing changes';
    expect(isSemanticallyDuplicate(a, b)).toBe(false);
  });
});

describe('mergeCandidateEvidence — semantic dedup (BUG-D1)', () => {
  it('merges semantically duplicate incoming candidate into existing', () => {
    const existing = [
      makeCandidate({
        pattern: 'credentials-in-code',
        rule_text: 'Never store API credentials directly in source code files',
        session_ids: ['s1'],
      }),
    ];
    const incoming = [
      makeCandidate({
        id: 'different-id',
        pattern: 'creds-in-source',
        rule_text: 'Never store API credentials directly in your code files',
        session_ids: ['s2'],
      }),
    ];

    const result = mergeCandidateEvidence(existing, incoming);
    // Should merge into existing, not create a new entry
    expect(result).toHaveLength(1);
    expect(new Set(result[0]!.session_ids)).toEqual(new Set(['s1', 's2']));
  });

  it('appends non-duplicate incoming candidate', () => {
    const existing = [
      makeCandidate({
        pattern: 'test-pattern',
        rule_text: 'Always run tests before committing code changes',
        session_ids: ['s1'],
      }),
    ];
    const incoming = [
      makeCandidate({
        id: 'different-id',
        pattern: 'credential-pattern',
        rule_text: 'Never store API credentials directly in source code files',
        session_ids: ['s2'],
      }),
    ];

    const result = mergeCandidateEvidence(existing, incoming);
    expect(result).toHaveLength(2);
  });
});

// ── BUG-S1: Observation windows ──────────────────────────

describe('timeWindowKey', () => {
  it('returns hour-truncated timestamp for matching session', () => {
    const turns = [
      { session_id: 's1', finalized_at: '2026-04-25T17:30:00.000Z' },
      { session_id: 's1', finalized_at: '2026-04-25T17:45:00.000Z' },
    ];
    expect(timeWindowKey('s1', turns)).toBe('2026-04-25T17');
  });

  it('returns earliest timestamp when multiple turns exist', () => {
    const turns = [
      { session_id: 's1', finalized_at: '2026-04-25T18:00:00.000Z' },
      { session_id: 's1', finalized_at: '2026-04-25T17:30:00.000Z' },
      { session_id: 's1', finalized_at: '2026-04-25T19:00:00.000Z' },
    ];
    expect(timeWindowKey('s1', turns)).toBe('2026-04-25T17');
  });

  it('returns "unknown" when no turns match session', () => {
    const turns = [{ session_id: 's2', finalized_at: '2026-04-25T17:30:00.000Z' }];
    expect(timeWindowKey('s1', turns)).toBe('unknown');
  });

  it('returns "unknown" for empty turns array', () => {
    expect(timeWindowKey('s1', [])).toBe('unknown');
  });
});

describe('mergeCandidateEvidence — observation windows (BUG-S1)', () => {
  it('tracks observation windows when sessionWindowMap is provided', () => {
    const existing = [
      makeCandidate({
        pattern: 'test-pattern-a',
        session_ids: ['s1'],
        rule_text: 'Always run tests before committing code changes to the repository',
      }),
    ];
    const incoming = [
      makeCandidate({
        pattern: 'test-pattern-b',
        session_ids: ['s2'],
        rule_text: 'Never store API credentials directly in source code files',
      }),
    ];
    const windowMap = new Map([
      ['s1', '2026-04-25T17'],
      ['s2', '2026-04-25T18'],
    ]);

    const result = mergeCandidateEvidence(existing, incoming, windowMap);
    expect(result).toHaveLength(2); // different IDs and different rule_texts
  });

  it('initializes observation_windows for new candidates', () => {
    const existing: PatternCandidate[] = [];
    const incoming = [
      makeCandidate({
        session_ids: ['s1', 's2'],
      }),
    ];
    const windowMap = new Map([
      ['s1', '2026-04-25T17'],
      ['s2', '2026-04-25T18'],
    ]);

    const result = mergeCandidateEvidence(existing, incoming, windowMap);
    expect(result[0]!.observation_windows).toBeDefined();
    expect(new Set(result[0]!.observation_windows)).toEqual(
      new Set(['2026-04-25T17', '2026-04-25T18']),
    );
  });

  it('accumulates observation_windows from both sides during merge', () => {
    const id = generateProposalId('llm-inc', 'test-pattern-a');
    const existing = [
      makeCandidate({
        id,
        pattern: 'test-pattern-a',
        session_ids: ['s1'],
        rule_text: 'Always validate credentials before API calls',
        observation_windows: ['2026-04-25T17'],
      }),
    ];
    const incoming = [
      makeCandidate({
        id,
        pattern: 'test-pattern-a',
        session_ids: ['s2'],
        rule_text: 'Always validate credentials before API calls',
      }),
    ];
    const windowMap = new Map([
      ['s1', '2026-04-25T17'],
      ['s2', '2026-04-25T18'],
    ]);

    const result = mergeCandidateEvidence(existing, incoming, windowMap);
    expect(result).toHaveLength(1);
    expect(result[0]!.observation_windows).toBeDefined();
    expect(new Set(result[0]!.observation_windows)).toEqual(
      new Set(['2026-04-25T17', '2026-04-25T18']),
    );
  });

  it('does not add observation_windows when no sessionWindowMap provided', () => {
    const existing: PatternCandidate[] = [];
    const incoming = [makeCandidate({ session_ids: ['s1'] })];

    const result = mergeCandidateEvidence(existing, incoming);
    expect(result[0]!.observation_windows).toBeUndefined();
  });
});

describe('graduateCandidates — observation windows (BUG-S1)', () => {
  it('21 sessions in same hour = 1 observation window → does NOT graduate', () => {
    const sessionIds = Array.from({ length: 21 }, (_, i) => `s${i + 1}`);
    const candidate = makeCandidate({
      session_ids: sessionIds,
      observation_windows: ['2026-04-25T17'], // all in the same hour
    });

    const { graduated } = graduateCandidates([candidate]);
    expect(graduated).toHaveLength(0);
  });

  it('3 sessions in different hours = 3 windows → graduates', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's3'],
      observation_windows: ['2026-04-25T14', '2026-04-25T15', '2026-04-25T16'],
    });

    const { graduated } = graduateCandidates([candidate]);
    expect(graduated).toHaveLength(1);
  });

  it('old candidates without observation_windows → uses session count (backward compat)', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's3'],
      // No observation_windows — old candidate
    });

    const { graduated } = graduateCandidates([candidate]);
    expect(graduated).toHaveLength(1);
  });

  it('2 windows with 10 sessions each → does NOT graduate', () => {
    const sessionIds = Array.from({ length: 20 }, (_, i) => `s${i + 1}`);
    const candidate = makeCandidate({
      session_ids: sessionIds,
      observation_windows: ['2026-04-25T17', '2026-04-25T18'],
    });

    const { graduated } = graduateCandidates([candidate]);
    expect(graduated).toHaveLength(0);
  });

  it('exactly 3 windows → graduates', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's3'],
      observation_windows: ['2026-04-25T14', '2026-04-25T15', '2026-04-25T16'],
      occurrence_count: 3,
    });

    const { graduated } = graduateCandidates([candidate]);
    expect(graduated).toHaveLength(1);
  });

  it('all-unknown observation_windows → does NOT graduate (distinctWindows = 0 after filtering)', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's3'],
      observation_windows: ['unknown', 'unknown', 'unknown'],
    });

    const { graduated } = graduateCandidates([candidate]);
    // 'unknown' windows filtered out → 0 valid windows.
    // Since observation_windows was set, no fallback to session count.
    expect(graduated).toHaveLength(0);
  });

  it('mixed unknown + valid windows → counts only valid (2 not 3)', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's2', 's3'],
      observation_windows: ['2026-04-25T17', 'unknown', '2026-04-26T10'],
    });

    const { graduated } = graduateCandidates([candidate]);
    // 2 valid distinct windows < 3 → does NOT graduate
    expect(graduated).toHaveLength(0);
  });
});

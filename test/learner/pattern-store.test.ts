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
    const existing = [makeCandidate({ pattern: 'existing' })];
    const incoming = [makeCandidate({ pattern: 'brand new' })];

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
    const existing = [makeCandidate({ pattern: 'immutable' })];
    const incoming = [makeCandidate({ pattern: 'immutable2' })];
    const existingCopy = JSON.parse(JSON.stringify(existing));
    const incomingCopy = JSON.parse(JSON.stringify(incoming));

    mergeCandidateEvidence(existing, incoming);

    expect(existing).toEqual(existingCopy);
    expect(incoming).toEqual(incomingCopy);
  });

  it('handles empty existing array', () => {
    const incoming = [makeCandidate({ pattern: 'fresh' })];
    const result = mergeCandidateEvidence([], incoming);
    expect(result).toHaveLength(1);
  });

  it('handles empty incoming array', () => {
    const existing = [makeCandidate({ pattern: 'stable' })];
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

    const { graduated, updated } = graduateCandidates([candidate]);

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

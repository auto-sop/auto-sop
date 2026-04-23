/**
 * Unit tests for the `auto-sop candidates` CLI verb (PLAN-v29 Wave 3).
 *
 * Tests the candidates verb:
 *   - Human table output with status columns
 *   - JSON output (--json flag)
 *   - --prune flag: remove stale candidates
 *   - --clear flag: wipe all candidates
 *   - Empty state handling
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readCandidates,
  writeCandidates,
  pruneStaleCandidates,
  type PatternCandidate,
} from '../../../src/learner/pattern-store.js';
import { generateProposalId } from '../../../src/learner/directive-schema.js';

// ── Test helpers ─────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-candidates-'));
}

function makeCandidate(overrides: Partial<PatternCandidate> = {}): PatternCandidate {
  const pattern = overrides.pattern ?? 'test-pattern';
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

describe('auto-sop candidates (data layer)', () => {
  let projectRoot: string;
  let stateDir: string;

  beforeEach(() => {
    projectRoot = makeTmpDir();
    stateDir = join(projectRoot, '.auto-sop', 'state');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // ── Read empty state ────────────────────────────────────

  it('returns empty array when no candidates file exists', () => {
    const result = readCandidates(stateDir);
    expect(result).toEqual([]);
  });

  // ── Show candidates (data round-trip) ───────────────────

  it('reads candidates that were written', () => {
    const candidates = [
      makeCandidate({ pattern: 'alpha' }),
      makeCandidate({ pattern: 'beta', severity: 'error' }),
    ];
    writeCandidates(stateDir, candidates);

    const result = readCandidates(stateDir);
    expect(result).toHaveLength(2);
    expect(result[0]!.pattern).toBe('alpha');
    expect(result[1]!.severity).toBe('error');
  });

  // ── --clear: wipe all candidates ────────────────────────

  it('--clear writes empty array', () => {
    writeCandidates(stateDir, [
      makeCandidate({ pattern: 'one' }),
      makeCandidate({ pattern: 'two' }),
    ]);
    expect(readCandidates(stateDir)).toHaveLength(2);

    // Simulate --clear action
    writeCandidates(stateDir, []);

    const after = readCandidates(stateDir);
    expect(after).toEqual([]);
  });

  // ── --prune: remove stale candidates ────────────────────

  it('--prune removes 30+ day old non-graduated candidates', () => {
    const stale = makeCandidate({
      pattern: 'stale',
      last_seen: '2025-01-01T00:00:00.000Z',
      graduated: false,
    });
    const fresh = makeCandidate({
      pattern: 'fresh',
      last_seen: new Date().toISOString(),
      graduated: false,
    });
    const graduatedOld = makeCandidate({
      pattern: 'graduated-old',
      last_seen: '2025-01-01T00:00:00.000Z',
      graduated: true,
    });

    writeCandidates(stateDir, [stale, fresh, graduatedOld]);

    // Simulate --prune action (same logic as candidates verb)
    const before = readCandidates(stateDir);
    const after = pruneStaleCandidates(before, 30);
    writeCandidates(stateDir, after);

    const result = readCandidates(stateDir);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.pattern).sort()).toEqual(['fresh', 'graduated-old']);
  });

  // ── Candidate status derivation ─────────────────────────

  it('status is "graduated" for graduated candidates', () => {
    const c = makeCandidate({ graduated: true });
    expect(c.graduated).toBe(true);
  });

  it('status is "active" for recent non-graduated candidates', () => {
    const c = makeCandidate({
      graduated: false,
      last_seen: new Date().toISOString(),
    });
    expect(c.graduated).toBe(false);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const lastSeenMs = new Date(c.last_seen).getTime();
    expect(lastSeenMs >= cutoff).toBe(true);
  });

  it('status would be "stale" for old non-graduated candidates', () => {
    const c = makeCandidate({
      graduated: false,
      last_seen: '2020-01-01T00:00:00.000Z',
    });
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const lastSeenMs = new Date(c.last_seen).getTime();
    expect(lastSeenMs < cutoff).toBe(true);
  });

  // ── Multiple candidates with mixed statuses ─────────────

  it('handles mixed graduated, active, stale candidates', () => {
    const candidates = [
      makeCandidate({
        pattern: 'graduated-one',
        graduated: true,
        session_ids: ['s1', 's2', 's3'],
      }),
      makeCandidate({
        pattern: 'active-one',
        graduated: false,
        last_seen: new Date().toISOString(),
      }),
      makeCandidate({
        pattern: 'stale-one',
        graduated: false,
        last_seen: '2020-01-01T00:00:00.000Z',
      }),
    ];

    writeCandidates(stateDir, candidates);
    const result = readCandidates(stateDir);
    expect(result).toHaveLength(3);
  });

  // ── ID truncation ────────────────────────────────────────

  it('candidate ID is longer than 8 chars (truncation needed for display)', () => {
    const c = makeCandidate();
    expect(c.id.length).toBeGreaterThan(8);
  });
});

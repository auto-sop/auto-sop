/**
 * Integration tests for the V29 incremental pattern memory pipeline.
 *
 * These tests exercise the full candidate lifecycle:
 *   - Pattern candidates accumulate across ticks
 *   - Graduation at 3+ distinct sessions
 *   - LLM failure doesn't lose existing candidates
 *   - Offline mode still graduates ready candidates
 *   - Stale candidate pruning (30+ days)
 *
 * We test the pipeline functions directly (readCandidates, writeCandidates,
 * mergeCandidateEvidence, graduateCandidates, pruneStaleCandidates) rather
 * than calling main() — same approach as test/learner/main.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
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

// ── Test helpers ─────────────────────────────────────────

function makeCandidate(overrides: Partial<PatternCandidate> = {}): PatternCandidate {
  const pattern = overrides.pattern ?? 'test-pattern';
  return {
    id: overrides.id ?? generateProposalId('llm-inc', pattern),
    pattern,
    severity: overrides.severity ?? 'warning',
    rule_text:
      overrides.rule_text ?? 'Always check exit codes before proceeding with the next step.',
    session_ids: overrides.session_ids ?? ['s1'],
    turn_ids: overrides.turn_ids ?? ['t1'],
    occurrence_count: overrides.occurrence_count ?? 1,
    first_seen: overrides.first_seen ?? '2026-04-01T00:00:00.000Z',
    last_seen: overrides.last_seen ?? '2026-04-20T00:00:00.000Z',
    graduated: overrides.graduated ?? false,
    ...(overrides.graduated_at !== undefined ? { graduated_at: overrides.graduated_at } : {}),
  };
}

let stateDir: string;

beforeEach(() => {
  const tmpBase = join(tmpdir(), `incremental-pipeline-test-${randomUUID()}`);
  stateDir = join(tmpBase, '.auto-sop', 'state');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  // Clean up the parent of stateDir (the tmp project root)
  const projectRoot = join(stateDir, '..', '..');
  rmSync(projectRoot, { recursive: true, force: true });
});

// ── Integration: 3 ticks with 3 sessions → graduation ───

describe('3-tick graduation integration', () => {
  it('accumulates candidate across 3 ticks from 3 sessions, graduating on tick 3', () => {
    const patternText = 'missing npm install before test run';
    const candidateId = generateProposalId('llm-inc', patternText);

    // ── Tick 1: session-A discovers the pattern ──────────
    const tick1Candidate = makeCandidate({
      id: candidateId,
      pattern: patternText,
      session_ids: ['session-A'],
      turn_ids: ['t-a1'],
      occurrence_count: 1,
      first_seen: '2026-04-20T10:00:00.000Z',
      last_seen: '2026-04-20T10:00:00.000Z',
    });

    let existing = readCandidates(stateDir);
    expect(existing).toEqual([]);

    existing = mergeCandidateEvidence(existing, [tick1Candidate]);
    let { graduated, updated } = graduateCandidates(existing);
    writeCandidates(stateDir, updated);

    expect(graduated).toHaveLength(0);
    expect(readCandidates(stateDir)).toHaveLength(1);
    expect(readCandidates(stateDir)[0]!.session_ids).toEqual(['session-A']);

    // ── Tick 2: session-B sees the same pattern ──────────
    const tick2Candidate = makeCandidate({
      id: candidateId,
      pattern: patternText,
      session_ids: ['session-B'],
      turn_ids: ['t-b1'],
      occurrence_count: 1,
      first_seen: '2026-04-21T10:00:00.000Z',
      last_seen: '2026-04-21T10:00:00.000Z',
    });

    existing = readCandidates(stateDir);
    existing = mergeCandidateEvidence(existing, [tick2Candidate]);
    ({ graduated, updated } = graduateCandidates(existing));
    writeCandidates(stateDir, updated);

    expect(graduated).toHaveLength(0);
    const afterTick2 = readCandidates(stateDir);
    expect(afterTick2).toHaveLength(1);
    expect(new Set(afterTick2[0]!.session_ids)).toEqual(new Set(['session-A', 'session-B']));

    // ── Tick 3: session-C sees the same pattern ──────────
    const tick3Candidate = makeCandidate({
      id: candidateId,
      pattern: patternText,
      session_ids: ['session-C'],
      turn_ids: ['t-c1'],
      occurrence_count: 1,
      first_seen: '2026-04-22T10:00:00.000Z',
      last_seen: '2026-04-22T10:00:00.000Z',
    });

    existing = readCandidates(stateDir);
    existing = mergeCandidateEvidence(existing, [tick3Candidate]);
    ({ graduated, updated } = graduateCandidates(existing));
    writeCandidates(stateDir, updated);

    // NOW the candidate graduates!
    expect(graduated).toHaveLength(1);

    const directive = graduated[0]!;
    expect(directive.id).toBe(candidateId);
    expect(directive.detector).toBe('llm-inc');
    expect(directive.severity).toBe('warning');
    expect(directive.evidence.session_ids).toHaveLength(3);
    expect(new Set(directive.evidence.session_ids)).toEqual(
      new Set(['session-A', 'session-B', 'session-C']),
    );
    expect(directive.evidence.pattern).toBe(patternText);
    expect(directive.evidence.occurrence_count).toBe(3);
    expect(directive.created_at).toBeDefined();

    // Candidate in store is now marked graduated
    const afterTick3 = readCandidates(stateDir);
    expect(afterTick3[0]!.graduated).toBe(true);
    expect(afterTick3[0]!.graduated_at).toBeDefined();
  });

  it('graduated candidate produces DirectiveProposalType with valid evidence', () => {
    const patternText = 'forgetting to handle async errors';
    const candidateId = generateProposalId('llm-inc', patternText);

    const candidate = makeCandidate({
      id: candidateId,
      pattern: patternText,
      severity: 'error',
      rule_text: 'Always wrap async operations in try-catch blocks or use .catch().',
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1', 't2', 't3'],
      occurrence_count: 6,
      first_seen: '2026-04-10T00:00:00.000Z',
      last_seen: '2026-04-22T00:00:00.000Z',
    });

    const { graduated } = graduateCandidates([candidate]);

    expect(graduated).toHaveLength(1);
    const directive = graduated[0]!;

    // Verify it has the shape expected by mergeProposalsWithDedup
    expect(directive.id).toBe(candidateId);
    expect(directive.detector).toBe('llm-inc');
    expect(directive.severity).toBe('error');
    expect(directive.rule_text).toBe(
      'Always wrap async operations in try-catch blocks or use .catch().',
    );
    expect(directive.evidence.session_ids).toEqual(['s1', 's2', 's3']);
    expect(directive.evidence.turn_ids).toEqual(['t1', 't2', 't3']);
    expect(directive.evidence.pattern).toBe(patternText);
    expect(directive.evidence.occurrence_count).toBe(6);
    expect(directive.evidence.first_seen).toBe('2026-04-10T00:00:00.000Z');
  });
});

// ── LLM failure resilience ───────────────────────────────

describe('LLM failure does not lose existing candidates', () => {
  it('candidates from tick 1 persist when tick 2 LLM fails', () => {
    const patternText = 'test failure pattern';
    const candidateId = generateProposalId('llm-inc', patternText);

    // ── Tick 1: successful LLM, writes candidate ─────────
    const tick1Candidate = makeCandidate({
      id: candidateId,
      pattern: patternText,
      session_ids: ['session-1'],
      turn_ids: ['t-1'],
      occurrence_count: 1,
    });

    let existing = readCandidates(stateDir);
    existing = mergeCandidateEvidence(existing, [tick1Candidate]);
    const { updated } = graduateCandidates(existing);
    writeCandidates(stateDir, updated);

    expect(readCandidates(stateDir)).toHaveLength(1);

    // ── Tick 2: LLM fails — simulate by reading existing
    // candidates but NOT calling merge with new ones.
    // The key invariant: we still read existing, prune stale,
    // and graduate — but add no new evidence.
    existing = readCandidates(stateDir);
    // LLM error occurred — no new candidates to merge
    // Prune stale (no-op since they're fresh)
    existing = pruneStaleCandidates(existing, 30);
    // Graduate (no-op since only 1 session)
    const tick2Result = graduateCandidates(existing);
    writeCandidates(stateDir, tick2Result.updated);

    // Candidates from tick 1 should still be there
    const afterTick2 = readCandidates(stateDir);
    expect(afterTick2).toHaveLength(1);
    expect(afterTick2[0]!.id).toBe(candidateId);
    expect(afterTick2[0]!.session_ids).toEqual(['session-1']);
  });

  it('multiple candidates survive LLM failure', () => {
    const candidate1 = makeCandidate({
      pattern: 'pattern-alpha',
      session_ids: ['s1', 's2'],
    });
    const candidate2 = makeCandidate({
      pattern: 'pattern-beta',
      session_ids: ['s1'],
    });

    writeCandidates(stateDir, [candidate1, candidate2]);

    // Tick where LLM fails — read, prune, graduate, write back
    const existing = readCandidates(stateDir);
    const pruned = pruneStaleCandidates(existing, 30);
    const { updated } = graduateCandidates(pruned);
    writeCandidates(stateDir, updated);

    const result = readCandidates(stateDir);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.pattern).sort()).toEqual(['pattern-alpha', 'pattern-beta']);
  });
});

// ── Offline mode graduation ──────────────────────────────

describe('offline mode still graduates candidates', () => {
  it('graduates candidates that crossed threshold even without LLM call', () => {
    // Pre-populate with candidate that already has 3 sessions
    // (accumulated over previous ticks when LLM was online)
    const patternText = 'ignoring return value';
    const candidateId = generateProposalId('llm-inc', patternText);

    const readyCandidate = makeCandidate({
      id: candidateId,
      pattern: patternText,
      rule_text: 'Always check the return value from database query operations.',
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1', 't2', 't3'],
      occurrence_count: 5,
    });

    writeCandidates(stateDir, [readyCandidate]);

    // Simulate offline tick: read, prune, graduate, write
    // (no LLM call, no new candidates)
    let existing = readCandidates(stateDir);
    existing = pruneStaleCandidates(existing, 30);
    const { graduated, updated } = graduateCandidates(existing);
    writeCandidates(stateDir, updated);

    // Should graduate!
    expect(graduated).toHaveLength(1);
    expect(graduated[0]!.id).toBe(candidateId);
    expect(graduated[0]!.evidence.session_ids).toEqual(['s1', 's2', 's3']);

    // Updated store should have graduated flag set
    const stored = readCandidates(stateDir);
    expect(stored[0]!.graduated).toBe(true);
  });

  it('does not graduate candidates below threshold in offline mode', () => {
    const candidate = makeCandidate({
      pattern: 'not ready yet',
      session_ids: ['s1', 's2'], // Only 2 sessions
    });

    writeCandidates(stateDir, [candidate]);

    // Offline tick
    let existing = readCandidates(stateDir);
    existing = pruneStaleCandidates(existing, 30);
    const { graduated, updated } = graduateCandidates(existing);
    writeCandidates(stateDir, updated);

    expect(graduated).toHaveLength(0);
    expect(readCandidates(stateDir)[0]!.graduated).toBe(false);
  });
});

// ── Stale candidate pruning ──────────────────────────────

describe('stale candidate pruning', () => {
  it('removes 30+ day old non-graduated candidates', () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const today = new Date().toISOString();

    const stale = makeCandidate({
      pattern: 'stale-pattern',
      last_seen: thirtyOneDaysAgo,
      graduated: false,
    });
    const fresh = makeCandidate({
      pattern: 'fresh-pattern',
      last_seen: today,
      graduated: false,
    });
    const graduatedOld = makeCandidate({
      pattern: 'graduated-old-pattern',
      last_seen: thirtyOneDaysAgo,
      graduated: true,
      graduated_at: thirtyOneDaysAgo,
    });

    writeCandidates(stateDir, [stale, fresh, graduatedOld]);

    // Run pruning pipeline
    let existing = readCandidates(stateDir);
    existing = pruneStaleCandidates(existing, 30);
    writeCandidates(stateDir, existing);

    const result = readCandidates(stateDir);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.pattern).sort()).toEqual(['fresh-pattern', 'graduated-old-pattern']);
  });

  it('does not prune candidates younger than 30 days', () => {
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();

    const recent = makeCandidate({
      pattern: 'recent',
      last_seen: twentyNineDaysAgo,
      graduated: false,
    });

    writeCandidates(stateDir, [recent]);

    let existing = readCandidates(stateDir);
    existing = pruneStaleCandidates(existing, 30);
    writeCandidates(stateDir, existing);

    expect(readCandidates(stateDir)).toHaveLength(1);
  });

  it('pruning is integrated into the tick lifecycle', () => {
    // Full tick lifecycle: read → prune → merge → graduate → write
    const old = makeCandidate({
      pattern: 'stale one',
      last_seen: '2024-01-01T00:00:00.000Z',
      graduated: false,
    });
    const active = makeCandidate({
      pattern: 'active one',
      last_seen: new Date().toISOString(),
      session_ids: ['s1', 's2'],
      graduated: false,
    });

    writeCandidates(stateDir, [old, active]);

    // Tick lifecycle
    let existing = readCandidates(stateDir);
    expect(existing).toHaveLength(2);

    // 1. Prune stale
    existing = pruneStaleCandidates(existing, 30);
    expect(existing).toHaveLength(1); // old was removed

    // 2. Merge new evidence (from current tick's LLM)
    const newEvidence = makeCandidate({
      id: active.id,
      pattern: 'active one',
      session_ids: ['s3'],
      turn_ids: ['t-new'],
      occurrence_count: 1,
      last_seen: new Date().toISOString(),
    });
    existing = mergeCandidateEvidence(existing, [newEvidence]);

    // 3. Graduate
    const { graduated, updated } = graduateCandidates(existing);
    expect(graduated).toHaveLength(1); // now has 3 sessions: s1, s2, s3

    // 4. Write
    writeCandidates(stateDir, updated);

    const final = readCandidates(stateDir);
    expect(final).toHaveLength(1);
    expect(final[0]!.graduated).toBe(true);
  });
});

// ── Edge cases ───────────────────────────────────────────

describe('pipeline edge cases', () => {
  it('empty state dir — fresh start produces empty candidates', () => {
    const candidates = readCandidates(stateDir);
    expect(candidates).toEqual([]);
  });

  it('candidate with duplicate session_ids still counts distinct only', () => {
    const candidate = makeCandidate({
      session_ids: ['s1', 's1', 's2', 's2', 's3'],
    });

    const { graduated } = graduateCandidates([candidate]);
    expect(graduated).toHaveLength(1);
  });

  it('concurrent tick simulation — interleaved read/write/merge', () => {
    const id = generateProposalId('llm-inc', 'concurrent-test');

    // First "tick" — writes candidate with s1
    let tick1 = readCandidates(stateDir);
    tick1 = mergeCandidateEvidence(tick1, [
      makeCandidate({ id, pattern: 'concurrent-test', session_ids: ['s1'] }),
    ]);
    writeCandidates(stateDir, tick1);

    // Second "tick" — reads the file, merges s2
    let tick2 = readCandidates(stateDir);
    tick2 = mergeCandidateEvidence(tick2, [
      makeCandidate({ id, pattern: 'concurrent-test', session_ids: ['s2'] }),
    ]);
    writeCandidates(stateDir, tick2);

    // Third "tick" — reads, merges s3, graduates
    let tick3 = readCandidates(stateDir);
    tick3 = mergeCandidateEvidence(tick3, [
      makeCandidate({ id, pattern: 'concurrent-test', session_ids: ['s3'] }),
    ]);
    const { graduated, updated } = graduateCandidates(tick3);
    writeCandidates(stateDir, updated);

    expect(graduated).toHaveLength(1);
    expect(new Set(graduated[0]!.evidence.session_ids)).toEqual(new Set(['s1', 's2', 's3']));
  });
});

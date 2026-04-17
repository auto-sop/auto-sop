/**
 * Unit tests for src/learner/merge-proposals.ts
 *
 * Covers:
 * - Basic union (no overlap) → all items preserved
 * - Deduplication by id → LLM version wins
 * - Cap at MAX_DIRECTIVES (10) → lowest severities dropped first
 * - Sort order: severity (error > warning > info), then created_at asc
 * - Input arrays not mutated
 * - (E4) Semantic fingerprint dedup — normalized rule_text + severity
 *       · most evidence wins
 *       · severity tiebreak
 *       · LLM-sourced beats rule-based
 *       · dedupedCount returned
 */
import { describe, it, expect } from 'vitest';
import {
  mergeProposals,
  mergeProposalsWithDedup,
  MAX_DIRECTIVES,
} from '../../src/learner/merge-proposals.js';
import type { DirectiveProposalType } from '../../src/learner/directive-schema.js';

function makeProposal(
  overrides: Partial<DirectiveProposalType> = {},
): DirectiveProposalType {
  return {
    id: 'det-default-0000',
    detector: 'rule-detector',
    severity: 'warning',
    rule_text:
      'Rule text long enough to pass the Zod schema validation layer.',
    evidence: {
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1', 't2', 't3'],
      pattern: 'default-pattern',
      occurrence_count: 3,
      first_seen: '2026-04-14T10:00:00.000Z',
    },
    created_at: '2026-04-14T22:00:00.000Z',
    ...overrides,
  };
}

describe('mergeProposals', () => {
  it('merges 2 rule + 3 LLM with no overlap into 5 proposals', () => {
    const rule = [
      makeProposal({
        id: 'rule-aaaa',
        severity: 'error',
        rule_text: 'Error A: check that node_modules exists before npm test.',
      }),
      makeProposal({
        id: 'rule-bbbb',
        severity: 'warning',
        rule_text: 'Warning B: avoid hard-coding absolute paths in configs.',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-cccc',
        severity: 'error',
        rule_text: 'Error C: always run migrations before integration tests.',
      }),
      makeProposal({
        id: 'llm-dddd',
        severity: 'warning',
        rule_text: 'Warning D: guard env-dependent code behind process.env.',
      }),
      makeProposal({
        id: 'llm-eeee',
        severity: 'info',
        rule_text: 'Info E: prefer async/await over raw promise chaining.',
      }),
    ];
    const merged = mergeProposals(rule, llm);
    expect(merged).toHaveLength(5);
    const ids = merged.map((p) => p.id).sort();
    expect(ids).toEqual(['llm-cccc', 'llm-dddd', 'llm-eeee', 'rule-aaaa', 'rule-bbbb']);
  });

  it('deduplicates by id: 1 rule + 1 LLM with same id → 1 merged (LLM version wins)', () => {
    const sharedId = 'det-shared-1234';
    const rule = [
      makeProposal({
        id: sharedId,
        detector: 'repeated-bash-failure',
        rule_text:
          'Generic rule-based text covering `npm test` repeated failure.',
      }),
    ];
    const llm = [
      makeProposal({
        id: sharedId,
        detector: 'llm-analysis',
        rule_text:
          'AI-enriched directive: when `npm test` fails repeatedly, first check that node_modules is installed before rerunning.',
      }),
    ];
    const merged = mergeProposals(rule, llm);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.detector).toBe('llm-analysis');
    expect(merged[0]!.rule_text).toContain('AI-enriched');
  });

  it('caps at MAX_DIRECTIVES (10) when 12 proposals supplied', () => {
    // Build 12 proposals total, all with DIFFERENT rule_texts (so semantic
    // dedup does not collapse them). Sort should drop the lowest-severity
    // ones first.
    const rule: DirectiveProposalType[] = [];
    const llm: DirectiveProposalType[] = [];
    for (let i = 0; i < 6; i++) {
      rule.push(
        makeProposal({
          id: `rule-${String(i).padStart(4, '0')}`,
          severity: 'info',
          rule_text: `Info rule number ${i}: distinct enough to avoid semantic dedup ${i}.`,
          created_at: `2026-04-14T10:0${i}:00.000Z`,
        }),
      );
    }
    for (let i = 0; i < 6; i++) {
      llm.push(
        makeProposal({
          id: `llm-${String(i).padStart(4, '0')}`,
          severity: 'error',
          rule_text: `Error directive number ${i}: distinct enough to avoid semantic dedup ${i}.`,
          created_at: `2026-04-14T09:0${i}:00.000Z`,
        }),
      );
    }
    const merged = mergeProposals(rule, llm);
    expect(merged).toHaveLength(MAX_DIRECTIVES);
    expect(MAX_DIRECTIVES).toBe(10);
    // All 6 errors survive; 4 infos survive; 2 infos dropped.
    const errors = merged.filter((p) => p.severity === 'error');
    const infos = merged.filter((p) => p.severity === 'info');
    expect(errors).toHaveLength(6);
    expect(infos).toHaveLength(4);
  });

  it('sorts by severity: error first, then warning, then info', () => {
    const rule = [
      makeProposal({
        id: 'rule-info',
        severity: 'info',
        rule_text: 'Info severity text for sort ordering test case.',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
      makeProposal({
        id: 'rule-error',
        severity: 'error',
        rule_text: 'Error severity text for sort ordering test case.',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-warning',
        severity: 'warning',
        rule_text: 'Warning severity text for sort ordering test case.',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
    ];
    const merged = mergeProposals(rule, llm);
    expect(merged.map((p) => p.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('does not mutate input arrays', () => {
    const rule = [makeProposal({ id: 'rule-x' })];
    const llm = [makeProposal({ id: 'llm-y', rule_text: 'Distinct rule_text for mutation test.' })];
    const ruleSnapshot = [...rule];
    const llmSnapshot = [...llm];
    mergeProposals(rule, llm);
    expect(rule).toEqual(ruleSnapshot);
    expect(llm).toEqual(llmSnapshot);
  });

  it('returns empty array when both inputs empty', () => {
    expect(mergeProposals([], [])).toEqual([]);
  });

  it('ties broken by id lexicographic order (determinism)', () => {
    // Same severity, same created_at, DIFFERENT rule_text (so no semantic
    // dedup collapse) → id determines order.
    const rule = [
      makeProposal({
        id: 'det-zzzz',
        severity: 'warning',
        rule_text: 'Zzzz proposal rule_text distinct from the other side.',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'det-aaaa',
        severity: 'warning',
        rule_text: 'Aaaa proposal rule_text distinct from the other side.',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
    ];
    const merged = mergeProposals(rule, llm);
    expect(merged.map((p) => p.id)).toEqual(['det-aaaa', 'det-zzzz']);
  });
});

describe('mergeProposalsWithDedup — E4 semantic fingerprint', () => {
  it('drops one of two proposals with same normalized rule_text + severity', () => {
    const rule = [
      makeProposal({
        id: 'rule-0001',
        severity: 'warning',
        rule_text: 'Always run npm install before npm test to avoid failures.',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-0001',
        detector: 'llm',
        severity: 'warning',
        // Same semantic content, different punctuation/whitespace — must
        // still collapse via normalization.
        rule_text: 'Always   run npm install before npm test to avoid failures.',
      }),
    ];
    const result = mergeProposalsWithDedup(rule, llm);
    expect(result.proposals).toHaveLength(1);
    expect(result.dedupedCount).toBe(1);
  });

  it('keeps both when severities differ even if rule_text matches', () => {
    const rule = [
      makeProposal({
        id: 'rule-sev-a',
        severity: 'warning',
        rule_text: 'Run migrations before integration tests to avoid flaky runs.',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-sev-b',
        detector: 'llm',
        severity: 'error',
        rule_text: 'Run migrations before integration tests to avoid flaky runs.',
      }),
    ];
    const result = mergeProposalsWithDedup(rule, llm);
    expect(result.proposals).toHaveLength(2);
    expect(result.dedupedCount).toBe(0);
  });

  it('same fingerprint, different evidence counts → most evidence wins', () => {
    const sharedText = 'Guard env-dependent code behind process.env checks.';
    const rule = [
      makeProposal({
        id: 'rule-lowev',
        severity: 'warning',
        rule_text: sharedText,
        evidence: {
          session_ids: ['s1', 's2', 's3'],
          turn_ids: ['t1', 't2', 't3'],
          pattern: 'pattern-a',
          occurrence_count: 3,
          first_seen: '2026-04-14T10:00:00.000Z',
        },
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-highev',
        detector: 'llm',
        severity: 'warning',
        rule_text: sharedText,
        evidence: {
          session_ids: ['s1', 's2', 's3', 's4', 's5'],
          turn_ids: ['t1', 't2', 't3'],
          pattern: 'pattern-a',
          occurrence_count: 5,
          first_seen: '2026-04-14T10:00:00.000Z',
        },
      }),
    ];
    const result = mergeProposalsWithDedup(rule, llm);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.id).toBe('llm-highev');
    expect(result.dedupedCount).toBe(1);
  });

  it('same fingerprint, same evidence, LLM vs rule → LLM wins', () => {
    const sharedText = 'Prefer async/await over raw promise chaining where possible.';
    const rule = [
      makeProposal({
        id: 'rule-same-ev',
        detector: 'rule-detector',
        severity: 'warning',
        rule_text: sharedText,
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-same-ev',
        detector: 'llm',
        severity: 'warning',
        rule_text: sharedText,
      }),
    ];
    const result = mergeProposalsWithDedup(rule, llm);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.id).toBe('llm-same-ev');
    expect(result.proposals[0]!.detector).toBe('llm');
    expect(result.dedupedCount).toBe(1);
  });

  it('typical input with no duplicates → dedupedCount === 0', () => {
    const rule = [
      makeProposal({
        id: 'rule-a',
        severity: 'error',
        rule_text: 'Error rule A: completely distinct content goes here.',
      }),
      makeProposal({
        id: 'rule-b',
        severity: 'warning',
        rule_text: 'Warning rule B: a totally different unique message.',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-c',
        detector: 'llm',
        severity: 'info',
        rule_text: 'Info from LLM: yet another completely distinct message.',
      }),
    ];
    const result = mergeProposalsWithDedup(rule, llm);
    expect(result.proposals).toHaveLength(3);
    expect(result.dedupedCount).toBe(0);
  });

  it('normalizes case and whitespace for fingerprint', () => {
    const rule = [
      makeProposal({
        id: 'rule-case',
        severity: 'warning',
        rule_text: 'Run Migrations Before Tests To Avoid Flakes In CI Builds.',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-case',
        detector: 'llm',
        severity: 'warning',
        rule_text: '  run migrations before tests to avoid flakes in ci builds.  ',
      }),
    ];
    const result = mergeProposalsWithDedup(rule, llm);
    expect(result.proposals).toHaveLength(1);
    expect(result.dedupedCount).toBe(1);
  });

  it('collapses groups of 3+ and counts all losers', () => {
    const sharedText = 'Always commit changes atomically with a descriptive message.';
    const rule = [
      makeProposal({
        id: 'rule-trio-1',
        severity: 'info',
        rule_text: sharedText,
      }),
      makeProposal({
        id: 'rule-trio-2',
        severity: 'info',
        rule_text: sharedText,
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-trio-3',
        detector: 'llm',
        severity: 'info',
        rule_text: sharedText,
      }),
    ];
    const result = mergeProposalsWithDedup(rule, llm);
    expect(result.proposals).toHaveLength(1);
    // 3 input → 1 output → 2 dropped
    expect(result.dedupedCount).toBe(2);
    // LLM wins the tiebreak because rule proposals have same ev count.
    expect(result.proposals[0]!.id).toBe('llm-trio-3');
  });
});

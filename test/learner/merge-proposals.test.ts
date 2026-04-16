/**
 * Unit tests for src/learner/merge-proposals.ts
 *
 * Covers:
 * - Basic union (no overlap) → all items preserved
 * - Deduplication by id → LLM version wins
 * - Cap at MAX_DIRECTIVES (10) → lowest severities dropped first
 * - Sort order: severity (error > warning > info), then created_at asc
 * - Input arrays not mutated
 */
import { describe, it, expect } from 'vitest';
import {
  mergeProposals,
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
      makeProposal({ id: 'rule-aaaa', severity: 'error' }),
      makeProposal({ id: 'rule-bbbb', severity: 'warning' }),
    ];
    const llm = [
      makeProposal({ id: 'llm-cccc', severity: 'error' }),
      makeProposal({ id: 'llm-dddd', severity: 'warning' }),
      makeProposal({ id: 'llm-eeee', severity: 'info' }),
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
    // Build 12 proposals total. Sort should drop the lowest-severity ones.
    const rule: DirectiveProposalType[] = [];
    const llm: DirectiveProposalType[] = [];
    for (let i = 0; i < 6; i++) {
      rule.push(
        makeProposal({
          id: `rule-${String(i).padStart(4, '0')}`,
          severity: 'info',
          created_at: `2026-04-14T10:0${i}:00.000Z`,
        }),
      );
    }
    for (let i = 0; i < 6; i++) {
      llm.push(
        makeProposal({
          id: `llm-${String(i).padStart(4, '0')}`,
          severity: 'error',
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
        created_at: '2026-04-14T10:00:00.000Z',
      }),
      makeProposal({
        id: 'rule-error',
        severity: 'error',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'llm-warning',
        severity: 'warning',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
    ];
    const merged = mergeProposals(rule, llm);
    expect(merged.map((p) => p.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('does not mutate input arrays', () => {
    const rule = [makeProposal({ id: 'rule-x' })];
    const llm = [makeProposal({ id: 'llm-y' })];
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
    // Same severity, same created_at → id determines order.
    const rule = [
      makeProposal({
        id: 'det-zzzz',
        severity: 'warning',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
    ];
    const llm = [
      makeProposal({
        id: 'det-aaaa',
        severity: 'warning',
        created_at: '2026-04-14T10:00:00.000Z',
      }),
    ];
    const merged = mergeProposals(rule, llm);
    expect(merged.map((p) => p.id)).toEqual(['det-aaaa', 'det-zzzz']);
  });
});

import { describe, it, expect } from 'vitest';
import { diceSimilarity, deduplicateProposals, DEDUP_THRESHOLD } from '../../src/learner/dedup.js';
import type { DirectiveProposalType } from '../../src/learner/directive-schema.js';

function makeProposal(ruleText: string, id?: string): DirectiveProposalType {
  return {
    id: id ?? `test-${Math.random().toString(36).slice(2, 10)}`,
    detector: 'test-detector',
    severity: 'warning',
    rule_text: ruleText,
    evidence: {
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1'],
      pattern: 'test-pattern',
      occurrence_count: 3,
      first_seen: '2026-01-01T00:00:00Z',
    },
    created_at: '2026-01-01T00:00:00Z',
  };
}

describe('diceSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(diceSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 1.0 for two empty strings', () => {
    expect(diceSimilarity('', '')).toBe(1);
  });

  it('returns 0 when one string is empty', () => {
    expect(diceSimilarity('hello', '')).toBe(0);
  });

  it('returns 0 for completely different strings', () => {
    const sim = diceSimilarity('abc', 'xyz');
    expect(sim).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(diceSimilarity('Hello World', 'hello world')).toBe(1);
  });

  it('collapses whitespace', () => {
    expect(diceSimilarity('hello   world', 'hello world')).toBe(1);
  });

  it('detects near-duplicate API token directives', () => {
    const a = 'never embed API tokens in source code';
    const b = 'never pass access tokens inline in code';
    const sim = diceSimilarity(a, b);
    expect(sim).toBeGreaterThan(DEDUP_THRESHOLD);
  });

  it('returns high similarity for minor rewording', () => {
    const a = 'Always use the Read tool instead of Bash cat for reading files';
    const b = 'Always use the Read tool instead of Bash cat/head for reading files';
    const sim = diceSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.8);
  });

  it('returns low similarity for unrelated directives', () => {
    const a = 'Never embed API tokens in source code';
    const b = 'Use PostgreSQL for database migrations';
    const sim = diceSimilarity(a, b);
    expect(sim).toBeLessThan(DEDUP_THRESHOLD);
  });
});

describe('deduplicateProposals', () => {
  it('accepts all proposals when no existing directives', () => {
    const proposals = [makeProposal('Use the Read tool for file reading')];
    const result = deduplicateProposals(proposals, []);
    expect(result.accepted).toHaveLength(1);
    expect(result.skippedCount).toBe(0);
  });

  it('skips a near-duplicate of an existing directive', () => {
    const existing = ['Never embed API tokens in source code'];
    const proposals = [makeProposal('Never pass access tokens inline in code')];
    const result = deduplicateProposals(proposals, existing);
    expect(result.accepted).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
  });

  it('accepts proposals that are sufficiently different', () => {
    const existing = ['Never embed API tokens in source code'];
    const proposals = [makeProposal('Use PostgreSQL for database migrations')];
    const result = deduplicateProposals(proposals, existing);
    expect(result.accepted).toHaveLength(1);
    expect(result.skippedCount).toBe(0);
  });

  it('skips near-duplicates within the candidate batch itself', () => {
    const proposals = [
      makeProposal('Always use the Read tool for file reading', 'p1'),
      makeProposal('Always use the Read tool for reading files', 'p2'),
    ];
    const result = deduplicateProposals(proposals, []);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.id).toBe('p1');
    expect(result.skippedCount).toBe(1);
  });

  it('respects custom threshold', () => {
    const existing = ['Never embed API tokens in source code'];
    const proposals = [makeProposal('Never pass access tokens inline in code')];
    // Very high threshold — should accept
    const result = deduplicateProposals(proposals, existing, 0.99);
    expect(result.accepted).toHaveLength(1);
    expect(result.skippedCount).toBe(0);
  });

  it('handles multiple proposals with mixed results', () => {
    const existing = ['Always use Glob tool for file pattern matching'];
    const proposals = [
      makeProposal('Always use the Glob tool for file discovery', 'dup'),
      makeProposal('Never run destructive git commands without explicit request', 'unique'),
    ];
    const result = deduplicateProposals(proposals, existing);
    expect(result.skippedCount).toBe(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.id).toBe('unique');
  });
});

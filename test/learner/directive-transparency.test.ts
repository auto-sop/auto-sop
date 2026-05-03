/**
 * Tests for V46: Directive Transparency — self-reported fires.
 * Covers shortDirectiveId() and the transparency instruction + [sop:ID] tags
 * in the directive builder output.
 */
import { describe, it, expect } from 'vitest';
import {
  shortDirectiveId,
  buildDirectiveBodyFromInput,
} from '../../src/learner/directive-builder.js';
import type { DirectiveProposalType } from '../../src/learner/directive-schema.js';

function makeProposal(overrides: Partial<DirectiveProposalType> = {}): DirectiveProposalType {
  return {
    id: 'det-000000000001',
    detector: 'repeated-bash-failure',
    severity: 'warning',
    rule_text:
      'Command `npm test` has exited non-zero in 3 sessions. Consider verifying prerequisites before running.',
    evidence: {
      session_ids: ['s1', 's2', 's3'],
      turn_ids: ['t1', 't2', 't3'],
      pattern: 'npm test',
      occurrence_count: 4,
      first_seen: '2026-04-14T10:00:00.000Z',
    },
    created_at: '2026-04-14T22:00:00.000Z',
    ...overrides,
  };
}

describe('shortDirectiveId', () => {
  it('returns first 8 chars of a regular id', () => {
    expect(shortDirectiveId('det-000000000001')).toBe('det-0000');
  });

  it('replaces llm-inc- prefix with sop-', () => {
    expect(shortDirectiveId('llm-inc-7ced4f9a1234')).toBe('sop-7ced');
  });

  it('handles short ids (< 8 chars)', () => {
    expect(shortDirectiveId('abc')).toBe('abc');
  });

  it('handles exact 8-char ids', () => {
    expect(shortDirectiveId('12345678')).toBe('12345678');
  });

  it('is stable — same input always yields same output', () => {
    const id = 'llm-inc-abcdef123456';
    expect(shortDirectiveId(id)).toBe(shortDirectiveId(id));
  });

  it('handles ids without llm-inc- prefix', () => {
    expect(shortDirectiveId('llm-7ced4f9a')).toBe('llm-7ced');
  });

  // ── Collision resistance ─────────────────────────────────

  it('produces different IDs for repeated-bash-failure vs repeated-edit-fail', () => {
    const a = shortDirectiveId('repeated-bash-failure-7ced4f9a1234');
    const b = shortDirectiveId('repeated-edit-fail-abc123def456');
    expect(a).not.toBe(b);
    expect(a).toBe('rbf-7ced');
    expect(b).toBe('ref-abc1');
  });

  it('produces different IDs for two llm-inc directives with different hashes', () => {
    const a = shortDirectiveId('llm-inc-7ced4f9a1234');
    const b = shortDirectiveId('llm-inc-abc123def456');
    expect(a).not.toBe(b);
    expect(a).toBe('sop-7ced');
    expect(b).toBe('sop-abc1');
  });

  it('produces different IDs for multiple directives with similar prefixes', () => {
    const ids = [
      shortDirectiveId('repeated-bash-failure-aaaa1111'),
      shortDirectiveId('repeated-bash-failure-bbbb2222'),
      shortDirectiveId('repeated-edit-fail-aaaa1111'),
      shortDirectiveId('repeated-edit-fail-cccc3333'),
      shortDirectiveId('llm-inc-dddd4444'),
      shortDirectiveId('llm-inc-eeee5555'),
    ];
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('maps known detector prefixes to abbreviated forms', () => {
    expect(shortDirectiveId('repeated-bash-failure-abcd1234')).toBe('rbf-abcd');
    expect(shortDirectiveId('repeated-edit-fail-efgh5678')).toBe('ref-efgh');
    expect(shortDirectiveId('llm-inc-ijkl9012')).toBe('sop-ijkl');
  });
});

describe('directive transparency rendering', () => {
  // ── [sop:ID] tags ─────────────────────────────────────────

  it('appends [sop:ID] tag to each proposal bullet', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [makeProposal({ id: 'det-000000000001' })],
      candidateCount: 0,
    });

    expect(result.body).toContain('[sop:det-0000]');
  });

  it('each proposal gets its own unique [sop:ID] tag', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [
        makeProposal({ id: 'det-aaaa11112222' }),
        makeProposal({
          id: 'det-bbbb33334444',
          rule_text: 'Edit exact-string-match has failed. Always Read before Edit.',
          created_at: '2026-04-14T23:00:00.000Z',
        }),
      ],
      candidateCount: 0,
    });

    expect(result.body).toContain('[sop:det-aaaa]');
    expect(result.body).toContain('[sop:det-bbbb]');
  });

  it('[sop:ID] tag appears on the rule_text line, not the evidence line', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [makeProposal({ id: 'det-000000000001' })],
      candidateCount: 0,
    });

    const lines = result.body.split('\n');
    const ruleLine = lines.find((l) => l.includes('[sop:det-0000]'));
    const evidenceLine = lines.find((l) => l.includes('evidence:'));
    expect(ruleLine).toBeDefined();
    expect(ruleLine).toContain('- **[warning]**');
    expect(evidenceLine).not.toContain('[sop:');
  });

  it('llm-inc- prefix is normalized in [sop:ID] tags', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [makeProposal({ id: 'llm-inc-7ced4f9a1234' })],
      candidateCount: 0,
    });

    expect(result.body).toContain('[sop:sop-7ced]');
    expect(result.body).not.toContain('[sop:llm-inc-]');
  });

  // ── Transparency instruction ───────────────────────────────

  it('includes transparency instruction when proposals exist', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [makeProposal()],
      candidateCount: 0,
    });

    expect(result.body).toContain('**Transparency**');
    expect(result.body).toContain('[sop:applied:<id>]');
    expect(result.body).toContain('Do not force-apply directives');
  });

  it('omits transparency instruction when no proposals', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [],
      candidateCount: 0,
    });

    expect(result.body).not.toContain('**Transparency**');
    expect(result.body).not.toContain('[sop:applied:');
  });

  it('omits transparency instruction when only candidates (no proposals)', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [],
      candidateCount: 5,
    });

    expect(result.body).not.toContain('**Transparency**');
  });

  it('transparency instruction appears BEFORE learnings section', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [makeProposal()],
      candidateCount: 0,
    });

    const transparencyIdx = result.body.indexOf('**Transparency**');
    const learningsIdx = result.body.indexOf('**Learnings**');
    expect(transparencyIdx).toBeGreaterThan(-1);
    expect(learningsIdx).toBeGreaterThan(-1);
    expect(transparencyIdx).toBeLessThan(learningsIdx);
  });

  // ── Planning gate (V58) ─────────────────────────────────────

  it('includes planning gate instruction when proposals exist', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [makeProposal()],
      candidateCount: 0,
    });

    expect(result.body).toContain('**Planning gate**');
    expect(result.body).toContain('read all directives below');
  });

  it('omits planning gate when no proposals', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [],
      candidateCount: 0,
    });

    expect(result.body).not.toContain('**Planning gate**');
  });

  it('planning gate appears AFTER transparency and BEFORE learnings', () => {
    const result = buildDirectiveBodyFromInput({
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [makeProposal()],
      candidateCount: 0,
    });

    const transparencyIdx = result.body.indexOf('**Transparency**');
    const planningIdx = result.body.indexOf('**Planning gate**');
    const learningsIdx = result.body.indexOf('**Learnings**');
    expect(transparencyIdx).toBeGreaterThan(-1);
    expect(planningIdx).toBeGreaterThan(-1);
    expect(learningsIdx).toBeGreaterThan(-1);
    expect(transparencyIdx).toBeLessThan(planningIdx);
    expect(planningIdx).toBeLessThan(learningsIdx);
  });

  // ── Determinism ────────────────────────────────────────────

  it('is deterministic — same inputs yield byte-identical output with [sop:ID] tags', () => {
    const input = {
      turnsTotalSeen: 10,
      agentRoster: ['main'],
      nowIso: '2026-04-14T22:20:00Z',
      proposals: [
        makeProposal({ id: 'det-aaaa11112222' }),
        makeProposal({
          id: 'det-bbbb33334444',
          rule_text: 'Edit has failed. Always Read before Edit for existing files.',
          created_at: '2026-04-14T23:00:00.000Z',
        }),
      ],
      candidateCount: 0,
    };
    const a = buildDirectiveBodyFromInput(input);
    const b = buildDirectiveBodyFromInput(input);
    expect(a.body).toBe(b.body);
  });
});

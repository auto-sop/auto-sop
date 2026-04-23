/**
 * Unit tests for src/learner/llm-response-incremental.ts
 *
 * Covers:
 *   - Valid response parsing (new_candidates + matched_existing)
 *   - Malformed JSON handling (returns empty results)
 *   - Missing fields (silently dropped)
 *   - Markdown fence stripping
 *   - session_id auto-population on new candidates
 *   - Invalid candidate_id in matched_existing (skipped)
 *   - Two-layer JSON unwrapping (claude CLI wrapper)
 *   - rule_text length validation (10-500 chars)
 *   - severity enum validation
 *   - Empty/null input handling
 */
import { describe, it, expect } from 'vitest';
import { parseIncrementalResponse } from '../../src/learner/llm-response-incremental.js';
import { generateProposalId } from '../../src/learner/directive-schema.js';
import type { TurnData } from '../../src/learner/turn-loader.js';

// ── Fixture helpers ────────────────────────────────────────

function makeTurnData(overrides: Partial<TurnData> & { turn_id: string }): TurnData {
  return {
    session_id: 'sess-001',
    agent: 'main',
    finalized_at: '2026-04-20T10:00:00.000Z',
    tool_calls: [],
    ...overrides,
  };
}

function defaultTurns(): TurnData[] {
  return [
    makeTurnData({ turn_id: 't-1', finalized_at: '2026-04-20T10:00:00.000Z' }),
    makeTurnData({ turn_id: 't-2', finalized_at: '2026-04-20T10:05:00.000Z' }),
    makeTurnData({ turn_id: 't-3', finalized_at: '2026-04-20T10:10:00.000Z' }),
  ];
}

function validIncrementalResponse(): Record<string, unknown> {
  return {
    new_candidates: [
      {
        pattern: 'missing npm install before test',
        severity: 'warning',
        rule_text: 'Always run npm install before running tests after pulling changes.',
        turn_ids: ['t-1', 't-2'],
        occurrence_count: 2,
      },
    ],
    matched_existing: [
      {
        candidate_id: 'llm-inc-abc123def456',
        turn_ids: ['t-3'],
        additional_occurrences: 1,
      },
    ],
    summary: 'Found one new pattern and one match.',
  };
}

/**
 * Wrap a payload in the claude CLI `--output-format json` shape.
 * Two JSON.parse passes needed to recover the directive payload.
 */
function wrapClaude(payload: unknown): string {
  const inner = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.stringify({
    type: 'result',
    result: inner,
    model: 'claude-test',
    total_cost_usd: 0,
  });
}

// ── Test suite ────────────────────────────────────────────

describe('parseIncrementalResponse', () => {
  // ── Valid response ──────────────────────────────────────

  it('parses valid response with new_candidates and matched_existing', () => {
    const stdout = wrapClaude(validIncrementalResponse());
    const result = parseIncrementalResponse(stdout, 'sess-001', defaultTurns());

    expect(result.newCandidates).toHaveLength(1);
    expect(result.matchedExisting).toHaveLength(1);

    const candidate = result.newCandidates[0]!;
    expect(candidate.pattern).toBe('missing npm install before test');
    expect(candidate.severity).toBe('warning');
    expect(candidate.rule_text).toBe(
      'Always run npm install before running tests after pulling changes.',
    );
    expect(candidate.turn_ids).toEqual(['t-1', 't-2']);
    expect(candidate.occurrence_count).toBe(2);
    expect(candidate.graduated).toBe(false);

    const match = result.matchedExisting[0]!;
    expect(match.candidateId).toBe('llm-inc-abc123def456');
    expect(match.turnIds).toEqual(['t-3']);
    expect(match.additionalOccurrences).toBe(1);
  });

  // ── summary extraction ──────────────────────────────────

  it('extracts summary string from valid response', () => {
    const stdout = wrapClaude(validIncrementalResponse());
    const result = parseIncrementalResponse(stdout, 'sess-001', defaultTurns());

    expect(result.summary).toBe('Found one new pattern and one match.');
  });

  it('returns empty summary when summary field is missing', () => {
    const response = { new_candidates: [], matched_existing: [] };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.summary).toBe('');
  });

  it('returns empty summary when summary field is non-string', () => {
    const response = { new_candidates: [], matched_existing: [], summary: 42 };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.summary).toBe('');
  });

  // ── session_id auto-population ──────────────────────────

  it('populates session_ids from sessionId parameter on new candidates', () => {
    const stdout = wrapClaude(validIncrementalResponse());
    const result = parseIncrementalResponse(stdout, 'my-session-42', defaultTurns());

    expect(result.newCandidates[0]!.session_ids).toEqual(['my-session-42']);
  });

  // ── Deterministic id generation ─────────────────────────

  it('generates deterministic id via generateProposalId for new candidates', () => {
    const stdout = wrapClaude(validIncrementalResponse());
    const result = parseIncrementalResponse(stdout, 'sess-001', defaultTurns());

    const expected = generateProposalId('llm-inc', 'missing npm install before test');
    expect(result.newCandidates[0]!.id).toBe(expected);
  });

  // ── Timestamps from turnData ────────────────────────────

  it('sets first_seen from first turn and last_seen from last turn', () => {
    const stdout = wrapClaude(validIncrementalResponse());
    const turns = defaultTurns();
    const result = parseIncrementalResponse(stdout, 'sess-001', turns);

    expect(result.newCandidates[0]!.first_seen).toBe('2026-04-20T10:00:00.000Z');
    expect(result.newCandidates[0]!.last_seen).toBe('2026-04-20T10:10:00.000Z');
  });

  it('uses current time when turnData is empty', () => {
    const stdout = wrapClaude(validIncrementalResponse());
    const beforeCall = new Date().toISOString();
    const result = parseIncrementalResponse(stdout, 'sess-001', []);
    const afterCall = new Date().toISOString();

    // first_seen and last_seen should be "now" (between before/after call)
    expect(result.newCandidates[0]!.first_seen >= beforeCall).toBe(true);
    expect(result.newCandidates[0]!.last_seen <= afterCall).toBe(true);
  });

  // ── Two-layer JSON unwrapping ───────────────────────────

  it('handles two-layer JSON unwrapping (claude CLI wrapper)', () => {
    const inner = { new_candidates: [], matched_existing: [], summary: '' };
    const stdout = wrapClaude(inner);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toEqual([]);
    expect(result.matchedExisting).toEqual([]);
    expect(result.summary).toBe('');
  });

  it('handles single-layer JSON (no wrapper)', () => {
    // Some claude versions return the inner JSON directly
    const inner = validIncrementalResponse();
    const stdout = JSON.stringify(inner);
    const result = parseIncrementalResponse(stdout, 'sess-001', defaultTurns());

    expect(result.newCandidates).toHaveLength(1);
    expect(result.matchedExisting).toHaveLength(1);
  });

  it('handles top-level string wrapper (bare string)', () => {
    const inner = validIncrementalResponse();
    const stdout = JSON.stringify(JSON.stringify(inner));
    const result = parseIncrementalResponse(stdout, 'sess-001', defaultTurns());

    expect(result.newCandidates).toHaveLength(1);
  });

  // ── Markdown fence stripping ────────────────────────────

  it('strips markdown fences from response', () => {
    const inner = validIncrementalResponse();
    const fenced = '```json\n' + JSON.stringify(inner) + '\n```';
    const stdout = wrapClaude(fenced);
    const result = parseIncrementalResponse(stdout, 'sess-001', defaultTurns());

    expect(result.newCandidates).toHaveLength(1);
    expect(result.matchedExisting).toHaveLength(1);
  });

  it('strips markdown fences without json tag', () => {
    const inner = validIncrementalResponse();
    const fenced = '```\n' + JSON.stringify(inner) + '\n```';
    const stdout = wrapClaude(fenced);
    const result = parseIncrementalResponse(stdout, 'sess-001', defaultTurns());

    expect(result.newCandidates).toHaveLength(1);
  });

  // ── Malformed JSON handling ─────────────────────────────

  it('returns empty results on completely invalid JSON', () => {
    const result = parseIncrementalResponse('this is not json', 'sess', defaultTurns());
    expect(result.newCandidates).toEqual([]);
    expect(result.matchedExisting).toEqual([]);
  });

  it('returns empty results when inner text is invalid JSON', () => {
    const stdout = JSON.stringify({ result: '{ not valid json !!!', model: 'm' });
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());
    expect(result.newCandidates).toEqual([]);
    expect(result.matchedExisting).toEqual([]);
  });

  it('returns empty results on null inner object', () => {
    const stdout = wrapClaude('null');
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());
    expect(result.newCandidates).toEqual([]);
    expect(result.matchedExisting).toEqual([]);
  });

  it('returns empty results on empty string', () => {
    const result = parseIncrementalResponse('', 'sess', defaultTurns());
    expect(result.newCandidates).toEqual([]);
    expect(result.matchedExisting).toEqual([]);
  });

  // ── Missing fields ─────────────────────────────────────

  it('drops new_candidates with missing pattern', () => {
    const response = {
      new_candidates: [
        {
          // no pattern
          severity: 'warning',
          rule_text: 'Always do something when something happens.',
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toEqual([]);
  });

  it('drops new_candidates with missing severity', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'some pattern',
          // no severity
          rule_text: 'Always do something when something happens.',
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toEqual([]);
  });

  it('handles missing new_candidates array gracefully', () => {
    const response = { matched_existing: [], summary: 'no candidates' };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toEqual([]);
    expect(result.matchedExisting).toEqual([]);
  });

  it('handles missing matched_existing array gracefully', () => {
    const response = { new_candidates: [], summary: 'no matches' };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toEqual([]);
    expect(result.matchedExisting).toEqual([]);
  });

  it('defaults occurrence_count to 1 when missing', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'test default count',
          severity: 'info',
          rule_text: 'Always check the default occurrence count behavior.',
          turn_ids: ['t-1'],
          // no occurrence_count
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toHaveLength(1);
    expect(result.newCandidates[0]!.occurrence_count).toBe(1);
  });

  it('clamps negative occurrence_count to 1', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'negative count pattern',
          severity: 'warning',
          rule_text: 'Negative occurrence counts must be clamped to one.',
          turn_ids: ['t-1'],
          occurrence_count: -100,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toHaveLength(1);
    expect(result.newCandidates[0]!.occurrence_count).toBe(1);
  });

  it('clamps zero occurrence_count to 1', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'zero count pattern',
          severity: 'info',
          rule_text: 'Zero occurrence counts must be clamped to one.',
          turn_ids: ['t-1'],
          occurrence_count: 0,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toHaveLength(1);
    expect(result.newCandidates[0]!.occurrence_count).toBe(1);
  });

  it('clamps negative additional_occurrences to 1', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          candidate_id: 'valid-id-neg',
          turn_ids: ['t-1'],
          additional_occurrences: -50,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting).toHaveLength(1);
    expect(result.matchedExisting[0]!.additionalOccurrences).toBe(1);
  });

  it('clamps zero additional_occurrences to 1', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          candidate_id: 'valid-id-zero',
          turn_ids: ['t-1'],
          additional_occurrences: 0,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting).toHaveLength(1);
    expect(result.matchedExisting[0]!.additionalOccurrences).toBe(1);
  });

  // ── rule_text validation ────────────────────────────────

  it('drops new_candidates with rule_text too short (< 10 chars)', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'short rule',
          severity: 'warning',
          rule_text: 'Too short', // 9 chars
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toEqual([]);
  });

  it('drops new_candidates with rule_text too long (> 500 chars)', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'long rule',
          severity: 'warning',
          rule_text: 'X'.repeat(501),
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toEqual([]);
  });

  it('accepts rule_text at exact boundaries (10 and 500 chars)', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'min boundary',
          severity: 'info',
          rule_text: 'A'.repeat(10),
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
        {
          pattern: 'max boundary',
          severity: 'info',
          rule_text: 'B'.repeat(500),
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toHaveLength(2);
  });

  // ── severity enum validation ────────────────────────────

  it('drops new_candidates with invalid severity', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'bad severity',
          severity: 'critical', // not in enum
          rule_text: 'Always validate severity values in your schemas.',
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toEqual([]);
  });

  it('accepts all valid severity values', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'info pattern',
          severity: 'info',
          rule_text: 'Information about something that should be noted.',
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
        {
          pattern: 'warning pattern',
          severity: 'warning',
          rule_text: 'Warning about a potentially problematic pattern.',
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
        {
          pattern: 'error pattern',
          severity: 'error',
          rule_text: 'Error indicating a critical recurring failure mode.',
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates).toHaveLength(3);
    expect(result.newCandidates.map((c) => c.severity)).toEqual(['info', 'warning', 'error']);
  });

  // ── Invalid candidate_id in matched_existing ────────────

  it('skips matched_existing with empty candidate_id', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          candidate_id: '',
          turn_ids: ['t-1'],
          additional_occurrences: 1,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting).toEqual([]);
  });

  it('skips matched_existing with missing candidate_id', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          // no candidate_id
          turn_ids: ['t-1'],
          additional_occurrences: 1,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting).toEqual([]);
  });

  it('skips matched_existing with invalid candidate_id format (uppercase)', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          candidate_id: 'INVALID-ID-FORMAT',
          turn_ids: ['t-1'],
          additional_occurrences: 1,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting).toEqual([]);
  });

  it('skips matched_existing with special characters in candidate_id', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          candidate_id: 'has spaces and $pecial',
          turn_ids: ['t-1'],
          additional_occurrences: 1,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting).toEqual([]);
  });

  it('accepts valid candidate_id with lowercase alphanumeric and dashes', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          candidate_id: 'llm-inc-abc123def456',
          turn_ids: ['t-1'],
          additional_occurrences: 2,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting).toHaveLength(1);
    expect(result.matchedExisting[0]!.candidateId).toBe('llm-inc-abc123def456');
    expect(result.matchedExisting[0]!.additionalOccurrences).toBe(2);
  });

  // ── Mixed valid/invalid entries ─────────────────────────

  it('accepts valid and silently drops invalid entries in the same response', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'valid one',
          severity: 'warning',
          rule_text: 'Always check the return value of database operations.',
          turn_ids: ['t-1'],
          occurrence_count: 1,
        },
        {
          pattern: 'invalid severity',
          severity: 'fatal',
          rule_text: 'This should be dropped due to invalid severity.',
          turn_ids: ['t-2'],
          occurrence_count: 1,
        },
        {
          pattern: 'too short rule',
          severity: 'info',
          rule_text: 'Short',
          turn_ids: ['t-3'],
          occurrence_count: 1,
        },
        {
          pattern: 'valid two',
          severity: 'error',
          rule_text: 'Never ignore compilation warnings in production builds.',
          turn_ids: ['t-1'],
          occurrence_count: 3,
        },
      ],
      matched_existing: [
        {
          candidate_id: 'valid-id-123',
          turn_ids: ['t-2'],
          additional_occurrences: 1,
        },
        {
          candidate_id: '', // invalid: empty
          turn_ids: ['t-3'],
          additional_occurrences: 1,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess-001', defaultTurns());

    expect(result.newCandidates).toHaveLength(2);
    expect(result.newCandidates[0]!.pattern).toBe('valid one');
    expect(result.newCandidates[1]!.pattern).toBe('valid two');

    expect(result.matchedExisting).toHaveLength(1);
    expect(result.matchedExisting[0]!.candidateId).toBe('valid-id-123');
  });

  // ── Never throws ────────────────────────────────────────

  it('never throws — returns empty on any failure', () => {
    // Various broken inputs — none should throw
    const brokenInputs = [
      '',
      'null',
      '42',
      '[]',
      'undefined',
      '{"result": null}',
      '{"result": 42}',
      '{"result": []}',
    ];

    for (const input of brokenInputs) {
      const result = parseIncrementalResponse(input, 'sess', defaultTurns());
      expect(result.newCandidates).toEqual([]);
      expect(result.matchedExisting).toEqual([]);
    }
  });

  // ── turn_ids filtering ──────────────────────────────────

  it('filters out non-string turn_ids from new_candidates', () => {
    const response = {
      new_candidates: [
        {
          pattern: 'mixed turn ids',
          severity: 'info',
          rule_text: 'Filter out invalid turn identifiers from candidate data.',
          turn_ids: ['t-1', 42, null, 't-2', true],
          occurrence_count: 1,
        },
      ],
      matched_existing: [],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.newCandidates[0]!.turn_ids).toEqual(['t-1', 't-2']);
  });

  it('filters out non-string turn_ids from matched_existing', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          candidate_id: 'valid-id-001',
          turn_ids: ['t-1', 123, 't-2'],
          additional_occurrences: 1,
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting[0]!.turnIds).toEqual(['t-1', 't-2']);
  });

  // ── defaults for matched_existing additional_occurrences ─

  it('defaults additional_occurrences to 1 when missing in matched_existing', () => {
    const response = {
      new_candidates: [],
      matched_existing: [
        {
          candidate_id: 'valid-id-002',
          turn_ids: ['t-1'],
          // no additional_occurrences
        },
      ],
    };
    const stdout = wrapClaude(response);
    const result = parseIncrementalResponse(stdout, 'sess', defaultTurns());

    expect(result.matchedExisting[0]!.additionalOccurrences).toBe(1);
  });
});

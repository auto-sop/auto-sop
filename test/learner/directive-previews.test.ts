/**
 * Unit tests for extractDirectivePreviews (V48).
 *
 * Covers:
 * - Basic extraction: short ID → first PREVIEW_WORD_LIMIT words of rule_text
 * - Truncation at PREVIEW_WORD_LIMIT words with '...' suffix
 * - Markdown stripping: bold (**), bracket tags ([...]), inline code (`...`)
 * - Edge cases: empty rule_text, very long, special chars, single word
 * - Multiple proposals produce correct map entries
 * - Proposals with known detector prefixes produce correct short IDs
 */
import { describe, it, expect } from 'vitest';
import {
  extractDirectivePreviews,
  PREVIEW_WORD_LIMIT,
} from '../../src/learner/directive-builder.js';

describe('extractDirectivePreviews', () => {
  it('produces correct ID→preview map for a single proposal', () => {
    const proposals = [
      {
        id: 'llm-inc-7ced4f9a',
        rule_text: 'Never add comments that describe WHAT a function does',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result).toEqual({
      'sop-7ced': 'Never add comments that describe WHAT a function does',
    });
  });

  it(`truncates at ${PREVIEW_WORD_LIMIT} words with ... suffix`, () => {
    const proposals = [
      {
        id: 'llm-inc-abcd1234',
        rule_text:
          'Always use the dedicated Read tool to inspect JSON state files rather than Bash with embedded Python',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-abcd']).toBe('Always use the dedicated Read tool to inspect JSON state...');
  });

  it(`does not truncate when exactly ${PREVIEW_WORD_LIMIT} words`, () => {
    const words = Array.from({ length: PREVIEW_WORD_LIMIT }, (_, i) => `word${i}`);
    const proposals = [
      {
        id: 'llm-inc-0000aaaa',
        rule_text: words.join(' '),
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-0000']).toBe(words.join(' '));
    expect(result['sop-0000']).not.toContain('...');
  });

  it(`does not truncate when fewer than ${PREVIEW_WORD_LIMIT} words`, () => {
    const proposals = [
      {
        id: 'llm-inc-1111bbbb',
        rule_text: 'Short rule text here',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-1111']).toBe('Short rule text here');
  });

  it('strips bold markdown markers', () => {
    const proposals = [
      {
        id: 'llm-inc-2222cccc',
        rule_text: '**Never** modify **CLAUDE.md** directly for testing',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-2222']).toBe('Never modify CLAUDE.md directly for testing');
    expect(result['sop-2222']).not.toContain('**');
  });

  it('strips bracket tags and keeps inner text', () => {
    const proposals = [
      {
        id: 'llm-inc-3333dddd',
        rule_text: 'Before [any production] deployment to [Vercel] verify env vars',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-3333']).toBe('Before any production deployment to Vercel verify env vars');
    expect(result['sop-3333']).not.toContain('[');
  });

  it('strips inline code backticks', () => {
    const proposals = [
      {
        id: 'llm-inc-4444eeee',
        rule_text: 'Always use the `Grep` tool for content search',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-4444']).toBe('Always use the Grep tool for content search');
    expect(result['sop-4444']).not.toContain('`');
  });

  it('handles empty rule_text', () => {
    const proposals = [
      {
        id: 'llm-inc-5555ffff',
        rule_text: '',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-5555']).toBe('');
  });

  it('handles rule_text with only whitespace', () => {
    const proposals = [
      {
        id: 'llm-inc-6666aaaa',
        rule_text: '   ',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-6666']).toBe('');
  });

  it('handles very long rule_text', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const proposals = [
      {
        id: 'llm-inc-7777bbbb',
        rule_text: words.join(' '),
      },
    ];
    const result = extractDirectivePreviews(proposals);
    const preview = result['sop-7777']!;
    expect(preview.endsWith('...')).toBe(true);
    // Should be exactly first PREVIEW_WORD_LIMIT words + '...'
    const expectedWords = words.slice(0, PREVIEW_WORD_LIMIT).join(' ') + '...';
    expect(preview).toBe(expectedWords);
  });

  it('handles special characters in rule_text', () => {
    const proposals = [
      {
        id: 'llm-inc-8888cccc',
        rule_text: 'Don\'t use "echo" > for file writing & redirection',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-8888']).toBe('Don\'t use "echo" > for file writing & redirection');
  });

  it('produces correct short IDs for different detector prefixes', () => {
    const proposals = [
      { id: 'repeated-bash-failure-abcd1234', rule_text: 'Rule A text' },
      { id: 'repeated-edit-fail-ef567890', rule_text: 'Rule B text' },
      { id: 'llm-inc-11112222', rule_text: 'Rule C text' },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['rbf-abcd', 'ref-ef56', 'sop-1111']),
    );
  });

  it('multiple proposals produce all entries', () => {
    const proposals = [
      { id: 'llm-inc-aaaa0000', rule_text: 'First rule text' },
      { id: 'llm-inc-bbbb1111', rule_text: 'Second rule text' },
      { id: 'llm-inc-cccc2222', rule_text: 'Third rule text' },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result['sop-aaaa']).toBe('First rule text');
    expect(result['sop-bbbb']).toBe('Second rule text');
    expect(result['sop-cccc']).toBe('Third rule text');
  });

  it('returns empty object for empty proposals array', () => {
    const result = extractDirectivePreviews([]);
    expect(result).toEqual({});
  });

  it('strips combined markdown: bold + brackets + backticks', () => {
    const proposals = [
      {
        id: 'llm-inc-combo123',
        rule_text: '**Never** run `grep` via [Bash] for [code search] tasks',
      },
    ];
    const result = extractDirectivePreviews(proposals);
    expect(result['sop-comb']).toBe('Never run grep via Bash for code search tasks');
  });
});

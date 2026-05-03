/**
 * Tests for V46: self-reported fire detection.
 * Covers detectSelfReportedFires() regex parsing, deduplication, and edge cases.
 */
import { describe, it, expect } from 'vitest';
import { detectSelfReportedFires } from '../../../src/capture/writer/directive-fire.js';

describe('detectSelfReportedFires', () => {
  // ── Basic parsing ──────────────────────────────────────────

  it('detects a single self-reported fire', () => {
    const output = 'I used the Grep tool as recommended. [sop:applied:llm-7ced]';
    expect(detectSelfReportedFires(output)).toEqual(['llm-7ced']);
  });

  it('detects multiple self-reported fires', () => {
    const output =
      'Following directives [sop:applied:llm-7ced] and [sop:applied:det-0001] in this response.';
    const result = detectSelfReportedFires(output);
    expect(result).toHaveLength(2);
    expect(result).toContain('llm-7ced');
    expect(result).toContain('det-0001');
  });

  it('deduplicates same directive reported twice in one turn', () => {
    const output =
      '[sop:applied:llm-7ced] used Grep here.\n' + 'Also [sop:applied:llm-7ced] used Grep again.';
    expect(detectSelfReportedFires(output)).toEqual(['llm-7ced']);
  });

  // ── Edge cases ─────────────────────────────────────────────

  it('returns empty array for empty string', () => {
    expect(detectSelfReportedFires('')).toEqual([]);
  });

  it('returns empty array for null-ish input', () => {
    expect(detectSelfReportedFires(null as unknown as string)).toEqual([]);
    expect(detectSelfReportedFires(undefined as unknown as string)).toEqual([]);
  });

  it('returns empty array when no markers present', () => {
    const output = 'I used the Grep tool to search for files. No directives were involved.';
    expect(detectSelfReportedFires(output)).toEqual([]);
  });

  it('does not match partial/malformed markers', () => {
    const output =
      '[sop:applied:] is empty\n' +
      '[sop:applied] is missing colon and id\n' +
      'sop:applied:llm-7ced without brackets\n' +
      '[sop:llm-7ced] wrong format';
    expect(detectSelfReportedFires(output)).toEqual([]);
  });

  it('handles IDs with underscores and hyphens', () => {
    const output = '[sop:applied:my_directive-id_123]';
    expect(detectSelfReportedFires(output)).toEqual(['my_directive-id_123']);
  });

  it('handles IDs with only alphanumeric chars', () => {
    const output = '[sop:applied:abc123]';
    expect(detectSelfReportedFires(output)).toEqual(['abc123']);
  });

  it('does not match IDs with special characters', () => {
    // The regex only allows [a-zA-Z0-9_-], so spaces/dots/etc should not match
    const output = '[sop:applied:has space] [sop:applied:has.dot]';
    // 'has' would match from first, 'has' from second — but the full IDs don't match
    expect(detectSelfReportedFires(output)).toEqual([]);
  });

  // ── Multiline ──────────────────────────────────────────────

  it('detects markers across multiple lines', () => {
    const output = [
      'First I checked the codebase [sop:applied:llm-aaaa]',
      '',
      'Then I used the Read tool [sop:applied:det-bbbb]',
      '',
      'Finally I ran tests [sop:applied:llm-cccc]',
    ].join('\n');
    const result = detectSelfReportedFires(output);
    expect(result).toHaveLength(3);
    expect(result).toContain('llm-aaaa');
    expect(result).toContain('det-bbbb');
    expect(result).toContain('llm-cccc');
  });

  it('handles markers in code blocks', () => {
    const output = '```\n[sop:applied:llm-code]\n```';
    expect(detectSelfReportedFires(output)).toEqual(['llm-code']);
  });

  // ── Deduplication order stability ──────────────────────────

  it('preserves insertion order for deduplicated results', () => {
    const output =
      '[sop:applied:bbb] first\n' + '[sop:applied:aaa] second\n' + '[sop:applied:bbb] duplicate';
    const result = detectSelfReportedFires(output);
    expect(result).toEqual(['bbb', 'aaa']);
  });

  // ── Large output ───────────────────────────────────────────

  it('handles large output with many markers', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${String(i).padStart(4, '0')}`);
    const output = ids.map((id) => `[sop:applied:${id}]`).join('\n');
    const result = detectSelfReportedFires(output);
    expect(result).toHaveLength(50);
    expect(result[0]).toBe('id-0000');
    expect(result[49]).toBe('id-0049');
  });
});

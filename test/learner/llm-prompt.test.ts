/**
 * Unit tests for src/learner/llm-prompt.ts
 *
 * Acceptance:
 *   1. Output contains the untrusted marker, the ≥3 rule, the
 *      ACTIONABLE keyword, and a JSON schema example.
 *   2. Output contains the project name, turn count, and session count.
 *   3. Output is valid UTF-8 and < 200K chars (Buffer byteLength).
 */
import { describe, it, expect } from 'vitest';
import { buildAnalysisPrompt } from '../../src/learner/llm-prompt.js';

describe('llm-prompt', () => {
  it('includes untrusted marker, ≥3 rule, ACTIONABLE keyword, and JSON schema', () => {
    const serialized =
      '<capture untrusted="true">\n--- Turn t-1 ---\n</capture>\n';
    const out = buildAnalysisPrompt(serialized, 'my-proj', 5, 20);

    // Security markers
    expect(out).toContain('UNTRUSTED');
    expect(out).toContain('<capture untrusted="true">');
    expect(out.toLowerCase()).toContain('never copy');

    // N≥3 rule — accept either the unicode "≥3" or a textual form.
    expect(out).toMatch(/(?:≥\s*3|at least 3|>=\s*3|3\s+distinct)/i);

    // ACTIONABLE keyword
    expect(out).toContain('ACTIONABLE');

    // JSON schema example fields
    expect(out).toContain('"directives"');
    expect(out).toContain('"id"');
    expect(out).toContain('"severity"');
    expect(out).toContain('"rule_text"');
    expect(out).toContain('"evidence"');
    expect(out).toContain('"session_ids"');
    expect(out).toContain('"turn_ids"');
    expect(out).toContain('"summary"');
    expect(out).toContain('"turns_analyzed"');
    expect(out).toContain('"patterns_below_threshold"');

    // Max 10 cap
    expect(out).toMatch(/10 directives/i);
  });

  it('includes project name, turn count, and session count', () => {
    const serialized = '<capture untrusted="true"></capture>\n';
    const out = buildAnalysisPrompt(serialized, 'acme-svc', 7, 42);

    expect(out).toContain('acme-svc');
    expect(out).toContain('42'); // turn count
    expect(out).toContain('7');  // session count
    expect(out).toContain('42 turns from 7 sessions');
  });

  it('output is valid UTF-8 and under 200K chars', () => {
    // Feed a realistically large serialized block (~80K chars) and
    // make sure the final prompt stays comfortably under the cap.
    const serialized =
      '<capture untrusted="true">\n' +
      'X'.repeat(80_000) +
      '\n</capture>\n';
    const out = buildAnalysisPrompt(serialized, 'demo', 3, 30);

    expect(out.length).toBeLessThan(200_000);

    // Round-trip through Buffer to confirm it is valid UTF-8.
    const buf = Buffer.from(out, 'utf8');
    expect(buf.toString('utf8')).toBe(out);
  });

  it('truncates when caller passes oversize serialized input', () => {
    // Safety net: a rogue caller hands us a 500K string. Output
    // must still cap at the 200K safety limit.
    const serialized = 'Y'.repeat(500_000);
    const out = buildAnalysisPrompt(serialized, 'demo', 1, 1);

    expect(out.length).toBeLessThanOrEqual(200_000);
  });

  it('renders zero-turn analysis without throwing', () => {
    const out = buildAnalysisPrompt(
      '<capture untrusted="true"></capture>\n',
      'demo',
      0,
      0,
    );
    expect(out).toContain('0 turns from 0 sessions');
    expect(out).toContain('ACTIONABLE');
  });

  it('escapes nothing surprising in project name (plain passthrough)', () => {
    // The project name is echoed in a markdown header; the
    // builder does not (and should not) HTML-escape it since this
    // is LLM prose, not HTML rendering. Just verify passthrough.
    const out = buildAnalysisPrompt(
      '<capture untrusted="true"></capture>\n',
      'weird name with spaces',
      1,
      1,
    );
    expect(out).toContain('weird name with spaces');
  });
});

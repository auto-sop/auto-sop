/**
 * Unit tests for buildRestoredBody() in src/installer/orchestrator.ts
 *
 * Covers:
 * - [sop:ID] tags rendered via shortDirectiveId
 * - Transparency block present when directives > 0, absent when 0
 * - Evidence lines with correct pluralization (session/sessions)
 * - Multiple directives preserve order with correct formatting
 * - Restored header always present
 */
import { describe, it, expect } from 'vitest';
import { buildRestoredBody } from '../../src/installer/orchestrator.js';
import { shortDirectiveId } from '../../src/learner/directive-builder.js';
import type { DirectiveHistoryEntry } from '../../src/managed-section/directive-history.js';

function makeEntry(overrides: Partial<DirectiveHistoryEntry> = {}): DirectiveHistoryEntry {
  return {
    id: 'llm-inc-7ced4f9a',
    rule_text: 'Always check return values before using them.',
    severity: 'warning',
    first_seen: '2026-01-01T00:00:00Z',
    last_reinforced: '2026-04-30T00:00:00Z',
    occurrence_count: 3,
    pruned: false,
    ...overrides,
  };
}

describe('buildRestoredBody', () => {
  it('renders a single directive with [sop:ID] tag and evidence line', () => {
    const entry = makeEntry();
    const { body } = buildRestoredBody([entry]);

    const expectedId = shortDirectiveId(entry.id);
    expect(body).toContain(`[sop:${expectedId}]`);
    expect(body).toContain('_(evidence: 3 sessions)_');
    expect(body).toContain('**[warning]**');
    expect(body).toContain(entry.rule_text);
  });

  it('uses singular "session" when occurrence_count is 1', () => {
    const entry = makeEntry({ occurrence_count: 1 });
    const { body } = buildRestoredBody([entry]);

    expect(body).toContain('_(evidence: 1 session)_');
    expect(body).not.toContain('_(evidence: 1 sessions)_');
  });

  it('uses plural "sessions" when occurrence_count > 1', () => {
    const entry = makeEntry({ occurrence_count: 5 });
    const { body } = buildRestoredBody([entry]);

    expect(body).toContain('_(evidence: 5 sessions)_');
  });

  it('renders transparency block when directives > 0', () => {
    const { body } = buildRestoredBody([makeEntry()]);

    expect(body).toContain('**Transparency**:');
    expect(body).toContain('[sop:applied:<id>]');
    expect(body).toContain('Do not force-apply directives');
  });

  it('omits transparency block when directives list is empty', () => {
    const { body } = buildRestoredBody([]);

    expect(body).not.toContain('**Transparency**');
    expect(body).not.toContain('[sop:applied:<id>]');
  });

  it('always includes the restored header', () => {
    const { body } = buildRestoredBody([makeEntry()]);
    expect(body).toContain('_Directives restored from previous install._');
  });

  it('always includes the restored header even with empty entries', () => {
    const { body } = buildRestoredBody([]);
    expect(body).toContain('_Directives restored from previous install._');
  });

  it('renders correct directive count in Learnings header', () => {
    const entries = [makeEntry(), makeEntry({ id: 'repeated-bash-failure-abcd1234', severity: 'error' })];
    const { body } = buildRestoredBody(entries);

    expect(body).toContain('**Learnings** (2 active directives)');
  });

  it('uses singular "directive" when count is 1', () => {
    const { body } = buildRestoredBody([makeEntry()]);
    expect(body).toContain('**Learnings** (1 active directive)');
  });

  it('renders multiple directives with distinct IDs and preserves order', () => {
    const entries = [
      makeEntry({ id: 'repeated-bash-failure-aaaa1111', severity: 'error', rule_text: 'Rule A', occurrence_count: 2 }),
      makeEntry({ id: 'llm-inc-bbbb2222', severity: 'warning', rule_text: 'Rule B', occurrence_count: 7 }),
    ];
    const { body } = buildRestoredBody(entries);

    const idA = shortDirectiveId('repeated-bash-failure-aaaa1111');
    const idB = shortDirectiveId('llm-inc-bbbb2222');

    // Both IDs present
    expect(body).toContain(`[sop:${idA}]`);
    expect(body).toContain(`[sop:${idB}]`);

    // Both evidence lines present
    expect(body).toContain('_(evidence: 2 sessions)_');
    expect(body).toContain('_(evidence: 7 sessions)_');

    // Order preserved: Rule A before Rule B
    const posA = body.indexOf('Rule A');
    const posB = body.indexOf('Rule B');
    expect(posA).toBeLessThan(posB);
  });

  it('renders expected full format for a single directive', () => {
    const entry = makeEntry({
      id: 'llm-inc-7ced4f9a',
      severity: 'error',
      rule_text: 'Never deploy without env vars.',
      occurrence_count: 3,
    });
    const { body } = buildRestoredBody([entry]);

    const expectedId = shortDirectiveId(entry.id);

    // Verify structural elements in order
    const lines = body.split('\n');
    expect(lines[0]).toBe('_Directives restored from previous install._');

    // Transparency block present
    expect(body).toContain('**Transparency**:');

    // Learnings header
    expect(body).toContain('**Learnings** (1 active directive)');

    // Bullet with sop tag
    expect(body).toContain(`- **[error]** Never deploy without env vars. [sop:${expectedId}]`);

    // Evidence line indented
    expect(body).toContain('  _(evidence: 3 sessions)_');
  });
});

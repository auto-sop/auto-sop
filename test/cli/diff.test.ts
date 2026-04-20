/**
 * Unit tests for the pure JS unified diff module.
 */
import { describe, it, expect } from 'vitest';
import { unifiedDiff } from '../../src/cli/diff.js';

describe('unifiedDiff', () => {
  it('returns empty string for identical texts', () => {
    const text = 'hello\nworld\n';
    expect(unifiedDiff(text, text)).toBe('');
  });

  it('shows a simple one-line addition', () => {
    const old = 'line1\nline2\nline3\n';
    const now = 'line1\nline2\ninserted\nline3\n';
    const diff = unifiedDiff(old, now, { oldLabel: 'a.txt', newLabel: 'b.txt' });

    expect(diff).toContain('--- a.txt');
    expect(diff).toContain('+++ b.txt');
    expect(diff).toContain('+inserted');
    expect(diff).toContain('@@');
  });

  it('shows a simple one-line deletion', () => {
    const old = 'line1\nline2\nline3\n';
    const now = 'line1\nline3\n';
    const diff = unifiedDiff(old, now);

    expect(diff).toContain('-line2');
  });

  it('shows a modification (delete + insert)', () => {
    const old = 'line1\nold-line\nline3\n';
    const now = 'line1\nnew-line\nline3\n';
    const diff = unifiedDiff(old, now);

    expect(diff).toContain('-old-line');
    expect(diff).toContain('+new-line');
  });

  it('includes context lines around changes (default 3)', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const oldLines = [...lines];
    const newLines = [...lines];
    newLines[5] = 'CHANGED';

    const old = oldLines.join('\n') + '\n';
    const now = newLines.join('\n') + '\n';
    const diff = unifiedDiff(old, now, { context: 3 });

    // Should include context before and after the change
    expect(diff).toContain(' line3');
    expect(diff).toContain(' line4');
    expect(diff).toContain(' line5');
    expect(diff).toContain('-line6');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain(' line7');
    expect(diff).toContain(' line8');
  });

  it('handles empty old text (entire new file)', () => {
    const diff = unifiedDiff('', 'new content\n');
    expect(diff).toContain('+new content');
  });

  it('handles empty new text (entire file deleted)', () => {
    const diff = unifiedDiff('old content\n', '');
    expect(diff).toContain('-old content');
  });

  it('handles multi-line additions at end of file', () => {
    const old = 'existing\n';
    const now = 'existing\nnew1\nnew2\nnew3\n';
    const diff = unifiedDiff(old, now);

    expect(diff).toContain('+new1');
    expect(diff).toContain('+new2');
    expect(diff).toContain('+new3');
  });

  it('uses custom labels', () => {
    const diff = unifiedDiff('a\n', 'b\n', {
      oldLabel: 'original.md',
      newLabel: 'modified.md',
    });
    expect(diff).toContain('--- original.md');
    expect(diff).toContain('+++ modified.md');
  });

  it('handles CLAUDE.md-like content with markers', () => {
    const old = ['# My Project', '', 'Custom rules here.', ''].join('\n');

    const now = [
      '# My Project',
      '',
      'Custom rules here.',
      '',
      '<!-- auto-sop:managed-section:begin v1 -->',
      '<!-- GENERATED - DO NOT EDIT. auto-sop owns this section. -->',
      '',
      '_Data as of: 2026-04-14T22:20:00Z · 3 turns analyzed · 2 agents: commander, main_',
      '',
      '**Learnings**',
      '',
      '_No directives generated yet — pattern detection ships in the next version._',
      '',
      '<!-- auto-sop:managed-section:end -->',
      '',
    ].join('\n');

    const diff = unifiedDiff(old, now, {
      oldLabel: 'project/CLAUDE.md',
      newLabel: 'project/CLAUDE.md (proposed)',
    });

    expect(diff).toContain('+<!-- auto-sop:managed-section:begin v1 -->');
    expect(diff).toContain('+_Data as of:');
    expect(diff).toContain('+<!-- auto-sop:managed-section:end -->');
    // Original content should appear as context (equal lines)
    expect(diff).toContain(' # My Project');
  });

  it('works with custom context=1', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const newLines = [...lines];
    newLines[5] = 'CHANGED';

    const old = lines.join('\n');
    const now = newLines.join('\n');
    const diff = unifiedDiff(old, now, { context: 1 });

    expect(diff).toContain(' line5');
    expect(diff).toContain('-line6');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain(' line7');
    // Should NOT include lines far away from the change
    expect(diff).not.toContain(' line1');
    expect(diff).not.toContain(' line10');
  });

  it('handles both texts being empty', () => {
    expect(unifiedDiff('', '')).toBe('');
  });

  it('produces valid hunk headers with line numbers', () => {
    const old = 'a\nb\nc\n';
    const now = 'a\nx\nc\n';
    const diff = unifiedDiff(old, now);

    // Should have @@ -N,M +N,M @@ format
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });
});

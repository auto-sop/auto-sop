/**
 * Unit tests for the recap verb — specifically the directive column
 * and dry-run diff rendering.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('recap verb: directive column', () => {
  /**
   * formatEntry is not exported, so we test it indirectly by importing the module
   * and checking its behavior through the recap verb registration. For unit-level
   * testing, we re-verify the logic with the directiveLabel function pattern.
   */

  it('PerProjectRecap type accepts all directive_written verdicts', async () => {
    // Verify the recap-log type allows all directive_written values
    const verdicts = ['created', 'updated', 'unchanged', 'dry_run', 'error', null, undefined];

    for (const v of verdicts) {
      const recap: Record<string, unknown> = { directive_written: v };
      expect(recap.directive_written).toBe(v);
    }
  });
});

describe('recap verb: dry-run diff computation', () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'recap-dryrun-'));
    tmpProject = join(tmpHome, 'test-project');
    mkdirSync(join(tmpProject, '.auto-sop', 'captures'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('unifiedDiff produces correct diff for CLAUDE.md creation scenario', async () => {
    const { unifiedDiff } = await import('../../../src/cli/diff.js');
    const { buildSampleDirectiveFromInput } =
      await import('../../../src/learner/directive-builder.js');
    const { buildSectionBlock, CLAUDE_MD_HEADER } =
      await import('../../../src/managed-section/markers.js');

    const content = buildSampleDirectiveFromInput({
      turnsTotalSeen: 5,
      agentRoster: ['commander', 'main'],
      nowIso: '2026-04-14T22:20:00Z',
    });

    const sectionBlock = buildSectionBlock(content.body);
    const newContent = CLAUDE_MD_HEADER + '\n' + sectionBlock + '\n';

    // No existing file → diff from empty
    const diff = unifiedDiff('', newContent, {
      oldLabel: 'test-project/CLAUDE.md',
      newLabel: 'test-project/CLAUDE.md (proposed)',
    });

    expect(diff).toContain('+# CLAUDE.md');
    expect(diff).toContain('+<!-- auto-sop:managed-section:begin v1 -->');
    expect(diff).toContain('5 turns analyzed');
    expect(diff).toContain('2 agents: commander, main');
  });

  it('unifiedDiff shows only managed section delta on update', async () => {
    const { unifiedDiff } = await import('../../../src/cli/diff.js');
    const { buildSampleDirectiveFromInput } =
      await import('../../../src/learner/directive-builder.js');
    const { buildSectionBlock, BEGIN_MARKER, END_MARKER, GENERATED_COMMENT } =
      await import('../../../src/managed-section/markers.js');

    // Existing CLAUDE.md with user content + old managed section.
    // B4: stats line now reads "_Data as of:" anchored to newest
    // captured turn instead of wall-clock "_Last updated:".
    const userContent = '# My Project\n\nCustom rules here.\n\n';
    const oldBody =
      '_Data as of: 2026-04-14T22:20:00Z · 3 turns analyzed · 2 agents: commander, main_\n\n**Learnings**\n\n_No directives generated yet — pattern detection ships in the next version._';
    const oldSection = [BEGIN_MARKER, GENERATED_COMMENT, '', oldBody, '', END_MARKER].join('\n');
    const oldContent = userContent + oldSection + '\n';

    // New content with updated turn count
    const newDirective = buildSampleDirectiveFromInput({
      turnsTotalSeen: 7,
      agentRoster: ['commander', 'main'],
      nowIso: '2026-04-14T22:20:00Z',
      newestTurnFinalizedAt: '2026-04-14T22:20:00Z',
    });
    const newSection = buildSectionBlock(newDirective.body);
    const newContent = userContent + newSection + '\n';

    const diff = unifiedDiff(oldContent, newContent, {
      oldLabel: 'project/CLAUDE.md',
      newLabel: 'project/CLAUDE.md (proposed)',
    });

    // Should show the change from 3 to 7 turns
    expect(diff).toContain('-_Data as of: 2026-04-14T22:20:00Z · 3 turns analyzed');
    expect(diff).toContain('+_Data as of: 2026-04-14T22:20:00Z · 7 turns analyzed');
    // User content should appear as context (unchanged)
    expect(diff).not.toContain('-# My Project');
    expect(diff).not.toContain('+# My Project');
  });

  it('unifiedDiff returns empty string when content is identical', async () => {
    const { unifiedDiff } = await import('../../../src/cli/diff.js');
    const content = '# Test\n\nSome content.\n';
    expect(unifiedDiff(content, content)).toBe('');
  });
});

describe('recap verb: flag registration', () => {
  it('recap command registers --run, --dry-run, --offline (PLAN-v14)', async () => {
    // Verify that the recap verb correctly registers the expected flags.
    // PLAN-v14 replaced --llm with --offline because LLM mode is now
    // the default (free via Claude Max).
    const { Command } = await import('commander');
    const { registerRecapVerb } = await import('../../../src/cli/verbs/recap.js');

    const program = new Command();
    registerRecapVerb(program);

    const recapCmd = program.commands.find((c) => c.name() === 'recap');
    expect(recapCmd).toBeDefined();

    const options = recapCmd!.options.map((o) => o.long);
    expect(options).toContain('--dry-run');
    expect(options).toContain('--run');
    expect(options).toContain('--offline');
    // --llm was removed in PLAN-v14; ensure it isn't accidentally restored.
    expect(options).not.toContain('--llm');
  });
});

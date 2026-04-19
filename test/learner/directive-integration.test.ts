/**
 * Integration test: Directive writing wired into the learner flow.
 * Creates a tmpHome with 1 fake project + 3 fake turns, simulates the
 * learner tick logic, and asserts CLAUDE.md is created/updated correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeManagedSection, readManagedSection } from '../../src/managed-section/editor.js';
import { BEGIN_MARKER, END_MARKER } from '../../src/managed-section/markers.js';
import { buildSampleDirective } from '../../src/learner/directive-builder.js';
import type { ProjectRegistryEntry } from '../../src/learner/project-registry.js';
import type { PerProjectRecap } from '../../src/learner/recap-log.js';

describe('directive-integration', () => {
  let tmpHome: string;
  let tmpProject: string;
  let capturesDir: string;
  let project: ProjectRegistryEntry;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'directive-int-'));
    tmpProject = join(tmpHome, 'fake-project');
    capturesDir = join(tmpProject, '.auto-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });

    project = {
      project_id: 'int-test-proj',
      slug: 'fake-project',
      project_root: tmpProject,
      installed_at: '2026-04-14T20:00:00Z',
      last_seen_at: '2026-04-14T20:00:00Z',
    };
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedTurn(name: string, agent: string, finalizedAt: string): void {
    const dir = join(capturesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        schema_version: 1,
        project_id: project.project_id,
        project_slug: project.slug,
        session_id: 'sess-001',
        turn_id: name,
        parent_turn_id: null,
        children_turn_ids: [],
        agent,
        subagent_type: null,
        started_at: finalizedAt,
        finalized_at: finalizedAt,
        finalization_reason: 'stop',
        hook_shim_version: '0.0.0',
        files_changed_count: 1,
        tool_call_count: 2,
        scrubber_hit_count: 0,
      }),
    );
  }

  /** Simulate what the learner main loop does for a single project. */
  function simulateLearnerDirectiveWrite(opts?: {
    dryRun?: boolean;
    turnsTotalSeen?: number;
    nowIso?: string;
    newestTurnFinalizedAt?: string;
  }): PerProjectRecap {
    const turnsTotalSeen = opts?.turnsTotalSeen ?? 3;
    const nowIso = opts?.nowIso ?? '2026-04-14T22:20:00Z';
    // B4: main.ts derives this from the cursor's post-update
    // `last_finalized_at`; here we mirror the same intent with a
    // stable default so the rendered body is data-anchored.
    const newestTurnFinalizedAt =
      opts?.newestTurnFinalizedAt ?? '2026-04-14T22:20:00Z';

    const recap: PerProjectRecap = {
      v: 1,
      t: nowIso,
      tick_id: 'ck-22h20',
      project_id: project.project_id,
      project_slug: project.slug,
      turns_new: 3,
      turns_total_seen: turnsTotalSeen,
      tool_calls_new: 6,
      scrubber_hits_new: 0,
      files_changed_new: 3,
      finalization_failures_new: 0,
      skipped_poison: 0,
      oldest_new_turn_at: '2026-04-14T20:00:00Z',
      newest_new_turn_at: '2026-04-14T22:00:00Z',
      duration_ms: 10,
      llm_mode: false,
    };

    // Mirror the logic from main.ts
    try {
      const directiveContent = buildSampleDirective(
        project,
        nowIso,
        turnsTotalSeen,
        newestTurnFinalizedAt,
      );
      const writeResult = writeManagedSection({
        projectRoot: project.project_root,
        content: directiveContent,
        dryRun: opts?.dryRun ?? false,
      });
      recap.directive_written = writeResult.verdict;
      recap.directive_bytes = writeResult.bytesAfter;
      recap.directive_backup = writeResult.backupPath !== null;
    } catch (err) {
      recap.directive_written = 'error';
    }

    return recap;
  }

  it('creates CLAUDE.md on first tick with no existing file', () => {
    seedTurn('turn-001', 'main', '2026-04-14T20:00:00Z');
    seedTurn('turn-002', 'commander', '2026-04-14T21:00:00Z');
    seedTurn('turn-003', 'main', '2026-04-14T22:00:00Z');

    const recap = simulateLearnerDirectiveWrite();

    expect(recap.directive_written).toBe('created');
    expect(recap.directive_bytes).toBeGreaterThan(0);
    expect(recap.directive_backup).toBe(false); // no backup on create

    // Verify CLAUDE.md exists with correct content
    const claudeMd = readFileSync(join(tmpProject, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(BEGIN_MARKER);
    expect(claudeMd).toContain(END_MARKER);
    expect(claudeMd).toContain('3 turns analyzed');
    expect(claudeMd).toContain('commander, main');
    expect(claudeMd).toContain('2026-04-14T22:20:00Z');
  });

  it('returns unchanged when same data on second tick', () => {
    seedTurn('turn-001', 'main', '2026-04-14T20:00:00Z');
    seedTurn('turn-002', 'commander', '2026-04-14T21:00:00Z');
    seedTurn('turn-003', 'main', '2026-04-14T22:00:00Z');

    const recap1 = simulateLearnerDirectiveWrite();
    expect(recap1.directive_written).toBe('created');

    // Second tick, same data, same minute
    const recap2 = simulateLearnerDirectiveWrite();
    expect(recap2.directive_written).toBe('unchanged');
  });

  it('returns updated when turn count changes', () => {
    seedTurn('turn-001', 'main', '2026-04-14T20:00:00Z');
    seedTurn('turn-002', 'commander', '2026-04-14T21:00:00Z');
    seedTurn('turn-003', 'main', '2026-04-14T22:00:00Z');

    const recap1 = simulateLearnerDirectiveWrite({ turnsTotalSeen: 3 });
    expect(recap1.directive_written).toBe('created');

    // New turns arrived → total increased
    const recap2 = simulateLearnerDirectiveWrite({ turnsTotalSeen: 5 });
    expect(recap2.directive_written).toBe('updated');
    expect(recap2.directive_backup).toBe(true);

    // Verify CLAUDE.md shows new count
    const claudeMd = readFileSync(join(tmpProject, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('5 turns analyzed');

    // Verify backup exists
    const backupPath = join(tmpProject, '.auto-sop', 'state', 'CLAUDE.md.backup');
    expect(existsSync(backupPath)).toBe(true);
    const backup = readFileSync(backupPath, 'utf8');
    expect(backup).toContain('3 turns analyzed');
  });

  it('dry-run does not touch CLAUDE.md', () => {
    seedTurn('turn-001', 'main', '2026-04-14T20:00:00Z');

    const recap = simulateLearnerDirectiveWrite({ dryRun: true });
    expect(recap.directive_written).toBe('dry_run');
    expect(existsSync(join(tmpProject, 'CLAUDE.md'))).toBe(false);
  });

  it('preserves existing user content in CLAUDE.md', () => {
    // User already has a CLAUDE.md
    const userContent = '# My Project\n\nCustom rules here.\n';
    writeFileSync(join(tmpProject, 'CLAUDE.md'), userContent);

    seedTurn('turn-001', 'main', '2026-04-14T20:00:00Z');

    const recap = simulateLearnerDirectiveWrite({ turnsTotalSeen: 1 });
    expect(recap.directive_written).toBe('updated'); // appends to existing

    const claudeMd = readFileSync(join(tmpProject, 'CLAUDE.md'), 'utf8');
    // User content preserved at top
    expect(claudeMd.startsWith('# My Project\n\nCustom rules here.')).toBe(true);
    // Managed section appended at bottom
    expect(claudeMd).toContain(BEGIN_MARKER);
    expect(claudeMd).toContain('1 turn analyzed');
  });

  it('records error when editor throws (e.g., malformed markers)', () => {
    // Create CLAUDE.md with begin marker but no end marker → MalformedMarkersError
    writeFileSync(
      join(tmpProject, 'CLAUDE.md'),
      `# My Project\n\n${BEGIN_MARKER}\nsome content\n`,
    );

    seedTurn('turn-001', 'main', '2026-04-14T20:00:00Z');

    const recap = simulateLearnerDirectiveWrite();
    expect(recap.directive_written).toBe('error');

    // CLAUDE.md should NOT be corrupted
    const claudeMd = readFileSync(join(tmpProject, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toBe(`# My Project\n\n${BEGIN_MARKER}\nsome content\n`);
  });

  it('handles agent roster from multiple agents across turns', () => {
    seedTurn('turn-001', 'main', '2026-04-14T20:00:00Z');
    seedTurn('turn-002', 'architect-principal-engineer', '2026-04-14T21:00:00Z');
    seedTurn('turn-003', 'commander', '2026-04-14T22:00:00Z');

    simulateLearnerDirectiveWrite();

    const claudeMd = readFileSync(join(tmpProject, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('3 agents: architect-principal-engineer, commander, main');
  });

  it('read-after-write roundtrip returns the written body', () => {
    seedTurn('turn-001', 'main', '2026-04-14T20:00:00Z');

    simulateLearnerDirectiveWrite({ turnsTotalSeen: 1 });

    const section = readManagedSection(tmpProject);
    expect(section).not.toBeNull();
    expect(section!.body).toContain('1 turn analyzed');
    expect(section!.body).toContain('1 agent: main');
  });
});

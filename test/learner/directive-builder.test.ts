/**
 * Unit tests for src/learner/directive-builder.ts
 *
 * Covers:
 * - roundToMinute edge cases (including crossing hour/day)
 * - buildDirectiveBodyFromInput formatting with/without proposals
 * - Sorting: severity (error > warning > info), then created_at, then id
 * - Idempotency (same inputs → byte-identical body)
 * - Monitoring text when candidates > 0 but proposals empty
 * - Empty state ("No recurring patterns detected yet.")
 * - collectAgentRoster + filesystem-backed buildDirectiveBody
 * - Legacy buildSampleDirective / buildSampleDirectiveFromInput shims
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSampleDirective,
  buildSampleDirectiveFromInput,
  buildDirectiveBody,
  buildDirectiveBodyFromInput,
  collectAgentRoster,
  roundToMinute,
} from '../../src/learner/directive-builder.js';
import type { ProjectRegistryEntry } from '../../src/learner/project-registry.js';
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

describe('directive-builder', () => {
  // ── roundToMinute ─────────────────────────────────────────

  describe('roundToMinute', () => {
    it('rounds down when seconds < 30', () => {
      expect(roundToMinute('2026-04-14T22:23:29.999Z')).toBe('2026-04-14T22:23:00Z');
    });

    it('rounds up when seconds >= 30', () => {
      expect(roundToMinute('2026-04-14T22:23:30.000Z')).toBe('2026-04-14T22:24:00Z');
    });

    it('exact minute stays unchanged', () => {
      expect(roundToMinute('2026-04-14T22:23:00.000Z')).toBe('2026-04-14T22:23:00Z');
    });

    it('rounds up across hour boundary', () => {
      expect(roundToMinute('2026-04-14T22:59:45.000Z')).toBe('2026-04-14T23:00:00Z');
    });

    it('rounds up across day boundary', () => {
      expect(roundToMinute('2026-04-14T23:59:30.000Z')).toBe('2026-04-15T00:00:00Z');
    });
  });

  // ── buildDirectiveBodyFromInput (pure, no fs) ──────────

  describe('buildDirectiveBodyFromInput', () => {
    it('formats stats header correctly with agents', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 47,
        agentRoster: ['architect-principal-engineer', 'commander', 'main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [],
        candidateCount: 0,
      });

      expect(result.body).toContain('_Last updated: 2026-04-14T22:20:00Z');
      expect(result.body).toContain('47 turns analyzed');
      expect(result.body).toContain(
        '3 agents: architect-principal-engineer, commander, main_',
      );
      expect(result.body).toContain('**Learnings**');
    });

    it('2 proposals → body has both bullets, header says "(2 active directives)"', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 10,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [
          makeProposal({
            id: 'det-aaaa',
            rule_text:
              'Command `npm test` has exited non-zero in 3 sessions. Consider verifying prerequisites.',
            created_at: '2026-04-14T10:00:00.000Z',
          }),
          makeProposal({
            id: 'det-bbbb',
            rule_text:
              'Edit exact-string-match has failed in 3 sessions for `src/a.ts`. Always Read before Edit.',
            created_at: '2026-04-14T11:00:00.000Z',
          }),
        ],
        candidateCount: 0,
      });

      expect(result.body).toContain('**Learnings** (2 active directives)');
      expect(result.body).toContain('npm test');
      expect(result.body).toContain('src/a.ts');
      // both bullets present
      const bullets = result.body.split('\n').filter((l) => l.startsWith('- **['));
      expect(bullets).toHaveLength(2);
    });

    it('single proposal → header says "(1 active directive)" (singular)', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 3,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [makeProposal()],
        candidateCount: 0,
      });
      expect(result.body).toContain('**Learnings** (1 active directive)');
    });

    it('0 proposals + 3 candidates → mentions "tracking 3 candidate patterns"', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 10,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [],
        candidateCount: 3,
      });

      expect(result.body).toContain('**Learnings**');
      expect(result.body).toContain('Monitoring');
      expect(result.body).toContain('tracking 3 candidate patterns');
    });

    it('0 proposals + 1 candidate → "1 candidate pattern" (singular)', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 5,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [],
        candidateCount: 1,
      });
      expect(result.body).toContain('tracking 1 candidate pattern');
      // not plural
      expect(result.body).not.toContain('1 candidate patterns');
    });

    it('0 proposals + 0 candidates → "No recurring patterns detected yet."', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 5,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [],
        candidateCount: 0,
      });
      expect(result.body).toContain('**Learnings**');
      expect(result.body).toContain('No recurring patterns detected yet.');
    });

    it('is deterministic — same inputs yield byte-identical body', () => {
      const proposals = [makeProposal({ id: 'det-aaaa' }), makeProposal({ id: 'det-bbbb' })];
      const input = {
        turnsTotalSeen: 10,
        agentRoster: ['main', 'commander'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals,
        candidateCount: 2,
      };
      const a = buildDirectiveBodyFromInput(input);
      const b = buildDirectiveBodyFromInput(input);
      expect(a.body).toBe(b.body);
    });

    it('proposals sorted by severity: error first, then warning, then info', () => {
      const warning = makeProposal({
        id: 'det-warn',
        severity: 'warning',
        rule_text: 'WARNING RULE is here and long enough to pass validation.',
      });
      const info = makeProposal({
        id: 'det-info',
        severity: 'info',
        rule_text: 'INFO RULE is here and long enough to pass validation.',
      });
      const error = makeProposal({
        id: 'det-error',
        severity: 'error',
        rule_text: 'ERROR RULE is here and long enough to pass validation.',
      });

      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 3,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        // Insert in deliberately-wrong order
        proposals: [info, warning, error],
        candidateCount: 0,
      });

      const errorIdx = result.body.indexOf('ERROR RULE');
      const warningIdx = result.body.indexOf('WARNING RULE');
      const infoIdx = result.body.indexOf('INFO RULE');
      expect(errorIdx).toBeGreaterThan(-1);
      expect(warningIdx).toBeGreaterThan(-1);
      expect(infoIdx).toBeGreaterThan(-1);
      expect(errorIdx).toBeLessThan(warningIdx);
      expect(warningIdx).toBeLessThan(infoIdx);
    });

    it('same-severity proposals sort by created_at ascending', () => {
      const later = makeProposal({
        id: 'det-later',
        created_at: '2026-04-14T23:00:00.000Z',
        rule_text: 'LATER RULE which is long enough to pass validation checks.',
      });
      const earlier = makeProposal({
        id: 'det-earlier',
        created_at: '2026-04-14T10:00:00.000Z',
        rule_text: 'EARLIER RULE which is long enough to pass validation checks.',
      });
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 3,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [later, earlier],
        candidateCount: 0,
      });
      expect(result.body.indexOf('EARLIER RULE')).toBeLessThan(
        result.body.indexOf('LATER RULE'),
      );
    });

    it('bullet includes severity tag, rule_text, and evidence line', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 3,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [makeProposal()],
        candidateCount: 0,
      });
      expect(result.body).toContain('- **[warning]**');
      expect(result.body).toContain('Command `npm test`');
      expect(result.body).toContain('evidence: 3 sessions');
      expect(result.body).toContain('first seen 2026-04-14');
    });

    it('singular "turn" / "agent" for count of 1', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 1,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [],
        candidateCount: 0,
      });
      expect(result.body).toContain('1 turn analyzed');
      expect(result.body).toContain('1 agent: main_');
    });

    it('handles zero turns / empty agent roster', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 0,
        agentRoster: [],
        nowIso: '2026-04-14T22:20:00Z',
        proposals: [],
        candidateCount: 0,
      });
      expect(result.body).toContain('0 turns analyzed');
      expect(result.body).toContain('0 agents: none detected_');
    });

    it('rounds timestamp to nearest minute', () => {
      const result = buildDirectiveBodyFromInput({
        turnsTotalSeen: 5,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:23:47.123Z',
        proposals: [],
        candidateCount: 0,
      });
      expect(result.body).toContain('2026-04-14T22:24:00Z');
    });

    it('two ticks within the same minute produce identical bodies', () => {
      const a = buildDirectiveBodyFromInput({
        turnsTotalSeen: 5,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:10.000Z',
        proposals: [],
        candidateCount: 0,
      });
      const b = buildDirectiveBodyFromInput({
        turnsTotalSeen: 5,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:25.000Z',
        proposals: [],
        candidateCount: 0,
      });
      expect(a.body).toBe(b.body);
    });
  });

  // ── collectAgentRoster ────────────────────────────────────

  describe('collectAgentRoster', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'agent-roster-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns sorted deduplicated agents', () => {
      for (const [name, agent] of [
        ['turn-001', 'main'],
        ['turn-002', 'commander'],
        ['turn-003', 'main'],
      ] as const) {
        const dir = join(tmpDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({ agent }));
      }
      const result = collectAgentRoster(tmpDir);
      expect(result).toEqual(['commander', 'main']);
    });

    it('skips .pending dirs', () => {
      const dir1 = join(tmpDir, 'turn-001');
      mkdirSync(dir1, { recursive: true });
      writeFileSync(join(dir1, 'meta.json'), JSON.stringify({ agent: 'main' }));

      const dir2 = join(tmpDir, 'turn-002.pending');
      mkdirSync(dir2, { recursive: true });
      writeFileSync(join(dir2, 'meta.json'), JSON.stringify({ agent: 'commander' }));

      expect(collectAgentRoster(tmpDir)).toEqual(['main']);
    });

    it('skips poison meta.json', () => {
      const dir1 = join(tmpDir, 'turn-001');
      mkdirSync(dir1, { recursive: true });
      writeFileSync(join(dir1, 'meta.json'), JSON.stringify({ agent: 'main' }));

      const dir2 = join(tmpDir, 'turn-002');
      mkdirSync(dir2, { recursive: true });
      writeFileSync(join(dir2, 'meta.json'), 'NOT JSON');

      expect(collectAgentRoster(tmpDir)).toEqual(['main']);
    });

    it('returns empty array for non-existent dir', () => {
      expect(collectAgentRoster('/nonexistent/path')).toEqual([]);
    });

    it('skips meta.json with empty agent', () => {
      const dir = join(tmpDir, 'turn-001');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ agent: '' }));
      expect(collectAgentRoster(tmpDir)).toEqual([]);
    });
  });

  // ── buildDirectiveBody (with filesystem) ──────────────────

  describe('buildDirectiveBody', () => {
    let tmpProject: string;

    beforeEach(() => {
      tmpProject = mkdtempSync(join(tmpdir(), 'directive-fs-'));
    });

    afterEach(() => {
      rmSync(tmpProject, { recursive: true, force: true });
    });

    it('reads agents from captures dir and writes rich body with proposals', () => {
      const capturesDir = join(tmpProject, '.claude-sop', 'captures');
      for (const [name, agent] of [
        ['turn-001', 'main'],
        ['turn-002', 'architect-principal-engineer'],
      ] as const) {
        const dir = join(capturesDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'meta.json'),
          JSON.stringify({ schema_version: 1, turn_id: name, agent }),
        );
      }

      const project: ProjectRegistryEntry = {
        project_id: 'test-proj',
        slug: 'test-project',
        project_root: tmpProject,
        installed_at: '2026-04-14T22:00:00Z',
        last_seen_at: '2026-04-14T22:00:00Z',
      };

      const result = buildDirectiveBody(
        project,
        '2026-04-14T22:20:00Z',
        47,
        [makeProposal()],
        0,
      );

      expect(result.body).toContain('47 turns analyzed');
      expect(result.body).toContain('architect-principal-engineer, main');
      expect(result.body).toContain('2 agents');
      expect(result.body).toContain('1 active directive');
    });
  });

  // ── Legacy shim (buildSampleDirective) ────────────────────

  describe('buildSampleDirective (legacy shim)', () => {
    let tmpProject: string;

    beforeEach(() => {
      tmpProject = mkdtempSync(join(tmpdir(), 'directive-legacy-'));
    });

    afterEach(() => {
      rmSync(tmpProject, { recursive: true, force: true });
    });

    it('legacy entry point still works and emits "No recurring patterns"', () => {
      const capturesDir = join(tmpProject, '.claude-sop', 'captures');
      mkdirSync(capturesDir, { recursive: true });
      const project: ProjectRegistryEntry = {
        project_id: 'test-proj',
        slug: 'test-project',
        project_root: tmpProject,
        installed_at: '2026-04-14T22:00:00Z',
        last_seen_at: '2026-04-14T22:00:00Z',
      };
      const result = buildSampleDirective(project, '2026-04-14T22:20:00Z', 0);
      expect(result.body).toContain('No recurring patterns detected yet.');
    });

    it('buildSampleDirectiveFromInput emits empty-state text', () => {
      const result = buildSampleDirectiveFromInput({
        turnsTotalSeen: 0,
        agentRoster: [],
        nowIso: '2026-04-14T22:20:00Z',
      });
      expect(result.body).toContain('No recurring patterns detected yet.');
    });
  });
});

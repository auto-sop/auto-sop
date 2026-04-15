import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSampleDirective,
  buildSampleDirectiveFromInput,
  collectAgentRoster,
  roundToMinute,
} from '../../src/learner/directive-builder.js';
import type { ProjectRegistryEntry } from '../../src/learner/project-registry.js';

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

  // ── buildSampleDirectiveFromInput (pure, no fs) ──────────

  describe('buildSampleDirectiveFromInput', () => {
    it('produces correct format with agents', () => {
      const result = buildSampleDirectiveFromInput({
        turnsTotalSeen: 47,
        agentRoster: ['architect-principal-engineer', 'commander', 'main'],
        nowIso: '2026-04-14T22:20:00Z',
      });

      expect(result.body).toContain('_Last updated: 2026-04-14T22:20:00Z');
      expect(result.body).toContain('47 turns analyzed');
      expect(result.body).toContain('3 agents: architect-principal-engineer, commander, main_');
      expect(result.body).toContain('**Learnings**');
      expect(result.body).toContain('_No directives generated yet');
    });

    it('singular "turn" for count of 1', () => {
      const result = buildSampleDirectiveFromInput({
        turnsTotalSeen: 1,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:00Z',
      });
      expect(result.body).toContain('1 turn analyzed');
      expect(result.body).toContain('1 agent: main_');
    });

    it('handles zero turns', () => {
      const result = buildSampleDirectiveFromInput({
        turnsTotalSeen: 0,
        agentRoster: [],
        nowIso: '2026-04-14T22:20:00Z',
      });
      expect(result.body).toContain('0 turns analyzed');
      expect(result.body).toContain('0 agents: none detected_');
    });

    it('is deterministic (same inputs → byte-identical output)', () => {
      const input = {
        turnsTotalSeen: 10,
        agentRoster: ['main', 'commander'],
        nowIso: '2026-04-14T22:20:00Z',
      };
      const a = buildSampleDirectiveFromInput(input);
      const b = buildSampleDirectiveFromInput(input);
      expect(a.body).toBe(b.body);
    });

    it('rounds timestamp to nearest minute', () => {
      const result = buildSampleDirectiveFromInput({
        turnsTotalSeen: 5,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:23:47.123Z',
      });
      // 47s >= 30 → rounds up to :24:00
      expect(result.body).toContain('2026-04-14T22:24:00Z');
    });

    it('two ticks within same minute produce identical body', () => {
      const a = buildSampleDirectiveFromInput({
        turnsTotalSeen: 5,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:10.000Z',
      });
      const b = buildSampleDirectiveFromInput({
        turnsTotalSeen: 5,
        agentRoster: ['main'],
        nowIso: '2026-04-14T22:20:25.000Z',
      });
      // Both round down to 22:20:00Z
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
      // Create 3 turn dirs with meta.json
      for (const [name, agent] of [
        ['turn-001', 'main'],
        ['turn-002', 'commander'],
        ['turn-003', 'main'], // duplicate
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

      const result = collectAgentRoster(tmpDir);
      expect(result).toEqual(['main']);
    });

    it('skips poison meta.json', () => {
      const dir1 = join(tmpDir, 'turn-001');
      mkdirSync(dir1, { recursive: true });
      writeFileSync(join(dir1, 'meta.json'), JSON.stringify({ agent: 'main' }));

      const dir2 = join(tmpDir, 'turn-002');
      mkdirSync(dir2, { recursive: true });
      writeFileSync(join(dir2, 'meta.json'), 'NOT JSON');

      const result = collectAgentRoster(tmpDir);
      expect(result).toEqual(['main']);
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

  // ── buildSampleDirective (with filesystem) ────────────────

  describe('buildSampleDirective', () => {
    let tmpProject: string;

    beforeEach(() => {
      tmpProject = mkdtempSync(join(tmpdir(), 'directive-fs-'));
    });

    afterEach(() => {
      rmSync(tmpProject, { recursive: true, force: true });
    });

    it('reads agents from captures dir and builds directive', () => {
      // Set up captures
      const capturesDir = join(tmpProject, '.claude-sop', 'captures');
      for (const [name, agent] of [
        ['turn-001', 'main'],
        ['turn-002', 'architect-principal-engineer'],
        ['turn-003', 'main'],
      ] as const) {
        const dir = join(capturesDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'meta.json'),
          JSON.stringify({
            schema_version: 1,
            turn_id: name,
            agent,
            finalized_at: '2026-04-14T22:00:00Z',
          }),
        );
      }

      const project: ProjectRegistryEntry = {
        project_id: 'test-proj',
        slug: 'test-project',
        project_root: tmpProject,
        installed_at: '2026-04-14T22:00:00Z',
        last_seen_at: '2026-04-14T22:00:00Z',
      };

      const result = buildSampleDirective(
        project,
        '2026-04-14T22:20:00Z',
        47,
      );

      expect(result.body).toContain('47 turns analyzed');
      expect(result.body).toContain('architect-principal-engineer, main');
      expect(result.body).toContain('2 agents');
    });
  });
});

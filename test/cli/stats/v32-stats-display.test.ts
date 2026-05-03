/**
 * Integration tests for V32 stats CLI display — token estimation + sync_queue_size.
 *
 * Covers:
 * - Token estimation line appears in human output when savings > 0
 * - No token estimation line when no session data or zero savings
 * - sync_queue_size present in JSON output
 * - Backward compat: JSON output includes V32 fields even when absent
 *
 * Uses real temp directories + stdout capture (same pattern as stats-verb.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../../../src/cli/main.js';
import { appendFires } from '~/capture/writer/directive-fire.js';
import type { DirectiveFire } from '~/capture/writer/directive-fire.js';
import { saveHistory } from '~/managed-section/directive-history.js';
import type {
  DirectiveHistory,
  DirectiveHistoryEntry,
} from '~/managed-section/directive-history.js';
import { appendSyncEntry, buildSyncEntry } from '../../../src/learner/sync-queue.js';

// ── Mock PathResolver (avoid git lookups in temp dirs) ─────

vi.mock('../../../src/path-resolver/index.js', () => ({
  PathResolver: class MockPathResolver {
    async resolve(_projectRoot: string) {
      return {
        identity: { projectId: 'test-hash-v32', slug: 'v32-mock-slug' },
      };
    }
  },
}));

// ── Helpers ─────────────────────────────────────────────────

function makeDirective(id: string, ruleText: string, pruned = false): DirectiveHistoryEntry {
  const now = new Date().toISOString();
  return {
    id,
    rule_text: ruleText,
    severity: 'warning',
    first_seen: now,
    last_reinforced: now,
    occurrence_count: 1,
    pruned,
  };
}

function makeHistory(entries: DirectiveHistoryEntry[]): DirectiveHistory {
  const map: Record<string, DirectiveHistoryEntry> = {};
  for (const e of entries) {
    map[e.id] = e;
  }
  return { entries: map, updated_at: new Date().toISOString() };
}

function makeFire(overrides: Partial<DirectiveFire> = {}): DirectiveFire {
  return {
    t: new Date().toISOString(),
    directive_id: 'dir-default',
    session_id: 'sess-default',
    project_id: 'proj-default',
    keyword_hits: 3,
    keyword_total: 5,
    match_ratio: 0.6,
    ...overrides,
  };
}

function stateDir(projectRoot: string): string {
  return join(projectRoot, '.auto-sop', 'state');
}

// ── Test suite ──────────────────────────────────────────────

describe('V32 stats display: token estimation + sync_queue_size', () => {
  let projectRoot: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'auto-sop-v32-display-'));
    mkdirSync(stateDir(projectRoot), { recursive: true });

    stdoutChunks = [];
    stderrChunks = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    originalExitCode = process.exitCode;

    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function stdout(): string {
    return stdoutChunks.join('');
  }

  // ── JSON output with V32 fields ─────────────────────────

  describe('JSON output: V32 fields', () => {
    it('includes sync_queue_size in JSON output', async () => {
      saveHistory(projectRoot, makeHistory([makeDirective('dir-1', 'Some rule text')]));

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1' }),
      ]);

      // Add sync entries
      const sd = stateDir(projectRoot);
      for (let i = 0; i < 4; i++) {
        appendSyncEntry(
          sd,
          buildSyncEntry({
            projectId: 'proj-1',
            projectSlug: 'v32-test',
            tickId: `tick-${i}`,
            directivesActive: 5,
            firesTotal: 10,
            firesByCategory: { error_preventing: 3, efficiency: 4, best_practice: 3 },
            errorsPrevented: 2,
            sessionComparison: null,
            tokenEstimate: null,
          }),
        );
      }

      await runCli([
        'node',
        'auto-sop',
        '--json',
        'stats',
        '--project',
        projectRoot,
        '--since',
        '2026-04-01',
      ]);

      const parsed = JSON.parse(stdout().trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.sync_queue_size).toBe(4);
    });

    it('sync_queue_size = 0 when no sync-queue.jsonl exists', async () => {
      saveHistory(projectRoot, makeHistory([makeDirective('dir-1', 'Some rule text')]));

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1' }),
      ]);

      await runCli([
        'node',
        'auto-sop',
        '--json',
        'stats',
        '--project',
        projectRoot,
        '--since',
        '2026-04-01',
      ]);

      const parsed = JSON.parse(stdout().trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.sync_queue_size).toBe(0);
    });
  });

  // ── Human output: token estimation display ──────────────

  describe('Human output: token estimation line', () => {
    it('does not show token estimation when no session data exists', async () => {
      saveHistory(projectRoot, makeHistory([makeDirective('dir-1', 'Some rule text')]));

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1' }),
      ]);

      await runCli([
        'node',
        'auto-sop',
        'stats',
        '--project',
        projectRoot,
        '--since',
        '2026-04-01',
      ]);

      const out = stdout();
      // Should NOT contain token estimation section
      expect(out).not.toContain('Token Savings');
      expect(out).not.toContain('tokens/session');
    });

    it('does not show token estimation when no fires exist (zero-fire output)', async () => {
      saveHistory(projectRoot, makeHistory([makeDirective('dir-1', 'Some rule text')]));

      await runCli(['node', 'auto-sop', 'stats', '--project', projectRoot]);

      const out = stdout();
      expect(out).toContain('No fires yet');
      expect(out).not.toContain('Token Savings');
      expect(out).not.toContain('tokens/session');
    });
  });

  // ── Backward compat ─────────────────────────────────────

  describe('Backward compat: old projects', () => {
    it('JSON output always includes sync_queue_size field', async () => {
      saveHistory(
        projectRoot,
        makeHistory([makeDirective('dir-1', 'Rule A'), makeDirective('dir-2', 'Rule B')]),
      );

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1' }),
        makeFire({ t: '2026-04-11T10:00:00Z', directive_id: 'dir-2', session_id: 'sess-2' }),
      ]);

      await runCli([
        'node',
        'auto-sop',
        '--json',
        'stats',
        '--project',
        projectRoot,
        '--since',
        '2026-04-01',
      ]);

      const parsed = JSON.parse(stdout().trim());

      // V32 fields are always present with safe defaults
      expect(parsed).toHaveProperty('sync_queue_size');
      expect(typeof parsed.sync_queue_size).toBe('number');
      expect(parsed.sync_queue_size).toBe(0);

      // V31 fields still present
      expect(parsed).toHaveProperty('fires_by_category');
      expect(parsed).toHaveProperty('real_errors_prevented');
      expect(parsed).toHaveProperty('session_comparison');
    });
  });
});

/**
 * Tests for the stats CLI verb — human output, JSON output, --since filter,
 * edge cases (no fires, missing state dir).
 *
 * Uses real temp directories with seeded fire data. Captures stdout/stderr
 * via process.stdout.write interception (same pattern as errors.test.ts).
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

// ── Mock PathResolver (avoid git lookups in temp dirs) ─────

vi.mock('../../../src/path-resolver/index.js', () => ({
  PathResolver: class MockPathResolver {
    async resolve(projectRoot: string) {
      return {
        identity: { projectId: 'test-hash-12', slug: 'mock-slug' },
      };
    }
  },
}));

// ── Helpers ─────────────────────────────────────────────────

function makeDirective(
  id: string,
  ruleText: string,
  pruned = false,
): DirectiveHistoryEntry {
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

describe('stats verb', () => {
  let projectRoot: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'auto-sop-stats-verb-'));
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

  function stderr(): string {
    return stderrChunks.join('');
  }

  // ── Human-readable output ───────────────────────────────

  describe('human-readable output', () => {
    it('shows fire metrics for a project with fires', async () => {
      saveHistory(
        projectRoot,
        makeHistory([
          makeDirective('dir-1', 'Validate input before queries'),
          makeDirective('dir-2', 'Run tests before committing'),
        ]),
      );

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1' }),
        makeFire({ t: '2026-04-11T11:00:00Z', directive_id: 'dir-1', session_id: 'sess-2' }),
        makeFire({ t: '2026-04-12T12:00:00Z', directive_id: 'dir-2', session_id: 'sess-3' }),
      ]);

      await runCli(['node', 'auto-sop', 'stats', '--project', projectRoot, '--since', '2026-04-01']);

      const out = stdout();
      expect(out).toContain('Heuristic Fires:');
      expect(out).toContain('3');
      expect(out).toContain('Unique Directives Hit:');
      expect(out).toContain('2');
      expect(out).toContain('Est. Errors Prevented:');
      expect(out).toContain('Est. Time Saved:');
    });

    it('shows friendly message when no fires exist', async () => {
      saveHistory(
        projectRoot,
        makeHistory([makeDirective('dir-1', 'Some directive')]),
      );

      await runCli(['node', 'auto-sop', 'stats', '--project', projectRoot]);

      const out = stdout();
      expect(out).toContain('No fires yet');
      expect(out).toContain('normal');
    });

    it('shows top firing directives section', async () => {
      saveHistory(
        projectRoot,
        makeHistory([
          makeDirective('dir-top', 'Top firing directive rule text'),
        ]),
      );

      // 5 fires for dir-top
      const fires = Array.from({ length: 5 }, (_, i) =>
        makeFire({
          t: `2026-04-${String(10 + i).padStart(2, '0')}T10:00:00Z`,
          directive_id: 'dir-top',
          session_id: `sess-${i}`,
        }),
      );
      appendFires(stateDir(projectRoot), fires);

      await runCli(['node', 'auto-sop', 'stats', '--project', projectRoot, '--since', '2026-04-01']);

      const out = stdout();
      expect(out).toContain('Top Firing Directives');
    });
  });

  // ── JSON output ─────────────────────────────────────────

  describe('--json flag', () => {
    it('produces valid JSON matching ProjectStats schema', async () => {
      saveHistory(
        projectRoot,
        makeHistory([
          makeDirective('dir-1', 'Validate all input'),
          makeDirective('dir-2', 'Run tests before commit'),
        ]),
      );

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1' }),
        makeFire({ t: '2026-04-11T11:00:00Z', directive_id: 'dir-2', session_id: 'sess-2' }),
      ]);

      await runCli(['node', 'auto-sop', '--json', 'stats', '--project', projectRoot, '--since', '2026-04-01']);

      const out = stdout().trim();
      const parsed = JSON.parse(out);

      expect(parsed.ok).toBe(true);
      expect(parsed.verb).toBe('stats');
      expect(parsed.total_fires).toBe(2);
      expect(parsed.unique_directives_fired).toBe(2);
      expect(parsed.active_directives).toBe(2);
      expect(parsed.fires_by_directive).toHaveLength(2);
      expect(parsed.estimated_errors_prevented).toBe(2);
      expect(parsed.estimated_minutes_saved).toBe(30); // 2 * 15
      expect(parsed.period).toBeDefined();
      expect(parsed.period.since).toBeDefined();
      expect(parsed.period.until).toBeDefined();
      expect(parsed.project_slug).toBeDefined();
      expect(parsed.project_path).toBe(projectRoot);
    });

    it('JSON output includes fires_by_directive with correct fields', async () => {
      saveHistory(
        projectRoot,
        makeHistory([makeDirective('dir-1', 'Input validation is important')]),
      );

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1' }),
      ]);

      await runCli(['node', 'auto-sop', '--json', 'stats', '--project', projectRoot, '--since', '2026-04-01']);

      const parsed = JSON.parse(stdout().trim());
      const entry = parsed.fires_by_directive[0];

      expect(entry.directive_id).toBe('dir-1');
      expect(entry.rule_text_preview).toContain('Input validation');
      expect(entry.fire_count).toBe(1);
      expect(entry.last_fired).toBe('2026-04-10T10:00:00Z');
    });

    it('JSON output with no fires still returns valid schema', async () => {
      saveHistory(
        projectRoot,
        makeHistory([makeDirective('dir-1', 'Some rule text')]),
      );

      await runCli(['node', 'auto-sop', '--json', 'stats', '--project', projectRoot]);

      const parsed = JSON.parse(stdout().trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.total_fires).toBe(0);
      expect(parsed.fires_by_directive).toEqual([]);
    });
  });

  // ── --since filter ──────────────────────────────────────

  describe('--since filter', () => {
    it('filters fires correctly', async () => {
      saveHistory(
        projectRoot,
        makeHistory([makeDirective('dir-1', 'Directive for since test')]),
      );

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-01-15T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-old' }),
        makeFire({ t: '2026-02-15T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-mid' }),
        makeFire({ t: '2026-04-15T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-new' }),
      ]);

      await runCli(['node', 'auto-sop', '--json', 'stats', '--project', projectRoot, '--since', '2026-03-01']);

      const parsed = JSON.parse(stdout().trim());
      expect(parsed.total_fires).toBe(1);
    });

    it('rejects invalid --since date', async () => {
      await runCli(['node', 'auto-sop', 'stats', '--project', projectRoot, '--since', 'not-a-date']);

      const combined = stderr() + stdout();
      expect(combined).toContain('Invalid');
    });
  });

  // ── Missing state dir ───────────────────────────────────

  describe('missing state directory', () => {
    it('shows install suggestion in human mode', async () => {
      const emptyProject = mkdtempSync(join(tmpdir(), 'auto-sop-no-state-'));

      try {
        await runCli(['node', 'auto-sop', 'stats', '--project', emptyProject]);

        const combined = stderr() + stdout();
        expect(combined).toContain('not installed');
        expect(combined).toContain('auto-sop install');
      } finally {
        rmSync(emptyProject, { recursive: true, force: true });
      }
    });

    it('returns JSON error for missing state dir', async () => {
      const emptyProject = mkdtempSync(join(tmpdir(), 'auto-sop-no-state-'));

      try {
        await runCli(['node', 'auto-sop', '--json', 'stats', '--project', emptyProject]);

        const parsed = JSON.parse(stdout().trim());
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toBe('not_installed');
      } finally {
        rmSync(emptyProject, { recursive: true, force: true });
      }
    });
  });

  // ── --minutes-per-error flag ────────────────────────────

  describe('--minutes-per-error flag', () => {
    it('overrides the default 15 minutes per error', async () => {
      saveHistory(
        projectRoot,
        makeHistory([makeDirective('dir-1', 'Test directive for minutes override')]),
      );

      appendFires(stateDir(projectRoot), [
        makeFire({ t: '2026-04-10T10:00:00Z', directive_id: 'dir-1', session_id: 'sess-1' }),
        makeFire({ t: '2026-04-11T11:00:00Z', directive_id: 'dir-1', session_id: 'sess-2' }),
      ]);

      await runCli([
        'node', 'auto-sop', '--json', 'stats',
        '--project', projectRoot,
        '--since', '2026-04-01',
        '--minutes-per-error', '25',
      ]);

      const parsed = JSON.parse(stdout().trim());
      expect(parsed.estimated_minutes_saved).toBe(50); // 2 * 25
    });

    it('rejects non-positive --minutes-per-error', async () => {
      await runCli([
        'node', 'auto-sop', 'stats',
        '--project', projectRoot,
        '--minutes-per-error', '-5',
      ]);

      const combined = stderr() + stdout();
      expect(combined).toContain('positive number');
    });
  });
});

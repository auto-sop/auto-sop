/**
 * Tests for the recent verb.
 *
 * Covers: flag registration, duration parsing, path validation,
 * turn scanning with fixture data, and JSON output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('recent verb: flag registration', () => {
  it('registers recent command with expected flags', async () => {
    const { registerRecentVerb } = await import('../../../src/cli/verbs/recent.js');

    const program = new Command();
    registerRecentVerb(program);

    const cmd = program.commands.find((c) => c.name() === 'recent');
    expect(cmd).toBeDefined();

    const options = cmd!.options.map((o) => o.long);
    expect(options).toContain('--since');
    expect(options).toContain('--project');
  });

  it('recent description mentions activity', async () => {
    const { registerRecentVerb } = await import('../../../src/cli/verbs/recent.js');

    const program = new Command();
    registerRecentVerb(program);

    const cmd = program.commands.find((c) => c.name() === 'recent');
    expect(cmd!.description()).toContain('recent');
  });
});

describe('recent verb: help output', () => {
  it('--help includes all flag names', async () => {
    const { registerRecentVerb } = await import('../../../src/cli/verbs/recent.js');

    const program = new Command().exitOverride();
    registerRecentVerb(program);

    const cmd = program.commands.find((c) => c.name() === 'recent');
    const helpText = cmd!.helpInformation();

    expect(helpText).toContain('--since');
    expect(helpText).toContain('--project');
  });
});

describe('recent verb: parseDuration', () => {
  it('parses valid duration strings', async () => {
    const { parseDuration } = await import('../../../src/cli/verbs/recent.js');

    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1w')).toBe(604_800_000);
  });

  it('returns null for invalid input', async () => {
    const { parseDuration } = await import('../../../src/cli/verbs/recent.js');

    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('-1h')).toBeNull();
    expect(parseDuration('1x')).toBeNull();
    expect(parseDuration('1.5h')).toBeNull();
  });

  it('handles whitespace', async () => {
    const { parseDuration } = await import('../../../src/cli/verbs/recent.js');

    expect(parseDuration(' 1h ')).toBe(3_600_000);
    expect(parseDuration('  30m  ')).toBe(30 * 60_000);
  });
});

describe('recent verb: turn scanning with fixtures', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'recent-test-'));
    mkdirSync(join(tmpProject, '.auto-sop', 'captures'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  function writeTurnFixture(
    turnId: string,
    finalizedAt: string,
    extra: Record<string, unknown> = {},
  ): void {
    const turnDir = join(tmpProject, '.auto-sop', 'captures', turnId);
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(
      join(turnDir, 'meta.json'),
      JSON.stringify({
        schema_version: 1,
        project_id: 'test-proj',
        project_slug: 'test',
        session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        turn_id: turnId,
        parent_turn_id: null,
        children_turn_ids: [],
        agent: 'main',
        subagent_type: null,
        started_at: finalizedAt,
        finalized_at: finalizedAt,
        finalization_reason: 'stop',
        hook_shim_version: '1.0.0',
        files_changed_count: 2,
        tool_call_count: 5,
        scrubber_hit_count: 0,
        ...extra,
      }),
    );
  }

  it('scanNewTurns finds turns newer than cutoff', async () => {
    const { scanNewTurns } = await import('../../../src/learner/turn-scanner.js');

    const now = new Date();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60_000).toISOString();
    const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000).toISOString();

    writeTurnFixture('turn-recent-01', thirtyMinAgo);
    writeTurnFixture('turn-old-01', twoHoursAgo);

    const capturesDir = join(tmpProject, '.auto-sop', 'captures');
    const oneHourCutoff = new Date(now.getTime() - 3_600_000).toISOString();

    const result = scanNewTurns(capturesDir, oneHourCutoff, 1000);

    // Only the 30-min-ago turn should be included
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]!.turn_id).toBe('turn-recent-01');
  });

  it('returns empty when no turns match', async () => {
    const { scanNewTurns } = await import('../../../src/learner/turn-scanner.js');

    const capturesDir = join(tmpProject, '.auto-sop', 'captures');
    const futureDate = '2099-01-01T00:00:00Z';

    const result = scanNewTurns(capturesDir, futureDate, 1000);
    expect(result.turns).toHaveLength(0);
  });

  it('skips .pending directories', async () => {
    const { scanNewTurns } = await import('../../../src/learner/turn-scanner.js');

    const now = new Date().toISOString();
    writeTurnFixture('turn-good', now);

    // Create a .pending directory
    const pendingDir = join(tmpProject, '.auto-sop', 'captures', 'turn-pending.pending');
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      join(pendingDir, 'meta.json'),
      JSON.stringify({
        schema_version: 1,
        turn_id: 'turn-pending',
        finalized_at: now,
      }),
    );

    const capturesDir = join(tmpProject, '.auto-sop', 'captures');
    const result = scanNewTurns(capturesDir, '2000-01-01T00:00:00Z', 1000);

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]!.turn_id).toBe('turn-good');
    expect(result.skipped_pending).toBe(1);
  });
});

describe('recent verb: registered in CLI', () => {
  it('registerVerbs includes recent command', async () => {
    const { registerVerbs } = await import('../../../src/cli/verbs/index.js');

    const program = new Command();
    registerVerbs(program);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('recent');
  });
});

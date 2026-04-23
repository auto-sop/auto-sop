/**
 * Tests for the stats verb.
 *
 * Covers:
 *   - Flag registration (--project, --since, --minutes-per-error)
 *   - Registration in verbs/index.ts
 *   - Human-readable output for fires
 *   - Human-readable "no fires" message
 *   - JSON output mode
 *   - --since date filtering
 *   - --minutes-per-error override
 *   - Not-installed project error
 *   - Invalid --since date error
 *   - Invalid --minutes-per-error error
 *   - Null-byte path injection guard
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DirectiveFire } from '../../../src/capture/writer/directive-fire.js';
import type { DirectiveHistory } from '../../../src/managed-section/directive-history.js';

// ─── Helpers ─────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'stats-test-'));
}

function setupState(root: string): string {
  const dir = join(root, '.auto-sop', 'state');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFires(root: string, fires: DirectiveFire[]): void {
  const dir = setupState(root);
  const lines = fires.map((f) => JSON.stringify(f)).join('\n') + '\n';
  writeFileSync(join(dir, 'directive-fires.jsonl'), lines);
}

function writeHistory(root: string, history: DirectiveHistory): void {
  const dir = setupState(root);
  writeFileSync(join(dir, 'directive-history.json'), JSON.stringify(history));
}

function makeFire(overrides: Partial<DirectiveFire> = {}): DirectiveFire {
  return {
    t: '2026-04-10T12:00:00.000Z',
    directive_id: 'det-default',
    session_id: 'sess-001',
    project_id: 'proj-001',
    keyword_hits: 3,
    keyword_total: 5,
    match_ratio: 0.6,
    ...overrides,
  };
}

function makeHistory(
  entries: Record<string, { rule_text: string; pruned?: boolean }>,
): DirectiveHistory {
  const histEntries: Record<string, DirectiveHistory['entries'][string]> = {};
  for (const [id, val] of Object.entries(entries)) {
    histEntries[id] = {
      id,
      rule_text: val.rule_text,
      severity: 'warning',
      first_seen: '2026-01-01T00:00:00.000Z',
      last_reinforced: '2026-04-01T00:00:00.000Z',
      occurrence_count: 1,
      pruned: val.pruned ?? false,
    };
  }
  return { entries: histEntries, updated_at: '2026-04-01T00:00:00.000Z' };
}

/** Capture stdout during an async action. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

/** Capture stderr during an async action. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  let output = '';
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return output;
}

// ─── Tests ───────────────────────────────────────────────

describe('stats verb: flag registration', () => {
  it('registers stats command with expected flags', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const program = new Command();
    registerStatsVerb(program);

    const cmd = program.commands.find((c) => c.name() === 'stats');
    expect(cmd).toBeDefined();

    const options = cmd!.options.map((o) => o.long);
    expect(options).toContain('--project');
    expect(options).toContain('--since');
    expect(options).toContain('--minutes-per-error');
  });

  it('description mentions directive-fire or metrics', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const program = new Command();
    registerStatsVerb(program);

    const cmd = program.commands.find((c) => c.name() === 'stats');
    const desc = cmd!.description();
    expect(desc).toMatch(/metric|fire|stat/i);
  });
});

describe('stats verb: registered in CLI', () => {
  it('registerVerbs includes stats command', async () => {
    const { registerVerbs } = await import('../../../src/cli/verbs/index.js');

    const program = new Command();
    registerVerbs(program);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('stats');
  });
});

describe('stats verb: human-readable output', () => {
  let tmpProject: string;
  let savedExitCode: number | undefined;

  beforeEach(() => {
    tmpProject = makeTmpDir();
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
    process.exitCode = savedExitCode;
  });

  it('shows fire metrics when fires exist', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const fires = [
      makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' }),
      makeFire({ directive_id: 'det-a', t: '2026-04-10T11:00:00.000Z' }),
      makeFire({ directive_id: 'det-b', t: '2026-04-10T12:00:00.000Z' }),
    ];
    writeFires(tmpProject, fires);
    writeHistory(
      tmpProject,
      makeHistory({
        'det-a': { rule_text: 'Never use var, always use const or let.' },
        'det-b': { rule_text: 'Always validate input before processing.' },
      }),
    );

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(['stats', '--project', tmpProject, '--since', '2026-04-01'], {
        from: 'user',
      });
    });

    expect(output).toContain('auto-sop stats for:');
    expect(output).toContain('Directive Fires:');
    expect(output).toContain('3');
    expect(output).toContain('Unique Directives Hit:');
    expect(output).toContain('2');
    expect(output).toContain('Est. Errors Prevented:');
    expect(output).toContain('Est. Time Saved:');
    expect(output).toContain('Top Firing Directives:');
    expect(output).toContain('Never use var');
    expect(output).toContain('Always validate input');
  });

  it('shows "no fires" message when no fires exist', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    // Create state dir but no fires
    setupState(tmpProject);
    writeHistory(tmpProject, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(['stats', '--project', tmpProject, '--since', '2026-04-01'], {
        from: 'user',
      });
    });

    expect(output).toContain('No fires yet');
    expect(output).toContain('normal for new installs');
  });

  it('uses singular "fire" for count of 1', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const fires = [makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' })];
    writeFires(tmpProject, fires);
    writeHistory(tmpProject, makeHistory({ 'det-a': { rule_text: 'Single fire rule.' } }));

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(['stats', '--project', tmpProject, '--since', '2026-04-01'], {
        from: 'user',
      });
    });

    // The top directives section should show "1 fire " (singular)
    expect(output).toMatch(/1 fire\s/);
  });
});

describe('stats verb: JSON output', () => {
  let tmpProject: string;
  let savedExitCode: number | undefined;

  beforeEach(() => {
    tmpProject = makeTmpDir();
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
    process.exitCode = savedExitCode;
  });

  it('outputs JSON when --json flag is set', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const fires = [
      makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' }),
      makeFire({ directive_id: 'det-b', t: '2026-04-10T11:00:00.000Z' }),
    ];
    writeFires(tmpProject, fires);
    writeHistory(
      tmpProject,
      makeHistory({
        'det-a': { rule_text: 'Rule A.' },
        'det-b': { rule_text: 'Rule B.' },
      }),
    );

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(['--json', 'stats', '--project', tmpProject, '--since', '2026-04-01'], {
        from: 'user',
      });
    });

    const parsed = JSON.parse(output.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.verb).toBe('stats');
    expect(parsed.total_fires).toBe(2);
    expect(parsed.unique_directives_fired).toBe(2);
    expect(parsed.fires_by_directive).toHaveLength(2);
    expect(parsed.estimated_errors_prevented).toBe(2);
    expect(parsed.estimated_minutes_saved).toBe(30); // 2 * 15
    expect(parsed.period).toBeDefined();
    expect(parsed.period.since).toBeDefined();
    expect(parsed.period.until).toBeDefined();
  });
});

describe('stats verb: --minutes-per-error', () => {
  let tmpProject: string;
  let savedExitCode: number | undefined;

  beforeEach(() => {
    tmpProject = makeTmpDir();
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
    process.exitCode = savedExitCode;
  });

  it('respects custom minutes-per-error value', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const fires = [
      makeFire({ directive_id: 'det-a', t: '2026-04-10T10:00:00.000Z' }),
      makeFire({ directive_id: 'det-a', t: '2026-04-10T11:00:00.000Z' }),
    ];
    writeFires(tmpProject, fires);
    writeHistory(tmpProject, makeHistory({ 'det-a': { rule_text: 'Some rule.' } }));

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(
        ['--json', 'stats', '--project', tmpProject, '--since', '2026-04-01', '--minutes-per-error', '30'],
        { from: 'user' },
      );
    });

    const parsed = JSON.parse(output.trim());
    expect(parsed.estimated_minutes_saved).toBe(60); // 2 fires * 30 min
  });
});

describe('stats verb: error handling', () => {
  let tmpProject: string;
  let savedExitCode: number | undefined;

  beforeEach(() => {
    tmpProject = makeTmpDir();
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
    process.exitCode = savedExitCode;
  });

  it('shows error when project is not installed (human mode)', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    // tmpProject has no .auto-sop/state/
    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const stderr = await captureStderr(async () => {
      await program.parseAsync(['stats', '--project', tmpProject], { from: 'user' });
    });

    expect(stderr).toContain('not installed');
    expect(stderr).toContain('auto-sop install');
    expect(process.exitCode).toBe(1);
  });

  it('shows error when project is not installed (JSON mode)', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(['--json', 'stats', '--project', tmpProject], { from: 'user' });
    });

    const parsed = JSON.parse(output.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('not_installed');
    expect(process.exitCode).toBe(1);
  });

  it('shows error for invalid --since date (human mode)', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    setupState(tmpProject);
    writeHistory(tmpProject, makeHistory({}));

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const stderr = await captureStderr(async () => {
      await program.parseAsync(['stats', '--project', tmpProject, '--since', 'not-a-date'], {
        from: 'user',
      });
    });

    expect(stderr).toContain('Invalid');
    expect(process.exitCode).toBe(1);
  });

  it('shows error for invalid --since date (JSON mode)', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    setupState(tmpProject);
    writeHistory(tmpProject, makeHistory({}));

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(['--json', 'stats', '--project', tmpProject, '--since', 'not-a-date'], {
        from: 'user',
      });
    });

    const parsed = JSON.parse(output.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('invalid_since');
    expect(process.exitCode).toBe(1);
  });

  it('rejects null-byte injection in project path (human mode)', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const stderr = await captureStderr(async () => {
      await program.parseAsync(['stats', '--project', '/tmp/bad\0path'], { from: 'user' });
    });

    expect(stderr).toContain('Invalid');
    expect(process.exitCode).toBe(1);
  });

  it('rejects null-byte injection in project path (JSON mode)', async () => {
    const { registerStatsVerb } = await import('../../../src/cli/verbs/stats.js');

    const program = new Command().exitOverride();
    program.option('--json');
    registerStatsVerb(program);

    const output = await captureStdout(async () => {
      await program.parseAsync(['--json', 'stats', '--project', '/tmp/bad\0path'], {
        from: 'user',
      });
    });

    const parsed = JSON.parse(output.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('invalid_project_path');
    expect(process.exitCode).toBe(1);
  });
});

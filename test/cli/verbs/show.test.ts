/**
 * Tests for the show verb.
 *
 * Covers: flag registration, id classification, turn display (all modes),
 * session display, invalid inputs, missing turns, path traversal rejection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── classifyId unit tests ─────────────────────────────────

describe('show verb: classifyId', () => {
  it('classifies nanoid-like strings as turn', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');

    expect(classifyId('wx2vjpM3b0Pl')).toBe('turn');
    expect(classifyId('abc123def456')).toBe('turn');
    expect(classifyId('A_B-C')).toBe('turn');
    expect(classifyId('a')).toBe('turn');
  });

  it('classifies UUIDs as session', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');

    expect(classifyId('a7914106-8d5d-4a95-bfcb-6dc9f3d83821')).toBe('session');
    expect(classifyId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe('session');
  });

  it('rejects path traversal attempts', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');

    expect(classifyId('../../../etc/passwd')).toBeNull();
    expect(classifyId('turn../bad')).toBeNull();
    expect(classifyId('turn/bad')).toBeNull();
    expect(classifyId('turn\\bad')).toBeNull();
    expect(classifyId('turn\0bad')).toBeNull();
    expect(classifyId('a.b')).toBeNull();
  });

  it('rejects empty string', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');
    expect(classifyId('')).toBeNull();
  });

  it('rejects overly long input', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');
    const longId = 'a'.repeat(129);
    expect(classifyId(longId)).toBeNull();
  });

  it('accepts max-length turn id (128 chars)', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');
    const maxId = 'a'.repeat(128);
    expect(classifyId(maxId)).toBe('turn');
  });
});

// ── Flag registration ─────────────────────────────────────

describe('show verb: flag registration', () => {
  it('registers show command with expected flags', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    const program = new Command();
    registerShowVerb(program);

    const cmd = program.commands.find((c) => c.name() === 'show');
    expect(cmd).toBeDefined();

    const options = cmd!.options.map((o) => o.long);
    expect(options).toContain('--raw');
    expect(options).toContain('--files');
    expect(options).toContain('--tools');
    expect(options).toContain('--project');
  });

  it('show description mentions turn or session', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    const program = new Command();
    registerShowVerb(program);

    const cmd = program.commands.find((c) => c.name() === 'show');
    expect(cmd!.description()).toMatch(/turn|session/i);
  });
});

// ── Help output ───────────────────────────────────────────

describe('show verb: help output', () => {
  it('--help includes all flag names', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    const program = new Command().exitOverride();
    registerShowVerb(program);

    const cmd = program.commands.find((c) => c.name() === 'show');
    const helpText = cmd!.helpInformation();

    expect(helpText).toContain('--raw');
    expect(helpText).toContain('--files');
    expect(helpText).toContain('--tools');
    expect(helpText).toContain('--project');
  });
});

// ── Registered in CLI ─────────────────────────────────────

describe('show verb: registered in CLI', () => {
  it('registerVerbs includes show command', async () => {
    const { registerVerbs } = await import('../../../src/cli/verbs/index.js');

    const program = new Command();
    registerVerbs(program);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('show');
  });
});

// ── Turn display with fixtures ────────────────────────────

describe('show verb: turn display with fixtures', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'show-test-'));
    mkdirSync(join(tmpProject, '.auto-sop', 'captures'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  function writeTurnFixture(
    turnId: string,
    opts: {
      sessionId?: string;
      agent?: string;
      subagentType?: string | null;
      startedAt?: string;
      finalizedAt?: string;
      toolCallCount?: number;
      filesChangedCount?: number;
      prompt?: string;
      response?: string;
      toolCallsJsonl?: string;
      filesChanged?: string;
    } = {},
  ): string {
    const dirName = `20260414T190000-${opts.agent ?? 'main'}-abc123-${turnId}`;
    const turnDir = join(tmpProject, '.auto-sop', 'captures', dirName);
    mkdirSync(turnDir, { recursive: true });

    const finalizedAt = opts.finalizedAt ?? '2026-04-14T19:15:52.147Z';

    writeFileSync(
      join(turnDir, 'meta.json'),
      JSON.stringify({
        schema_version: 1,
        project_id: 'test-proj-01',
        project_slug: 'test',
        session_id: opts.sessionId ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        turn_id: turnId,
        parent_turn_id: null,
        children_turn_ids: [],
        agent: opts.agent ?? 'main',
        subagent_type: opts.subagentType ?? null,
        started_at: opts.startedAt ?? '2026-04-14T19:15:50.332Z',
        finalized_at: finalizedAt,
        finalization_reason: 'stop',
        hook_shim_version: '1.0.0',
        files_changed_count: opts.filesChangedCount ?? 0,
        tool_call_count: opts.toolCallCount ?? 0,
        scrubber_hit_count: 0,
      }),
    );

    if (opts.prompt) {
      writeFileSync(join(turnDir, 'prompt.md'), opts.prompt);
    }
    if (opts.response) {
      writeFileSync(join(turnDir, 'response.md'), opts.response);
    }
    if (opts.toolCallsJsonl) {
      writeFileSync(join(turnDir, 'tool-calls.jsonl'), opts.toolCallsJsonl);
    }
    if (opts.filesChanged) {
      writeFileSync(join(turnDir, 'files-changed.txt'), opts.filesChanged);
    }

    return turnDir;
  }

  it('shows full turn in human mode', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    writeTurnFixture('testTurn01', {
      prompt: 'Hello, Claude!',
      response: 'Hi there!',
      toolCallCount: 1,
      filesChangedCount: 1,
      filesChanged: 'src/index.ts\n',
      toolCallsJsonl:
        '{"event":"pre","tool_use_id":"tu_1","tool":"Bash","input":{"command":"ls"},"t":"2026-04-14T19:15:50.500Z"}\n' +
        '{"event":"post","tool_use_id":"tu_1","output":{"result":"ok"},"duration_ms":150,"success":true,"t":"2026-04-14T19:15:50.650Z"}\n',
    });

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync(['node', 'test', 'show', 'testTurn01', '--project', tmpProject]);

      const output = chunks.join('');
      expect(output).toContain('testTurn01');
      expect(output).toContain('PROMPT');
      expect(output).toContain('Hello, Claude!');
      expect(output).toContain('RESPONSE');
      expect(output).toContain('Hi there!');
      expect(output).toContain('TOOL CALLS');
      expect(output).toContain('Bash');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('shows turn in --raw mode', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    writeTurnFixture('rawTurn01', {
      prompt: 'raw prompt',
      response: 'raw response',
    });

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync([
        'node',
        'test',
        'show',
        'rawTurn01',
        '--raw',
        '--project',
        tmpProject,
      ]);

      const output = chunks.join('');
      expect(output).toContain('=== meta.json ===');
      expect(output).toContain('=== prompt.md ===');
      expect(output).toContain('raw prompt');
      expect(output).toContain('=== response.md ===');
      expect(output).toContain('raw response');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('shows turn in --files mode', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    writeTurnFixture('filesTurn01', {
      filesChanged: 'src/new-file.ts\nsrc/modified.ts\n',
    });

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync([
        'node',
        'test',
        'show',
        'filesTurn01',
        '--files',
        '--project',
        tmpProject,
      ]);

      const output = chunks.join('');
      expect(output).toContain('Files changed:');
      expect(output).toContain('src/new-file.ts');
      expect(output).toContain('src/modified.ts');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('shows turn in --tools mode', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    writeTurnFixture('toolsTurn01', {
      toolCallCount: 2,
      toolCallsJsonl:
        '{"event":"pre","tool_use_id":"tu_1","tool":"Bash","input":{"command":"ls"},"t":"2026-04-14T19:15:50.500Z"}\n' +
        '{"event":"post","tool_use_id":"tu_1","output":{"result":"ok"},"duration_ms":100,"success":true,"t":"2026-04-14T19:15:50.600Z"}\n' +
        '{"event":"pre","tool_use_id":"tu_2","tool":"Bash","input":{"command":"pwd"},"t":"2026-04-14T19:15:51.000Z"}\n' +
        '{"event":"post","tool_use_id":"tu_2","output":{"result":"/home"},"duration_ms":50,"success":true,"t":"2026-04-14T19:15:51.050Z"}\n',
    });

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync([
        'node',
        'test',
        'show',
        'toolsTurn01',
        '--tools',
        '--project',
        tmpProject,
      ]);

      const output = chunks.join('');
      expect(output).toContain('Tool calls: 2');
      expect(output).toContain('Bash');
      expect(output).toContain('2x');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('shows turn in --json mode', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    writeTurnFixture('jsonTurn01', {
      prompt: 'json prompt',
      response: 'json response',
      toolCallCount: 1,
      toolCallsJsonl:
        '{"event":"pre","tool_use_id":"tu_1","tool":"Edit","input":{"file":"a.ts"},"t":"2026-04-14T19:15:50.500Z"}\n' +
        '{"event":"post","tool_use_id":"tu_1","output":{"ok":true},"duration_ms":200,"success":true,"t":"2026-04-14T19:15:50.700Z"}\n',
    });

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().option('--json', 'json mode');
      registerShowVerb(program);

      await program.parseAsync([
        'node',
        'test',
        '--json',
        'show',
        'jsonTurn01',
        '--project',
        tmpProject,
      ]);

      const output = chunks.join('');
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(true);
      expect(parsed.verb).toBe('show');
      expect(parsed.mode).toBe('turn');
      expect(parsed.turn_id).toBe('jsonTurn01');
      expect(parsed.prompt).toBe('json prompt');
      expect(parsed.response).toBe('json response');
      expect(parsed.tool_calls).toHaveLength(1);
      expect(parsed.tool_calls[0].name).toBe('Edit');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('shows session in compact mode', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    const sessionId = 'a7914106-8d5d-4a95-bfcb-6dc9f3d83821';
    writeTurnFixture('sessTurn01', {
      sessionId,
      agent: 'commander',
      finalizedAt: '2026-04-14T19:15:52.147Z',
    });
    writeTurnFixture('sessTurn02', {
      sessionId,
      agent: 'architect',
      finalizedAt: '2026-04-14T19:16:00.000Z',
    });

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync(['node', 'test', 'show', sessionId, '--project', tmpProject]);

      const output = chunks.join('');
      expect(output).toContain(sessionId);
      expect(output).toContain('2 turn(s)');
      expect(output).toContain('sessTurn01');
      expect(output).toContain('sessTurn02');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('errors on turn not found', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    const origExitCode = process.exitCode;
    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync(['node', 'test', 'show', 'nonexistent01', '--project', tmpProject]);

      const output = chunks.join('');
      expect(output).toContain('turn not found');
      expect(process.exitCode).toBe(1);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = origExitCode;
    }
  });

  it('shows (no files changed) when files-changed.txt missing', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    writeTurnFixture('nofiles01');

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync([
        'node',
        'test',
        'show',
        'nofiles01',
        '--files',
        '--project',
        tmpProject,
      ]);

      const output = chunks.join('');
      expect(output).toContain('no files changed');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('shows (no tool calls) when tool-calls.jsonl missing', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    writeTurnFixture('notools01');

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync([
        'node',
        'test',
        'show',
        'notools01',
        '--tools',
        '--project',
        tmpProject,
      ]);

      const output = chunks.join('');
      expect(output).toContain('no tool calls');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

// ── Path traversal & invalid input ────────────────────────

describe('show verb: security — path traversal rejection', () => {
  it('rejects .. in turn id', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    const chunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    const origExitCode = process.exitCode;
    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync(['node', 'test', 'show', '..%2f..%2fetc']);

      const output = chunks.join('');
      expect(output).toContain('invalid id');
      expect(process.exitCode).toBe(2);
    } finally {
      process.stderr.write = origWrite;
      process.exitCode = origExitCode;
    }
  });

  it('rejects slash in turn id', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');
    expect(classifyId('../../etc/passwd')).toBeNull();
    expect(classifyId('/etc/passwd')).toBeNull();
  });

  it('rejects backslash in turn id', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');
    expect(classifyId('..\\..\\etc')).toBeNull();
  });

  it('rejects null byte in turn id', async () => {
    const { classifyId } = await import('../../../src/cli/verbs/show.js');
    expect(classifyId('turn\x00bad')).toBeNull();
  });
});

// ── No captures directory ─────────────────────────────────

describe('show verb: no captures directory', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'show-nocap-'));
    // Create project dir but NOT .auto-sop/captures
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('gracefully handles missing captures dir', async () => {
    const { registerShowVerb } = await import('../../../src/cli/verbs/show.js');

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      const program = new Command().exitOverride();
      registerShowVerb(program);

      await program.parseAsync(['node', 'test', 'show', 'someTurnId', '--project', tmpProject]);

      const output = chunks.join('');
      expect(output).toContain('no captures directory');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

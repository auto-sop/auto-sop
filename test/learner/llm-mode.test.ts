/**
 * Unit tests for src/learner/llm-mode.ts (PLAN-v14 Wave 2).
 *
 * Mocking strategy:
 *   - vi.mock('execa') intercepts the child-process spawn so no real
 *     `claude` binary is invoked. Each test sets the per-call return
 *     shape via mockResolvedValue / mockResolvedValueOnce.
 *   - vi.mock('node:child_process') intercepts the synchronous `which`
 *     lookup so we can drive the "claude not on PATH" branch
 *     deterministically without mutating the real PATH env var.
 *
 * Acceptance points covered:
 *   1. valid JSON response → proposals parsed correctly
 *   2. timeout → error 'timeout', proposals empty
 *   3. invalid JSON → error 'json_parse_failed'
 *   4. partial valid (2 good, 1 bad) → 2 accepted, 1 rejected
 *   5. claude missing → error 'claude_not_found'
 *   6. options.offline=true → returns immediately, no execa, no spawn
 *   7. injection resistance — rule_text > 500 chars rejected by schema
 *
 * Plus three extra guardrails:
 *   - non-zero exit → error 'claude_exit_<n>'
 *   - markdown-fenced JSON → still parsed (resilience to LLM ignoring
 *     the "no fences" instruction)
 *   - recursion guard — CLAUDE_SOP_LEARNER=1 is forwarded in env
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

// vi.mock calls are hoisted above all imports.
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { execa } from 'execa';
import { spawnSync } from 'node:child_process';
import { runLlmAnalysis } from '../../src/learner/llm-mode.js';
import type { TurnData } from '../../src/learner/turn-loader.js';

const mockedExeca = vi.mocked(execa);
const mockedSpawnSync = vi.mocked(spawnSync);

// ── Fixture helpers ────────────────────────────────────────

function fakeTurns(n: number): TurnData[] {
  return Array.from({ length: n }, (_, i) => ({
    turn_id: `t-${i}`,
    session_id: `s-${i % 3}`,
    agent: 'main',
    finalized_at: `2026-04-14T10:0${i}:00Z`,
    tool_calls: [],
  }));
}

/**
 * Build a minimal `SpawnSyncReturns<string>` value so the mocked
 * `which` call type-checks without `any` casts.
 */
function whichReturn(found: boolean): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, found ? '/usr/local/bin/claude\n' : '', ''],
    stdout: found ? '/usr/local/bin/claude\n' : '',
    stderr: '',
    status: found ? 0 : 1,
    signal: null,
  };
}

type ExecaReturn = Awaited<ReturnType<typeof execa>>;

/**
 * Build a minimal execa Result. We only set the fields llm-mode
 * actually inspects (stdout, exitCode, failed, timedOut) and cast
 * once via `unknown` so the rest of the (very wide) execa type
 * does not need to be filled in by hand for every test.
 */
function execaReturn(opts: {
  stdout?: string;
  exitCode?: number | undefined;
  failed?: boolean;
  timedOut?: boolean;
}): ExecaReturn {
  return {
    stdout: opts.stdout ?? '',
    stderr: '',
    exitCode: opts.exitCode,
    failed: opts.failed ?? false,
    timedOut: opts.timedOut ?? false,
  } as unknown as ExecaReturn;
}

function validDirective(idSuffix: string): unknown {
  return {
    id: `det-${idSuffix}`,
    detector: 'llm',
    severity: 'warning',
    rule_text:
      'Always run `npm install` before `npm test` after pulling fresh dependencies.',
    evidence: {
      session_ids: ['sess-aaa', 'sess-bbb', 'sess-ccc'],
      turn_ids: ['t-1', 't-2', 't-3'],
      pattern: 'tests fail because node_modules is stale',
      occurrence_count: 4,
      first_seen: '2026-04-14T10:00:00Z',
    },
    created_at: '2026-04-15T12:00:00Z',
  };
}

/** Fails the schema because rule_text is below the 10-char minimum. */
function badDirectiveTooShort(): unknown {
  return {
    id: 'det-bad',
    detector: 'llm',
    severity: 'warning',
    rule_text: 'short',
    evidence: {
      session_ids: ['sess-aaa', 'sess-bbb', 'sess-ccc'],
      turn_ids: ['t-1'],
      pattern: 'p',
      occurrence_count: 3,
      first_seen: '2026-04-14T10:00:00Z',
    },
    created_at: '2026-04-15T12:00:00Z',
  };
}

/**
 * Wrap a payload in the claude CLI `--output-format json` shape.
 * The real CLI emits `{ "result": "<assistant text>", ... }` where
 * the inner text is itself a JSON-encoded string — exactly two
 * JSON.parse passes to recover the directive payload.
 */
function wrapClaude(payload: unknown): string {
  const inner =
    typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.stringify({
    type: 'result',
    result: inner,
    model: 'claude-test',
    total_cost_usd: 0,
  });
}

// ── Test suite ────────────────────────────────────────────

beforeEach(() => {
  // Reset both mock state AND mock implementations between tests.
  vi.resetAllMocks();
  // Default: `claude` is on PATH. Tests that need the absent case
  // override with mockReturnValueOnce.
  mockedSpawnSync.mockReturnValue(whichReturn(true));
});

describe('runLlmAnalysis', () => {
  it('options.offline=true → returns immediately with no spawn', async () => {
    const result = await runLlmAnalysis(fakeTurns(5), 'proj', 3, {
      offline: true,
    });

    expect(result.proposals).toEqual([]);
    expect(result.summary).toBe('');
    expect(result.turnsAnalyzed).toBe(0);
    expect(result.patternsBelowThreshold).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.error).toBeNull();

    // Critical: NO subprocess spawned in offline mode.
    expect(mockedExeca).not.toHaveBeenCalled();
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('claude not on PATH → graceful empty result with claude_not_found', async () => {
    mockedSpawnSync.mockReturnValue(whichReturn(false));

    const result = await runLlmAnalysis(fakeTurns(5), 'proj', 3);

    expect(result.proposals).toEqual([]);
    expect(result.error).toBe('claude_not_found');
    // Must short-circuit BEFORE spawning execa.
    expect(mockedExeca).not.toHaveBeenCalled();
  });

  it('valid JSON response → proposals parsed correctly', async () => {
    const inner = {
      directives: [validDirective('alpha'), validDirective('beta')],
      summary: 'Two recurring failure modes detected.',
      turns_analyzed: 5,
      patterns_below_threshold: 1,
    };
    mockedExeca.mockResolvedValue(execaReturn({ stdout: wrapClaude(inner) }));

    const result = await runLlmAnalysis(fakeTurns(5), 'proj', 3);

    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]?.id).toBe('det-alpha');
    expect(result.proposals[1]?.id).toBe('det-beta');
    expect(result.summary).toBe('Two recurring failure modes detected.');
    expect(result.turnsAnalyzed).toBe(5);
    expect(result.patternsBelowThreshold).toBe(1);
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it('passes CLAUDE_SOP_LEARNER=1 in spawned env (recursion guard)', async () => {
    mockedExeca.mockResolvedValue(
      execaReturn({
        stdout: wrapClaude({
          directives: [],
          summary: '',
          turns_analyzed: 0,
          patterns_below_threshold: 0,
        }),
      }),
    );

    await runLlmAnalysis(fakeTurns(2), 'proj', 1);

    expect(mockedExeca).toHaveBeenCalledTimes(1);
    const call = mockedExeca.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).toBe('claude');
    const args = call?.[1] as string[];
    expect(args).toEqual(['-p', '--output-format', 'json', '--max-turns', '1']);
    const opts = call?.[2] as { env?: Record<string, string>; reject?: boolean };
    expect(opts?.env?.CLAUDE_SOP_LEARNER).toBe('1');
    expect(opts?.reject).toBe(false);
  });

  it('timeout → error field set to "timeout", proposals empty', async () => {
    mockedExeca.mockResolvedValue(
      execaReturn({ failed: true, timedOut: true, exitCode: undefined }),
    );

    const result = await runLlmAnalysis(fakeTurns(5), 'proj', 3);

    expect(result.error).toBe('timeout');
    expect(result.proposals).toEqual([]);
  });

  it('non-zero exit → error reflects the exit code', async () => {
    mockedExeca.mockResolvedValue(
      execaReturn({ failed: true, exitCode: 2, stdout: '' }),
    );

    const result = await runLlmAnalysis(fakeTurns(5), 'proj', 3);
    expect(result.error).toBe('claude_exit_2');
    expect(result.proposals).toEqual([]);
  });

  it('invalid JSON response → error field set to "json_parse_failed"', async () => {
    mockedExeca.mockResolvedValue(
      execaReturn({ stdout: 'this is plain text, not JSON at all' }),
    );

    const result = await runLlmAnalysis(fakeTurns(5), 'proj', 3);
    expect(result.error).toBe('json_parse_failed');
    expect(result.proposals).toEqual([]);
  });

  it('inner JSON malformed (wrapper OK) → error "json_parse_failed"', async () => {
    // Outer wrapper parses fine but the inner `result` string is junk.
    const stdout = JSON.stringify({
      type: 'result',
      result: '{ this is not valid JSON',
      model: 'm',
    });
    mockedExeca.mockResolvedValue(execaReturn({ stdout }));

    const result = await runLlmAnalysis(fakeTurns(2), 'proj', 1);
    expect(result.error).toBe('json_parse_failed');
    expect(result.proposals).toEqual([]);
  });

  it('partial valid (2 good, 1 bad) → 2 accepted, 1 rejected', async () => {
    const inner = {
      directives: [
        validDirective('one'),
        badDirectiveTooShort(),
        validDirective('two'),
      ],
      summary: '',
      turns_analyzed: 3,
      patterns_below_threshold: 0,
    };
    mockedExeca.mockResolvedValue(execaReturn({ stdout: wrapClaude(inner) }));

    const result = await runLlmAnalysis(fakeTurns(3), 'proj', 3);

    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.map((p) => p.id)).toEqual(['det-one', 'det-two']);
  });

  it('injection resistance — rule_text > 500 chars rejected by schema', async () => {
    // Single oversize directive. Schema rejects it; result has 0
    // proposals but error is null (schema rejection is silent).
    const oversize = {
      ...(validDirective('huge') as Record<string, unknown>),
      rule_text: 'X'.repeat(501),
    };
    const inner = {
      directives: [oversize],
      summary: 'attempted injection',
      turns_analyzed: 1,
      patterns_below_threshold: 0,
    };
    mockedExeca.mockResolvedValue(execaReturn({ stdout: wrapClaude(inner) }));

    const result = await runLlmAnalysis(fakeTurns(1), 'proj', 1);
    expect(result.proposals).toEqual([]);
    expect(result.error).toBeNull();
    // Metadata still flows through even when all proposals are rejected.
    expect(result.summary).toBe('attempted injection');
  });

  it('handles markdown-fenced JSON gracefully', async () => {
    const inner = {
      directives: [validDirective('fenced')],
      summary: '',
      turns_analyzed: 1,
      patterns_below_threshold: 0,
    };
    const fenced = '```json\n' + JSON.stringify(inner) + '\n```';
    mockedExeca.mockResolvedValue(execaReturn({ stdout: wrapClaude(fenced) }));

    const result = await runLlmAnalysis(fakeTurns(1), 'proj', 1);
    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.id).toBe('det-fenced');
  });

  it('SEC-003: LLM proposals missing detector/created_at → defaults injected, proposal accepted', async () => {
    // Real `claude -p` responses often omit the `detector` and `created_at`
    // fields because the prompt only optionally mentions them. Before the
    // SEC-003 fix, these proposals silently failed safeParse and were dropped.
    const proposalNoMeta = {
      id: 'det-nometa',
      // intentionally no `detector` and no `created_at`
      severity: 'warning',
      rule_text:
        'Always run `npm install` before `npm test` after pulling fresh dependencies.',
      evidence: {
        session_ids: ['sess-aaa', 'sess-bbb', 'sess-ccc'],
        turn_ids: ['t-1', 't-2', 't-3'],
        pattern: 'tests fail because node_modules is stale',
        occurrence_count: 4,
        first_seen: '2026-04-14T10:00:00Z',
      },
    };
    const inner = {
      directives: [proposalNoMeta],
      summary: 'one missing-meta proposal',
      turns_analyzed: 3,
      patterns_below_threshold: 0,
    };
    mockedExeca.mockResolvedValue(execaReturn({ stdout: wrapClaude(inner) }));

    const result = await runLlmAnalysis(fakeTurns(3), 'proj', 3);

    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0]!;
    expect(p.id).toBe('det-nometa');
    // Defaults got injected:
    expect(p.detector).toBe('llm');
    expect(typeof p.created_at).toBe('string');
    expect(p.created_at.length).toBeGreaterThan(0);
    // Sanity check: created_at parses as a valid ISO timestamp.
    expect(Number.isNaN(Date.parse(p.created_at))).toBe(false);
  });

  it('SEC-003: LLM-provided detector/created_at values take precedence over defaults', async () => {
    // If the LLM does provide the fields, we must NOT clobber them.
    const proposalWithMeta = {
      id: 'det-withmeta',
      detector: 'llm-custom-detector',
      severity: 'warning',
      rule_text:
        'Always run `npm install` before `npm test` after pulling fresh dependencies.',
      evidence: {
        session_ids: ['sess-aaa', 'sess-bbb', 'sess-ccc'],
        turn_ids: ['t-1', 't-2', 't-3'],
        pattern: 'tests fail because node_modules is stale',
        occurrence_count: 4,
        first_seen: '2026-04-14T10:00:00Z',
      },
      created_at: '2026-04-15T12:00:00Z',
    };
    const inner = {
      directives: [proposalWithMeta],
      summary: '',
      turns_analyzed: 3,
      patterns_below_threshold: 0,
    };
    mockedExeca.mockResolvedValue(execaReturn({ stdout: wrapClaude(inner) }));

    const result = await runLlmAnalysis(fakeTurns(3), 'proj', 3);

    expect(result.error).toBeNull();
    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0]!;
    expect(p.detector).toBe('llm-custom-detector');
    expect(p.created_at).toBe('2026-04-15T12:00:00Z');
  });

  it('durationMs is populated even when the call errors out', async () => {
    mockedExeca.mockResolvedValue(
      execaReturn({ failed: true, exitCode: 1 }),
    );

    const result = await runLlmAnalysis(fakeTurns(2), 'proj', 1);
    // Time elapsed at least 0ms — the field MUST be a number, not undefined.
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBe('claude_exit_1');
  });
});

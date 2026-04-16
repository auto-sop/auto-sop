/**
 * Unit tests for src/learner/llm-serializer.ts
 *
 * Covers the five acceptance points from PLAN-v14 Wave 1, plus a
 * handful of guardrail tests around the injection-resistance
 * envelope and empty-input behavior:
 *
 *   1. 5 turns → all 5 turn headers appear in output
 *   2. 40 turns → only 30 selected, failures prioritized over
 *      non-failures, recency breaks ties within a group
 *   3. 10KB prompt.md → truncated to 500 chars + "..." marker
 *   4. Envelope always wraps output in
 *      <capture untrusted="true">...</capture>
 *   5. 30 large turns → total output stays under 100K chars
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  serializeTurnsForLlm,
  type SerializationOptions,
} from '../../src/learner/llm-serializer.js';
import type { TurnData, ToolCall } from '../../src/learner/turn-loader.js';

// ── Fixture helpers ──────────────────────────────────────────

function makeTurn(
  turnId: string,
  sessionId: string,
  finalizedAt: string,
  toolCalls: ToolCall[] = [],
  turnDir?: string,
): TurnData & { turn_dir?: string } {
  const t: TurnData & { turn_dir?: string } = {
    turn_id: turnId,
    session_id: sessionId,
    agent: 'main',
    finalized_at: finalizedAt,
    tool_calls: toolCalls,
  };
  if (turnDir !== undefined) t.turn_dir = turnDir;
  return t;
}

function bashPair(tuid: string, command: string, success: boolean): ToolCall[] {
  return [
    {
      event: 'pre',
      tool_use_id: tuid,
      tool: 'Bash',
      input: { command },
      t: '2026-04-14T10:00:00Z',
    },
    {
      event: 'post',
      tool_use_id: tuid,
      tool: 'Bash',
      output: { __untrusted: true, exitCode: success ? 0 : 1 },
      success,
      t: '2026-04-14T10:00:01Z',
    },
  ];
}

// ── Tests ────────────────────────────────────────────────────

describe('llm-serializer', () => {
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'llm-serializer-'));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it('5 fake turns → serialized output contains all 5 turn headers', () => {
    const turns = Array.from({ length: 5 }, (_, i) =>
      makeTurn(`turn-${i}`, `sess-${i}`, `2026-04-14T1${i}:00:00Z`),
    );

    const out = serializeTurnsForLlm(turns, 'demo-project');

    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`Turn turn-${i}`);
      expect(out).toContain(`Session: sess-${i}`);
    }
  });

  it('40 turns → only 30 selected, with failure-priority + recency order', () => {
    // 40 total: turns 0–9 are failures (older), turns 10–39 are
    // successes (newer). Priority: all 10 failures first, then
    // 20 most-recent successes (turns 39..20).
    const turns: TurnData[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push(
        makeTurn(
          `fail-${i}`,
          `sess-fail-${i}`,
          `2026-04-14T00:${String(i).padStart(2, '0')}:00Z`,
          bashPair(`tu-fail-${i}`, 'npm test', false),
        ),
      );
    }
    for (let i = 0; i < 30; i++) {
      turns.push(
        makeTurn(
          `ok-${i}`,
          `sess-ok-${i}`,
          `2026-04-14T12:${String(i).padStart(2, '0')}:00Z`,
          bashPair(`tu-ok-${i}`, 'echo hi', true),
        ),
      );
    }

    const out = serializeTurnsForLlm(turns, 'demo');

    // All 10 failures must be present.
    for (let i = 0; i < 10; i++) {
      expect(out).toContain(`Turn fail-${i}`);
    }
    // Newest 20 successes (ok-29..ok-10) must be present; ok-0..ok-9
    // are the oldest successes and should be dropped.
    for (let i = 29; i >= 10; i--) {
      expect(out).toContain(`Turn ok-${i}`);
    }
    for (let i = 0; i < 10; i++) {
      expect(out).not.toContain(`Turn ok-${i} `);
    }
  });

  it('turn with 10KB prompt.md → truncated to 500 chars + "..." marker', () => {
    const turnDir = join(sandboxDir, 'big-prompt');
    mkdirSync(turnDir, { recursive: true });
    const hugePrompt = 'A'.repeat(10_000);
    writeFileSync(join(turnDir, 'prompt.md'), hugePrompt);

    const turn = makeTurn('turn-1', 'sess-1', '2026-04-14T10:00:00Z', [], turnDir);
    const out = serializeTurnsForLlm([turn], 'demo', { maxPromptChars: 500 });

    // Must contain exactly 500 As followed by "..." in the PROMPT
    // slot — the trailing 9,500 As must NOT appear.
    expect(out).toContain('PROMPT: ' + 'A'.repeat(500) + '...');
    expect(out).not.toContain('A'.repeat(501));
  });

  it('output is wrapped in <capture untrusted="true"> tags', () => {
    const turns = [makeTurn('t-1', 's-1', '2026-04-14T10:00:00Z')];
    const out = serializeTurnsForLlm(turns, 'demo');

    expect(out).toMatch(/^<capture untrusted="true"[^>]*>/);
    expect(out.trimEnd().endsWith('</capture>')).toBe(true);

    // Header/footer are both present even when the turn list is empty.
    const emptyOut = serializeTurnsForLlm([], 'demo');
    expect(emptyOut).toMatch(/^<capture untrusted="true"/);
    expect(emptyOut.trimEnd().endsWith('</capture>')).toBe(true);
  });

  it('30 large turns → total output stays under 100K chars', () => {
    // Each turn backed by a 10KB prompt + 10KB response on disk.
    // Without a hard cap, rendering 30 such turns would approach
    // 600KB; the serializer must auto-shrink the set.
    const turns: TurnData[] = [];
    for (let i = 0; i < 30; i++) {
      const turnDir = join(sandboxDir, `big-${i}`);
      mkdirSync(turnDir, { recursive: true });
      writeFileSync(join(turnDir, 'prompt.md'), 'P'.repeat(10_000));
      writeFileSync(join(turnDir, 'response.md'), 'R'.repeat(10_000));
      turns.push(
        makeTurn(
          `big-${i}`,
          `sess-${i}`,
          `2026-04-14T${String(i % 24).padStart(2, '0')}:00:00Z`,
          [],
          turnDir,
        ),
      );
    }

    // Configure generous per-field caps so the total-size cap is
    // what actually kicks in.
    const opts: Partial<SerializationOptions> = {
      maxTurns: 30,
      maxPromptChars: 10_000,
      maxResponseChars: 10_000,
    };
    const out = serializeTurnsForLlm(turns, 'demo', opts);

    expect(out.length).toBeLessThanOrEqual(100_000);
    // Envelope still valid after shrinking.
    expect(out).toMatch(/^<capture untrusted="true"/);
    expect(out.trimEnd().endsWith('</capture>')).toBe(true);
  });

  it('tool call summary renders tool name, status, and truncated input', () => {
    const longCommand = 'echo ' + 'X'.repeat(500);
    const turn = makeTurn('t-1', 's-1', '2026-04-14T10:00:00Z', [
      ...bashPair('tu-1', longCommand, false),
    ]);
    const out = serializeTurnsForLlm([turn], 'demo', { maxToolInputChars: 50 });

    // Tool name + fail status must appear.
    expect(out).toContain('Bash[fail]');
    // Input must be truncated to 50 chars + "...".
    expect(out).not.toContain('X'.repeat(100));
    expect(out).toContain('...');
  });

  it('missing disk files → "[not available]" placeholder, no throw', () => {
    const turnDir = join(sandboxDir, 'no-files');
    mkdirSync(turnDir, { recursive: true });
    // intentionally write nothing

    const turn = makeTurn('t-1', 's-1', '2026-04-14T10:00:00Z', [], turnDir);
    const out = serializeTurnsForLlm([turn], 'demo');

    expect(out).toContain('PROMPT: [not available]');
    expect(out).toContain('RESPONSE: [not available]');
    expect(out).toContain('FILES CHANGED: [not available]');
  });
});

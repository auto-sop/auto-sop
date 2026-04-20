/**
 * Unit tests for src/learner/turn-loader.ts
 *
 * Covers:
 * - Happy path: finalized turns load in ascending order
 * - Missing tool-calls.jsonl → empty tool_calls array, turn still loaded
 * - Malformed NDJSON line → line skipped, sibling lines still parsed
 * - .pending directories are skipped
 * - maxTurns bound truncates to most recent
 * - output fields carry the __untrusted: true marker
 * - Missing/malformed meta.json → entire turn skipped
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTurnsForDetection } from '../../src/learner/turn-loader.js';

describe('turn-loader', () => {
  let capturesDir: string;

  beforeEach(() => {
    capturesDir = mkdtempSync(join(tmpdir(), 'turn-loader-'));
  });

  afterEach(() => {
    rmSync(capturesDir, { recursive: true, force: true });
  });

  function seedTurn(
    dirName: string,
    meta: Record<string, unknown> | string | null,
    ndjsonLines: string[] | null,
  ): string {
    const dir = join(capturesDir, dirName);
    mkdirSync(dir, { recursive: true });
    if (meta !== null) {
      const serialized = typeof meta === 'string' ? meta : JSON.stringify(meta);
      writeFileSync(join(dir, 'meta.json'), serialized);
    }
    if (ndjsonLines !== null) {
      writeFileSync(join(dir, 'tool-calls.jsonl'), ndjsonLines.join('\n'));
    }
    return dir;
  }

  function validMeta(turnId: string, finalizedAt: string, extras?: Record<string, unknown>) {
    return {
      schema_version: 1,
      project_id: 'p',
      project_slug: 'p',
      session_id: 'sess-1',
      turn_id: turnId,
      parent_turn_id: null,
      children_turn_ids: [],
      agent: 'main',
      subagent_type: null,
      started_at: finalizedAt,
      finalized_at: finalizedAt,
      finalization_reason: 'stop',
      hook_shim_version: '0.0.0',
      files_changed_count: 0,
      tool_call_count: 0,
      scrubber_hit_count: 0,
      ...(extras ?? {}),
    };
  }

  it('returns empty array when captures dir does not exist', () => {
    const nonexistent = join(capturesDir, '_nope');
    const result = loadTurnsForDetection(nonexistent);
    expect(result).toEqual([]);
  });

  it('returns 3 TurnData objects sorted ascending by finalized_at', () => {
    seedTurn('turn-b', validMeta('turn-b', '2026-04-14T11:00:00.000Z'), []);
    seedTurn('turn-a', validMeta('turn-a', '2026-04-14T10:00:00.000Z'), []);
    seedTurn('turn-c', validMeta('turn-c', '2026-04-14T12:00:00.000Z'), []);

    const result = loadTurnsForDetection(capturesDir);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.turn_id)).toEqual(['turn-a', 'turn-b', 'turn-c']);
  });

  it('turn missing tool-calls.jsonl → returned with empty tool_calls', () => {
    seedTurn(
      'turn-1',
      validMeta('turn-1', '2026-04-14T10:00:00.000Z'),
      null, // no tool-calls.jsonl
    );

    const result = loadTurnsForDetection(capturesDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.tool_calls).toEqual([]);
  });

  it('turn with malformed NDJSON line → bad line skipped, other lines parsed', () => {
    const pre = JSON.stringify({
      event: 'pre',
      tool_use_id: 'tu-1',
      tool: 'Bash',
      input: { command: 'ls' },
      t: '2026-04-14T10:00:00.000Z',
    });
    const garbage = '{"this is not valid json';
    const post = JSON.stringify({
      event: 'post',
      tool_use_id: 'tu-1',
      output: { exitCode: 0 },
      success: true,
      t: '2026-04-14T10:00:01.000Z',
    });

    seedTurn('turn-1', validMeta('turn-1', '2026-04-14T10:00:00.000Z'), [pre, garbage, post]);

    const result = loadTurnsForDetection(capturesDir);
    expect(result).toHaveLength(1);
    // 2 valid events survived (pre + post), 1 malformed line skipped
    expect(result[0]!.tool_calls).toHaveLength(2);
    expect(result[0]!.tool_calls[0]!.event).toBe('pre');
    expect(result[0]!.tool_calls[1]!.event).toBe('post');
  });

  it('.pending directories are skipped', () => {
    seedTurn('turn-final', validMeta('turn-final', '2026-04-14T10:00:00.000Z'), []);
    seedTurn('turn-pending.pending', validMeta('turn-pending', '2026-04-14T11:00:00.000Z'), []);

    const result = loadTurnsForDetection(capturesDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.turn_id).toBe('turn-final');
  });

  it('maxTurns=2 with 5 turns → returns 2 most-recent in ascending order', () => {
    for (let i = 0; i < 5; i++) {
      seedTurn(`turn-${i}`, validMeta(`turn-${i}`, `2026-04-14T1${i}:00:00.000Z`), []);
    }
    const result = loadTurnsForDetection(capturesDir, 2);
    expect(result).toHaveLength(2);
    // The two most-recent are turn-3 (13:00) and turn-4 (14:00), sorted ascending
    expect(result[0]!.turn_id).toBe('turn-3');
    expect(result[1]!.turn_id).toBe('turn-4');
  });

  it('output fields have __untrusted: true marker', () => {
    const pre = JSON.stringify({
      event: 'pre',
      tool_use_id: 'tu-1',
      tool: 'Bash',
      input: { command: 'echo hi' },
      t: '2026-04-14T10:00:00.000Z',
    });
    const post = JSON.stringify({
      event: 'post',
      tool_use_id: 'tu-1',
      output: { exitCode: 0, stdout: 'hi\n' },
      success: true,
      t: '2026-04-14T10:00:01.000Z',
    });

    seedTurn('turn-1', validMeta('turn-1', '2026-04-14T10:00:00.000Z'), [pre, post]);

    const result = loadTurnsForDetection(capturesDir);
    const postCall = result[0]!.tool_calls.find((c) => c.event === 'post');
    expect(postCall).toBeDefined();
    expect(postCall!.output).toBeDefined();
    expect(postCall!.output!.__untrusted).toBe(true);
    // original fields preserved
    expect(postCall!.output!.exitCode).toBe(0);
    expect(postCall!.output!.stdout).toBe('hi\n');
  });

  it('missing meta.json skips entire turn', () => {
    seedTurn('turn-bad', null, []);
    seedTurn('turn-good', validMeta('turn-good', '2026-04-14T10:00:00.000Z'), []);

    const result = loadTurnsForDetection(capturesDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.turn_id).toBe('turn-good');
  });

  it('malformed meta.json skips entire turn', () => {
    seedTurn('turn-bad', 'NOT VALID JSON', []);
    seedTurn('turn-good', validMeta('turn-good', '2026-04-14T10:00:00.000Z'), []);

    const result = loadTurnsForDetection(capturesDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.turn_id).toBe('turn-good');
  });

  it('meta.json missing required fields → turn skipped', () => {
    seedTurn(
      'turn-missing',
      { schema_version: 1, agent: 'main' }, // no turn_id/session_id/finalized_at
      [],
    );
    seedTurn('turn-ok', validMeta('turn-ok', '2026-04-14T10:00:00.000Z'), []);

    const result = loadTurnsForDetection(capturesDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.turn_id).toBe('turn-ok');
  });

  it('post event tool name is back-filled from matching pre event', () => {
    const pre = JSON.stringify({
      event: 'pre',
      tool_use_id: 'tu-1',
      tool: 'Edit',
      input: { file_path: '/tmp/a.ts' },
      t: '2026-04-14T10:00:00.000Z',
    });
    const post = JSON.stringify({
      event: 'post',
      tool_use_id: 'tu-1',
      // note: no `tool` field — loader must back-fill
      success: false,
      t: '2026-04-14T10:00:01.000Z',
    });

    seedTurn('turn-1', validMeta('turn-1', '2026-04-14T10:00:00.000Z'), [pre, post]);

    const result = loadTurnsForDetection(capturesDir);
    const postCall = result[0]!.tool_calls.find((c) => c.event === 'post');
    expect(postCall!.tool).toBe('Edit');
  });

  it('empty lines in tool-calls.jsonl are skipped without error', () => {
    const pre = JSON.stringify({
      event: 'pre',
      tool_use_id: 'tu-1',
      tool: 'Bash',
      input: { command: 'ls' },
      t: '2026-04-14T10:00:00.000Z',
    });

    seedTurn('turn-1', validMeta('turn-1', '2026-04-14T10:00:00.000Z'), ['', pre, '', '']);

    const result = loadTurnsForDetection(capturesDir);
    expect(result[0]!.tool_calls).toHaveLength(1);
    expect(result[0]!.tool_calls[0]!.event).toBe('pre');
  });
});

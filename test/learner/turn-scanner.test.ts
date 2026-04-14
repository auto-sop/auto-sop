import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanNewTurns } from '../../src/learner/turn-scanner.js';

describe('turn-scanner', () => {
  let tmpDir: string;
  let capturesDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scanner-test-'));
    capturesDir = join(tmpDir, 'captures');
    mkdirSync(capturesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTurn(turnId: string, finalizedAt: string | null, opts?: { poison?: boolean; pending?: boolean }) {
    const suffix = opts?.pending ? '.pending' : '';
    const dirName = `20260414T120000-main-abc-${turnId}${suffix}`;
    const turnDir = join(capturesDir, dirName);
    mkdirSync(turnDir, { recursive: true });
    if (opts?.poison) {
      writeFileSync(join(turnDir, 'meta.json'), 'INVALID');
    } else {
      writeFileSync(join(turnDir, 'meta.json'), JSON.stringify({
        schema_version: 1,
        project_id: 'test123',
        project_slug: 'test',
        session_id: 'sess-1',
        turn_id: turnId,
        parent_turn_id: null,
        children_turn_ids: [],
        agent: 'main',
        subagent_type: null,
        started_at: '2026-04-14T12:00:00.000Z',
        finalized_at: finalizedAt,
        finalization_reason: finalizedAt ? 'stop' : null,
        hook_shim_version: '0.0.0',
        files_changed_count: 1,
        tool_call_count: 2,
        scrubber_hit_count: 0,
      }));
    }
  }

  it('returns empty for nonexistent captures dir', () => {
    const result = scanNewTurns('/tmp/nonexistent-dir-12345', '');
    expect(result.turns).toEqual([]);
    expect(result.skipped_pending).toBe(0);
    expect(result.skipped_poison).toBe(0);
  });

  it('scans finalized turns sorted ascending', () => {
    createTurn('t1', '2026-04-14T10:00:00.000Z');
    createTurn('t2', '2026-04-14T12:00:00.000Z');
    createTurn('t3', '2026-04-14T11:00:00.000Z');
    const result = scanNewTurns(capturesDir, '');
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0]!.turn_id).toBe('t1');
    expect(result.turns[1]!.turn_id).toBe('t3');
    expect(result.turns[2]!.turn_id).toBe('t2');
  });

  it('filters by cursor (last_finalized_at)', () => {
    createTurn('t1', '2026-04-14T10:00:00.000Z');
    createTurn('t2', '2026-04-14T12:00:00.000Z');
    const result = scanNewTurns(capturesDir, '2026-04-14T10:00:00.000Z');
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]!.turn_id).toBe('t2');
  });

  it('skips .pending dirs', () => {
    createTurn('t1', '2026-04-14T10:00:00.000Z');
    createTurn('t2', '2026-04-14T11:00:00.000Z', { pending: true });
    const result = scanNewTurns(capturesDir, '');
    expect(result.turns).toHaveLength(1);
    expect(result.skipped_pending).toBe(1);
  });

  it('counts poison meta.json as skipped_poison', () => {
    createTurn('t1', '2026-04-14T10:00:00.000Z');
    createTurn('t-bad', '', { poison: true });
    const result = scanNewTurns(capturesDir, '');
    expect(result.turns).toHaveLength(1);
    expect(result.skipped_poison).toBe(1);
  });

  it('respects maxTurns bound', () => {
    for (let i = 0; i < 10; i++) {
      createTurn(`t${i}`, `2026-04-14T${String(10 + i).padStart(2, '0')}:00:00.000Z`);
    }
    const result = scanNewTurns(capturesDir, '', 3);
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0]!.turn_id).toBe('t0');
  });

  it('skips non-finalized turns', () => {
    createTurn('t1', '2026-04-14T10:00:00.000Z');
    createTurn('t2', null);
    const result = scanNewTurns(capturesDir, '');
    expect(result.turns).toHaveLength(1);
  });
});

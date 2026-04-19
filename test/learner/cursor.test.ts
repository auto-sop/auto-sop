import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCursor, writeCursor, withCursorLock } from '../../src/learner/cursor.js';

describe('cursor', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cursor-test-'));
    stateDir = join(tmpDir, '.auto-sop', 'state');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readCursor returns defaults when no file exists', () => {
    const cursor = readCursor(stateDir);
    expect(cursor.last_finalized_at).toBe('');
    expect(cursor.total_turns_seen).toBe(0);
    expect(cursor.last_tick_id).toBe('');
  });

  it('writeCursor persists and readCursor reads back', () => {
    const cursor = {
      last_finalized_at: '2026-04-14T10:00:00.000Z',
      total_turns_seen: 42,
      last_tick_id: 'ck-10h00',
      updated_at: '2026-04-14T10:00:00.000Z',
    };
    writeCursor(stateDir, cursor);
    const read = readCursor(stateDir);
    expect(read.last_finalized_at).toBe('2026-04-14T10:00:00.000Z');
    expect(read.total_turns_seen).toBe(42);
    expect(read.last_tick_id).toBe('ck-10h00');
  });

  it('withCursorLock runs fn and returns result', () => {
    const result = withCursorLock(stateDir, () => {
      const cursor = readCursor(stateDir);
      writeCursor(stateDir, { ...cursor, total_turns_seen: 7, updated_at: new Date().toISOString() });
      return 'done';
    });
    expect(result).toBe('done');
    const cursor = readCursor(stateDir);
    expect(cursor.total_turns_seen).toBe(7);
  });

  it('withCursorLock returns null on lock contention', async () => {
    const { lockSync, unlockSync } = await import('proper-lockfile');
    const cursorFile = join(stateDir, 'learner-cursor.json');
    const lockPath = join(stateDir, 'learner-cursor.lock');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cursorFile, '{}');

    // Hold the lock
    lockSync(cursorFile, { lockfilePath: lockPath, stale: 30000 });

    // Try to acquire — should return null
    const result = withCursorLock(stateDir, () => 'should not run');
    expect(result).toBeNull();

    // Release
    unlockSync(cursorFile, { lockfilePath: lockPath });
  });
});

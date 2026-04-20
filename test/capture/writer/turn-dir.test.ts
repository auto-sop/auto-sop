import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, statSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  createPendingTurnDir,
  finalizeTurnDir,
  resolveCurrentTurn,
  setCurrentTurn,
  clearCurrentTurn,
  compactIso,
  generateTurnId,
} from '~/capture/writer/turn-dir.js';
import { startMeta, writeMeta, readMeta, finalizeMeta, updateMeta } from '~/capture/writer/meta.js';
import type { HookPayloadType } from '~/capture/events.js';
import { isWindows } from '../../setup/platform.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('turn-dir', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  describe('compactIso', () => {
    it('formats a date as YYYYMMDDTHHmmss UTC', () => {
      const d = new Date('2026-01-15T09:05:30Z');
      expect(compactIso(d)).toBe('20260115T090530');
    });
  });

  describe('generateTurnId', () => {
    it('returns a 12-char string', () => {
      const id = generateTurnId();
      expect(id).toHaveLength(12);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateTurnId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('createPendingTurnDir', () => {
    it('creates a directory with .pending suffix and mode 0700', () => {
      const capturesDir = join(tmpBase, 'captures');
      mkdirSync(capturesDir, { recursive: true });

      const dir = createPendingTurnDir({
        capturesDir,
        ts: '20260115T090530',
        agent: 'main',
        filehash: 'pending',
        turnId: 'abc123def456',
      });

      expect(dir).toContain('.pending');
      expect(existsSync(dir)).toBe(true);

      const stat = statSync(dir);
      expect(stat.isDirectory()).toBe(true);
      // Check 0700 perms (on macOS/Linux)
      if (!isWindows) {
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o700);
      }
    });

    it('names the dir as ts-agent-filehash-turnId.pending', () => {
      const capturesDir = join(tmpBase, 'captures');
      mkdirSync(capturesDir, { recursive: true });

      const dir = createPendingTurnDir({
        capturesDir,
        ts: '20260115T090530',
        agent: 'main',
        filehash: 'pending',
        turnId: 'abc123def456',
      });

      expect(dir).toBe(join(capturesDir, '20260115T090530-main-pending-abc123def456.pending'));
    });
  });

  describe('finalizeTurnDir', () => {
    it('renames directory by dropping .pending suffix', () => {
      const capturesDir = join(tmpBase, 'captures');
      mkdirSync(capturesDir, { recursive: true });

      const pendingDir = createPendingTurnDir({
        capturesDir,
        ts: '20260115T090530',
        agent: 'main',
        filehash: 'pending',
        turnId: 'abc123def456',
      });

      // Put a file inside to verify content survives
      writeFileSync(join(pendingDir, 'test.txt'), 'hello');

      const finalDir = finalizeTurnDir(pendingDir);

      expect(finalDir).not.toContain('.pending');
      expect(existsSync(pendingDir)).toBe(false);
      expect(existsSync(finalDir)).toBe(true);
      expect(readFileSync(join(finalDir, 'test.txt'), 'utf8')).toBe('hello');
    });
  });

  describe('session state (resolveCurrentTurn / setCurrentTurn / clearCurrentTurn)', () => {
    it('returns null when no marker exists', () => {
      const stateDir = join(tmpBase, 'state');
      mkdirSync(stateDir, { recursive: true });
      const result = resolveCurrentTurn(stateDir, 'session-1');
      expect(result).toBeNull();
    });

    it('roundtrips set + resolve for a session', () => {
      const stateDir = join(tmpBase, 'state');
      const state = { turnDir: '/tmp/some-dir.pending', turnId: 'abc123' };

      setCurrentTurn(stateDir, 'session-1', state);
      const result = resolveCurrentTurn(stateDir, 'session-1');
      expect(result).toEqual(state);
    });

    it('handles concurrent sessions independently', () => {
      const stateDir = join(tmpBase, 'state');
      const stateA = { turnDir: '/tmp/dir-a.pending', turnId: 'aaa' };
      const stateB = { turnDir: '/tmp/dir-b.pending', turnId: 'bbb' };

      setCurrentTurn(stateDir, 'session-A', stateA);
      setCurrentTurn(stateDir, 'session-B', stateB);

      expect(resolveCurrentTurn(stateDir, 'session-A')).toEqual(stateA);
      expect(resolveCurrentTurn(stateDir, 'session-B')).toEqual(stateB);
    });

    it('clearCurrentTurn removes the marker', () => {
      const stateDir = join(tmpBase, 'state');
      setCurrentTurn(stateDir, 'session-1', {
        turnDir: '/tmp/x',
        turnId: 'x',
      });
      clearCurrentTurn(stateDir, 'session-1');
      expect(resolveCurrentTurn(stateDir, 'session-1')).toBeNull();
    });

    it('clearCurrentTurn on non-existent marker does not throw', () => {
      const stateDir = join(tmpBase, 'state');
      mkdirSync(stateDir, { recursive: true });
      expect(() => clearCurrentTurn(stateDir, 'ghost')).not.toThrow();
    });

    it('setCurrentTurn writes via temp+rename (atomic)', () => {
      const stateDir = join(tmpBase, 'state');
      const state = { turnDir: '/tmp/d', turnId: 'x' };
      setCurrentTurn(stateDir, 's1', state);

      // After write, no .tmp file should remain
      const files = readdirSync(stateDir);
      expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(files).toContain('current-turn-s1.json');
    });

    it('setCurrentTurn writes marker with mode 0600', () => {
      const stateDir = join(tmpBase, 'state');
      setCurrentTurn(stateDir, 'test-session', { turnDir: '/a', turnId: 'b' });
      const markerPath = join(stateDir, 'current-turn-test-session.json');
      const stat = statSync(markerPath);
      if (!isWindows) {
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });
});

describe('meta', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  const fakePayload: HookPayloadType = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-123',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    prompt: 'hello world',
  };

  describe('startMeta', () => {
    it('creates a valid TurnMeta with all required fields', () => {
      const meta = startMeta(fakePayload, {
        projectId: 'proj123456ab',
        projectSlug: 'my-project',
        turnId: 'turn12345678',
        agent: 'main',
        subagentType: null,
        hookShimVersion: '0.1.0',
      });

      expect(meta.schema_version).toBe(1);
      expect(meta.project_id).toBe('proj123456ab');
      expect(meta.project_slug).toBe('my-project');
      expect(meta.session_id).toBe('sess-123');
      expect(meta.turn_id).toBe('turn12345678');
      expect(meta.parent_turn_id).toBeNull();
      expect(meta.children_turn_ids).toEqual([]);
      expect(meta.agent).toBe('main');
      expect(meta.subagent_type).toBeNull();
      expect(meta.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(meta.finalized_at).toBeNull();
      expect(meta.finalization_reason).toBeNull();
      expect(meta.hook_shim_version).toBe('0.1.0');
      expect(meta.files_changed_count).toBe(0);
      expect(meta.tool_call_count).toBe(0);
      expect(meta.scrubber_hit_count).toBe(0);
    });
  });

  describe('writeMeta + readMeta roundtrip', () => {
    it('roundtrips every TurnMeta field', () => {
      const turnDir = join(tmpBase, 'turn-1');
      mkdirSync(turnDir, { recursive: true });

      const meta = startMeta(fakePayload, {
        projectId: 'aabbccddee12',
        projectSlug: 'test-proj',
        turnId: 'tid123456789',
        agent: 'main',
        subagentType: null,
        hookShimVersion: '0.1.0',
      });

      writeMeta(turnDir, meta);
      const read = readMeta(turnDir);

      expect(read).toEqual(meta);
    });

    it('writes via temp+rename (no .tmp file remains)', () => {
      const turnDir = join(tmpBase, 'turn-2');
      mkdirSync(turnDir, { recursive: true });

      const meta = startMeta(fakePayload, {
        projectId: 'p1',
        projectSlug: 's1',
        turnId: 't1',
        agent: 'main',
        subagentType: null,
        hookShimVersion: '0.1.0',
      });

      writeMeta(turnDir, meta);
      const files = readdirSync(turnDir);
      expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(files).toContain('meta.json');
    });

    it('meta.json is written with mode 0600', () => {
      const turnDir = join(tmpBase, 'turn-perm');
      mkdirSync(turnDir, { recursive: true });

      const meta = startMeta(fakePayload, {
        projectId: 'p1',
        projectSlug: 's1',
        turnId: 't1',
        agent: 'main',
        subagentType: null,
        hookShimVersion: '0.1.0',
      });

      writeMeta(turnDir, meta);
      const stat = statSync(join(turnDir, 'meta.json'));
      if (!isWindows) {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });
  });

  describe('readMeta on missing dir', () => {
    it('returns null', () => {
      expect(readMeta('/tmp/nonexistent-dir-' + Date.now())).toBeNull();
    });
  });

  describe('finalizeMeta', () => {
    it('sets finalized_at and finalization_reason="stop"', () => {
      const turnDir = join(tmpBase, 'turn-fin');
      mkdirSync(turnDir, { recursive: true });

      const meta = startMeta(fakePayload, {
        projectId: 'p1',
        projectSlug: 's1',
        turnId: 't1',
        agent: 'main',
        subagentType: null,
        hookShimVersion: '0.1.0',
      });
      writeMeta(turnDir, meta);

      const finalized = finalizeMeta(turnDir, 'stop');
      expect(finalized.finalized_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(finalized.finalization_reason).toBe('stop');

      // Verify on-disk
      const read = readMeta(turnDir);
      expect(read?.finalized_at).toBe(finalized.finalized_at);
      expect(read?.finalization_reason).toBe('stop');
    });

    it('sets finalization_reason="subagent_stop"', () => {
      const turnDir = join(tmpBase, 'turn-sub');
      mkdirSync(turnDir, { recursive: true });

      const meta = startMeta(fakePayload, {
        projectId: 'p1',
        projectSlug: 's1',
        turnId: 't1',
        agent: 'main',
        subagentType: null,
        hookShimVersion: '0.1.0',
      });
      writeMeta(turnDir, meta);

      const finalized = finalizeMeta(turnDir, 'subagent_stop');
      expect(finalized.finalization_reason).toBe('subagent_stop');
    });
  });

  describe('updateMeta', () => {
    it('merges partial updates into existing meta', () => {
      const turnDir = join(tmpBase, 'turn-upd');
      mkdirSync(turnDir, { recursive: true });

      const meta = startMeta(fakePayload, {
        projectId: 'p1',
        projectSlug: 's1',
        turnId: 't1',
        agent: 'main',
        subagentType: null,
        hookShimVersion: '0.1.0',
      });
      writeMeta(turnDir, meta);

      const updated = updateMeta(turnDir, { scrubber_hit_count: 3 });
      expect(updated.scrubber_hit_count).toBe(3);
      expect(updated.project_id).toBe('p1'); // unchanged fields preserved

      // Verify on-disk
      const read = readMeta(turnDir);
      expect(read?.scrubber_hit_count).toBe(3);
    });

    it('throws when meta.json is missing', () => {
      expect(() => updateMeta('/tmp/no-meta-' + Date.now(), {})).toThrow(/meta\.json not found/);
    });
  });
});

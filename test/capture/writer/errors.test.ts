import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, statSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { logError, ERRORS_CAP_BYTES, initErrorWriter } from '~/capture/writer/errors.js';
import { isWindows } from '../../setup/platform.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('errors.ts', () => {
  let tmpBase: string;
  let projectErrors: string;
  let globalErrors: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
    projectErrors = join(tmpBase, 'project', 'errors.jsonl');
    globalErrors = join(tmpBase, 'global', 'errors.jsonl');
  });

  describe('logError', () => {
    it('writes one JSON line to both project and global errors.jsonl', () => {
      logError(
        { projectErrorsLog: projectErrors, globalErrorsLog: globalErrors },
        { kind: 'test_error', turn_id: 'turn123', err: 'something broke' },
      );

      expect(existsSync(projectErrors)).toBe(true);
      expect(existsSync(globalErrors)).toBe(true);

      const projectLine = readFileSync(projectErrors, 'utf8').trim();
      const globalLine = readFileSync(globalErrors, 'utf8').trim();

      const projectRecord = JSON.parse(projectLine);
      expect(projectRecord.kind).toBe('test_error');
      expect(projectRecord.turn_id).toBe('turn123');
      expect(projectRecord.err).toBe('something broke');
      expect(projectRecord.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const globalRecord = JSON.parse(globalLine);
      expect(globalRecord.kind).toBe('test_error');
    });

    it('creates files with mode 0600', () => {
      logError(
        { projectErrorsLog: projectErrors, globalErrorsLog: globalErrors },
        { kind: 'test', turn_id: null, err: 'x' },
      );

      if (!isWindows) {
        const projectMode = statSync(projectErrors).mode & 0o777;
        expect(projectMode).toBe(0o600);
      }
    });

    it('creates parent directories with mode 0700', () => {
      const deepPath = join(tmpBase, 'deep', 'nested', 'errors.jsonl');
      logError(
        { projectErrorsLog: deepPath, globalErrorsLog: globalErrors },
        { kind: 'test', turn_id: null, err: 'x' },
      );

      if (!isWindows) {
        const parentMode = statSync(join(tmpBase, 'deep', 'nested')).mode & 0o777;
        expect(parentMode).toBe(0o700);
      }
    });
  });

  describe('rotation at 10MB cap', () => {
    it('rotates errors.jsonl to errors.jsonl.1 when at cap', () => {
      // Seed project errors with exactly 10MB
      mkdirSync(join(tmpBase, 'project'), { recursive: true });
      const filler = 'x'.repeat(ERRORS_CAP_BYTES);
      writeFileSync(projectErrors, filler, { mode: 0o600 });

      logError(
        { projectErrorsLog: projectErrors, globalErrorsLog: globalErrors },
        { kind: 'after_rotation', turn_id: null, err: 'new' },
      );

      // Old content moved to .1
      expect(existsSync(projectErrors + '.1')).toBe(true);
      const backup = readFileSync(projectErrors + '.1', 'utf8');
      expect(backup).toBe(filler);

      // New file has just the new line
      const current = readFileSync(projectErrors, 'utf8').trim();
      const record = JSON.parse(current);
      expect(record.kind).toBe('after_rotation');
    });

    it('overwrites .1 on repeated rotation (single backup policy)', () => {
      mkdirSync(join(tmpBase, 'project'), { recursive: true });

      // First rotation: seed with OLD1 marker at 10MB
      const old1 = 'OLD1' + 'x'.repeat(ERRORS_CAP_BYTES - 4);
      writeFileSync(projectErrors, old1, { mode: 0o600 });
      logError(
        { projectErrorsLog: projectErrors, globalErrorsLog: globalErrors },
        { kind: 'rot1', turn_id: null, err: 'a' },
      );
      expect(readFileSync(projectErrors + '.1', 'utf8').startsWith('OLD1')).toBe(true);

      // Second rotation: seed with OLD2 marker at 10MB
      const old2 = 'OLD2' + 'x'.repeat(ERRORS_CAP_BYTES - 4);
      writeFileSync(projectErrors, old2, { mode: 0o600 });
      logError(
        { projectErrorsLog: projectErrors, globalErrorsLog: globalErrors },
        { kind: 'rot2', turn_id: null, err: 'b' },
      );

      // .1 should have OLD2, not OLD1
      const backup = readFileSync(projectErrors + '.1', 'utf8');
      expect(backup.startsWith('OLD2')).toBe(true);
    });
  });

  describe('global survives project failure', () => {
    it('writes to global even if project dir is read-only', () => {
      // Create project dir then make it read-only
      const roDir = join(tmpBase, 'readonly');
      mkdirSync(roDir, { recursive: true });
      const roErrors = join(roDir, 'errors.jsonl');
      // Write initial file so dir exists
      writeFileSync(roErrors, '', { mode: 0o600 });
      // Make the file itself read-only so append fails
      chmodSync(roErrors, 0o400);

      logError(
        { projectErrorsLog: roErrors, globalErrorsLog: globalErrors },
        { kind: 'test_survive', turn_id: null, err: 'should reach global' },
      );

      // Global should still have the line
      expect(existsSync(globalErrors)).toBe(true);
      const globalLine = readFileSync(globalErrors, 'utf8').trim();
      const record = JSON.parse(globalLine);
      expect(record.kind).toBe('test_survive');

      // Restore perms for cleanup
      chmodSync(roErrors, 0o600);
    });
  });

  describe('logError never throws', () => {
    it('does not throw even with completely invalid paths', () => {
      // Use paths that are guaranteed to fail (file as directory)
      const brokenProject = join(tmpBase, 'file-as-dir');
      writeFileSync(brokenProject, 'not a dir');
      const brokenPath1 = join(brokenProject, 'sub', 'errors.jsonl');
      const brokenPath2 = join(brokenProject, 'other', 'errors.jsonl');

      expect(() => {
        logError(
          { projectErrorsLog: brokenPath1, globalErrorsLog: brokenPath2 },
          { kind: 'boom', turn_id: null, err: 'fail' },
        );
      }).not.toThrow();
    });
  });

  describe('initErrorWriter', () => {
    it('returns a function matching ErrorWriter signature', () => {
      const paths = {
        projectErrorsLog: projectErrors,
        globalErrorsLog: globalErrors,
        // Fill in the rest as stubs — initErrorWriter only uses error paths
        projectCaptureDir: '',
        projectStateDir: '',
        projectPausedFlag: '',
        projectYarimKalan: '',
        tmpPayloadDir: '',
        globalSopHome: '',
        globalProjectDir: '',
        globalIndexJsonl: '',
        devArmyGlobalDir: () => '',
      };

      const writer = initErrorWriter(paths);
      expect(typeof writer).toBe('function');

      // Should write to both logs
      writer('test_kind', 'turn-abc', new Error('boom'));

      const projectLine = readFileSync(projectErrors, 'utf8').trim();
      const record = JSON.parse(projectLine);
      expect(record.kind).toBe('test_kind');
      expect(record.turn_id).toBe('turn-abc');
      expect(record.err).toBe('boom');
    });

    it('stringifies non-Error err values', () => {
      const paths = {
        projectErrorsLog: projectErrors,
        globalErrorsLog: globalErrors,
        projectCaptureDir: '',
        projectStateDir: '',
        projectPausedFlag: '',
        projectYarimKalan: '',
        tmpPayloadDir: '',
        globalSopHome: '',
        globalProjectDir: '',
        globalIndexJsonl: '',
        devArmyGlobalDir: () => '',
      };

      const writer = initErrorWriter(paths);
      writer('test', null, 'string error');

      const line = readFileSync(projectErrors, 'utf8').trim();
      expect(JSON.parse(line).err).toBe('string error');
    });

    it('stringifies null err', () => {
      const paths = {
        projectErrorsLog: projectErrors,
        globalErrorsLog: globalErrors,
        projectCaptureDir: '',
        projectStateDir: '',
        projectPausedFlag: '',
        projectYarimKalan: '',
        tmpPayloadDir: '',
        globalSopHome: '',
        globalProjectDir: '',
        globalIndexJsonl: '',
        devArmyGlobalDir: () => '',
      };

      const writer = initErrorWriter(paths);
      writer('paused_skipped', null, null);

      const line = readFileSync(projectErrors, 'utf8').trim();
      expect(JSON.parse(line).err).toBe('null');
    });
  });
});

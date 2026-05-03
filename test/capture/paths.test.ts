import { describe, it, expect, vi } from 'vitest';
import { join, isAbsolute } from 'node:path';

// Mock os.homedir before importing paths module
const FAKE_HOME = '/tmp/fake-home';
vi.mock('node:os', () => ({
  homedir: () => FAKE_HOME,
}));

// Import after mock is set up
const { getCapturePaths, detectDevArmyAgent } = await import('../../src/capture/paths.js');

describe('getCapturePaths', () => {
  const PROJECT_ROOT = '/tmp/my-project';
  const PROJECT_ID = 'abc123def456';

  it('returns all expected path keys', () => {
    const paths = getCapturePaths(PROJECT_ROOT, PROJECT_ID);
    expect(paths).toHaveProperty('projectCaptureDir');
    expect(paths).toHaveProperty('projectStateDir');
    expect(paths).toHaveProperty('projectErrorsLog');
    expect(paths).toHaveProperty('projectPausedFlag');
    expect(paths).toHaveProperty('projectYarimKalan');
    expect(paths).toHaveProperty('tmpPayloadDir');
    expect(paths).toHaveProperty('globalSopHome');
    expect(paths).toHaveProperty('globalProjectDir');
    expect(paths).toHaveProperty('globalIndexJsonl');
    expect(paths).toHaveProperty('globalErrorsLog');
    expect(paths).toHaveProperty('devArmyGlobalDir');
  });

  it('project paths are under projectRoot/.auto-sop', () => {
    const paths = getCapturePaths(PROJECT_ROOT, PROJECT_ID);
    const claudeSopDir = join(PROJECT_ROOT, '.auto-sop');
    expect(paths.projectCaptureDir).toBe(join(claudeSopDir, 'captures'));
    expect(paths.projectStateDir).toBe(join(claudeSopDir, 'state'));
    expect(paths.projectErrorsLog).toBe(join(claudeSopDir, 'errors.jsonl'));
    expect(paths.projectPausedFlag).toBe(join(claudeSopDir, 'paused.flag'));
  });

  it('yarim-kalan is under captures', () => {
    const paths = getCapturePaths(PROJECT_ROOT, PROJECT_ID);
    expect(paths.projectYarimKalan).toBe(
      join(PROJECT_ROOT, '.auto-sop', 'captures', 'yarim-kalan'),
    );
  });

  it('tmp payload dir uses homedir', () => {
    const paths = getCapturePaths(PROJECT_ROOT, PROJECT_ID);
    expect(paths.tmpPayloadDir).toBe(join(FAKE_HOME, '.auto-sop', 'tmp'));
  });

  it('global paths use homedir and project id', () => {
    const paths = getCapturePaths(PROJECT_ROOT, PROJECT_ID);
    expect(paths.globalSopHome).toBe(join(FAKE_HOME, '.claude', 'sop'));
    expect(paths.globalProjectDir).toBe(join(FAKE_HOME, '.claude', 'sop', PROJECT_ID));
    expect(paths.globalIndexJsonl).toBe(
      join(FAKE_HOME, '.claude', 'sop', PROJECT_ID, 'index.jsonl'),
    );
    expect(paths.globalErrorsLog).toBe(
      join(FAKE_HOME, '.claude', 'sop', PROJECT_ID, 'errors.jsonl'),
    );
  });

  it('devArmyGlobalDir returns correct agent path', () => {
    const paths = getCapturePaths(PROJECT_ROOT, PROJECT_ID);
    expect(paths.devArmyGlobalDir('commander')).toBe(
      join(FAKE_HOME, '.claude', 'sop', 'dev-army', 'commander'),
    );
  });

  it('all paths are absolute', () => {
    const paths = getCapturePaths(PROJECT_ROOT, PROJECT_ID);
    expect(isAbsolute(paths.projectCaptureDir)).toBe(true);
    expect(isAbsolute(paths.projectStateDir)).toBe(true);
    expect(isAbsolute(paths.projectErrorsLog)).toBe(true);
    expect(isAbsolute(paths.projectPausedFlag)).toBe(true);
    expect(isAbsolute(paths.projectYarimKalan)).toBe(true);
    expect(isAbsolute(paths.tmpPayloadDir)).toBe(true);
    expect(isAbsolute(paths.globalSopHome)).toBe(true);
    expect(isAbsolute(paths.globalProjectDir)).toBe(true);
    expect(isAbsolute(paths.globalIndexJsonl)).toBe(true);
    expect(isAbsolute(paths.globalErrorsLog)).toBe(true);
  });
});

describe('detectDevArmyAgent', () => {
  it('returns agent name for dev-army project path', () => {
    const projectRoot = join(FAKE_HOME, '.claude', 'dev-army', 'commander');
    expect(detectDevArmyAgent(projectRoot)).toBe('commander');
  });

  it('returns agent name for nested dev-army path', () => {
    const projectRoot = join(FAKE_HOME, '.claude', 'dev-army', 'architect', 'subdir');
    expect(detectDevArmyAgent(projectRoot)).toBe('architect');
  });

  it('returns null for non-dev-army project', () => {
    expect(detectDevArmyAgent(join(FAKE_HOME, 'other-project'))).toBeNull();
  });

  it('returns null for partial prefix match', () => {
    expect(detectDevArmyAgent(join(FAKE_HOME, '.claude', 'dev-army-fake', 'x'))).toBeNull();
  });

  it('returns null when path equals prefix without agent segment', () => {
    // Path exactly matches the prefix dir (no agent after it)
    expect(detectDevArmyAgent(join(FAKE_HOME, '.claude', 'dev-army'))).toBeNull();
  });
});

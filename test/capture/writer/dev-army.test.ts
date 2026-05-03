import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CapturePaths } from '~/capture/paths.js';
import type { TurnMeta } from '~/capture/types.js';
import { appendGlobalIndexLine, resolveGlobalTargetDir } from '~/capture/writer/global-mirror.js';

const FAKE_HOME = `/tmp/fake-home-${randomUUID()}`;

function makePaths(projectId: string): CapturePaths {
  const globalSopHome = join(FAKE_HOME, '.claude', 'sop');
  const globalProjectDir = join(globalSopHome, projectId);
  return {
    projectCaptureDir: '',
    projectStateDir: '',
    projectErrorsLog: '',
    projectPausedFlag: '',
    projectYarimKalan: '',
    tmpPayloadDir: '',
    globalSopHome,
    globalProjectDir,
    globalIndexJsonl: join(globalProjectDir, 'index.jsonl'),
    globalErrorsLog: join(globalProjectDir, 'errors.jsonl'),
    devArmyGlobalDir: (agent: string) => join(globalSopHome, 'dev-army', agent),
  };
}

function makeMeta(overrides: Partial<TurnMeta> = {}): TurnMeta {
  return {
    schema_version: 1,
    project_id: 'abc123def456',
    project_slug: 'test-project',
    session_id: 'sess-001',
    turn_id: 'turn-da-001',
    parent_turn_id: null,
    children_turn_ids: [],
    agent: 'main',
    subagent_type: null,
    started_at: '2026-04-13T10:00:00Z',
    finalized_at: '2026-04-13T10:01:00Z',
    finalization_reason: 'stop',
    hook_shim_version: '0.1.0',
    files_changed_count: 0,
    tool_call_count: 0,
    scrubber_hit_count: 0,
    ...overrides,
  };
}

/**
 * Simulate detectDevArmyAgent logic without importing os.homedir,
 * so we can control the fake home path in tests.
 */
function makeDetector(fakeHome: string) {
  return (projectRoot: string): string | null => {
    const devArmyPrefix = join(fakeHome, '.claude', 'dev-army') + sep;
    if (!projectRoot.startsWith(devArmyPrefix)) return null;
    const remainder = projectRoot.slice(devArmyPrefix.length);
    const firstSegment = remainder.split(sep)[0];
    return firstSegment || null;
  };
}

describe('dev-army namespace routing', () => {
  const projectId = 'abc123def456';
  let paths: CapturePaths;
  let detect: (root: string) => string | null;

  beforeEach(() => {
    paths = makePaths(projectId);
    detect = makeDetector(FAKE_HOME);
  });

  it('standard project routes to hash-based namespace', () => {
    const projectRoot = '/tmp/home/my-project';
    expect(detect(projectRoot)).toBeNull();

    const targetDir = resolveGlobalTargetDir(paths, projectRoot, detect);
    expect(targetDir).toBe(paths.globalProjectDir);
    expect(targetDir).toContain(projectId);
  });

  it('dev-army project routes to dev-army namespace', () => {
    const projectRoot = join(FAKE_HOME, '.claude', 'dev-army', 'commander');

    expect(detect(projectRoot)).toBe('commander');

    // Append a line and verify it lands in the dev-army dir
    appendGlobalIndexLine(paths, projectRoot, makeMeta(), '/some/turn/dir', detect);

    const devArmyDir = paths.devArmyGlobalDir('commander');
    const indexPath = join(devArmyDir, 'index.jsonl');
    expect(existsSync(indexPath)).toBe(true);

    const line = JSON.parse(readFileSync(indexPath, 'utf8').trim());
    expect(line.turn_id).toBe('turn-da-001');

    // hash-based dir does NOT exist
    expect(existsSync(join(paths.globalProjectDir, 'index.jsonl'))).toBe(false);
  });

  it('nested dev-army path extracts first segment as agent', () => {
    const projectRoot = join(FAKE_HOME, '.claude', 'dev-army', 'architect', 'some-subdir');
    expect(detect(projectRoot)).toBe('architect');

    const targetDir = resolveGlobalTargetDir(paths, projectRoot, detect);
    expect(targetDir).toBe(paths.devArmyGlobalDir('architect'));
    expect(targetDir).toContain(`dev-army${sep}architect`);
  });

  it('non-dev-army claude path falls back to hash-based namespace', () => {
    const projectRoot = join(FAKE_HOME, '.claude', 'other', 'thing');
    expect(detect(projectRoot)).toBeNull();

    const targetDir = resolveGlobalTargetDir(paths, projectRoot, detect);
    expect(targetDir).toBe(paths.globalProjectDir);
  });

  it('dev-army index and hash-based index are separate', () => {
    const devArmyRoot = join(FAKE_HOME, '.claude', 'dev-army', 'commander');
    const normalRoot = '/tmp/normal-project';

    appendGlobalIndexLine(
      paths,
      devArmyRoot,
      makeMeta({ turn_id: 'dev-turn' }),
      '/dev/dir',
      detect,
    );
    appendGlobalIndexLine(
      paths,
      normalRoot,
      makeMeta({ turn_id: 'normal-turn' }),
      '/normal/dir',
      detect,
    );

    const devLines = readFileSync(join(paths.devArmyGlobalDir('commander'), 'index.jsonl'), 'utf8')
      .trim()
      .split('\n');
    const normalLines = readFileSync(join(paths.globalProjectDir, 'index.jsonl'), 'utf8')
      .trim()
      .split('\n');

    // Dev-army index should contain the dev turn
    const devTurnIds = devLines.map((l) => JSON.parse(l).turn_id);
    expect(devTurnIds).toContain('dev-turn');

    // Normal index should contain the normal turn
    const normalTurnIds = normalLines.map((l) => JSON.parse(l).turn_id);
    expect(normalTurnIds).toContain('normal-turn');
  });
});

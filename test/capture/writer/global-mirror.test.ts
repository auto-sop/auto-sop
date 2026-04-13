import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CapturePaths } from '~/capture/paths.js';
import type { TurnMeta } from '~/capture/types.js';
import {
  appendGlobalIndexLine,
  migrateGlobalDirOnMove,
  type GlobalIndexLine,
} from '~/capture/writer/global-mirror.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `claude-sop-gm-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePaths(tmpBase: string, projectId: string): CapturePaths {
  const globalSopHome = join(tmpBase, '.claude', 'sop');
  const globalProjectDir = join(globalSopHome, projectId);
  return {
    projectCaptureDir: join(tmpBase, 'project', '.claude-sop', 'captures'),
    projectStateDir: join(tmpBase, 'project', '.claude-sop', 'state'),
    projectErrorsLog: join(tmpBase, 'project', '.claude-sop', 'errors.jsonl'),
    projectPausedFlag: join(tmpBase, 'project', '.claude-sop', 'paused.flag'),
    projectYarimKalan: join(tmpBase, 'project', '.claude-sop', 'captures', 'yarim-kalan'),
    tmpPayloadDir: join(tmpBase, '.claude-sop', 'tmp'),
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
    turn_id: 'turn-001',
    parent_turn_id: null,
    children_turn_ids: [],
    agent: 'main',
    subagent_type: null,
    started_at: '2026-04-13T10:00:00Z',
    finalized_at: '2026-04-13T10:01:00Z',
    finalization_reason: 'stop',
    hook_shim_version: '0.1.0',
    files_changed_count: 3,
    tool_call_count: 5,
    scrubber_hit_count: 0,
    ...overrides,
  };
}

const noDevArmy = () => null;

describe('appendGlobalIndexLine', () => {
  let tmpBase: string;
  let paths: CapturePaths;

  beforeEach(() => {
    tmpBase = makeTmpDir();
    paths = makePaths(tmpBase, 'abc123def456');
  });

  it('writes one valid JSON line to index.jsonl with all GlobalIndexLine fields', () => {
    const meta = makeMeta();
    const turnDir = '/project/captures/2026-04-13T10-01-00Z_main_turn-001';

    appendGlobalIndexLine(paths, '/project', meta, turnDir, noDevArmy);

    const indexPath = join(paths.globalProjectDir, 'index.jsonl');
    expect(existsSync(indexPath)).toBe(true);

    const raw = readFileSync(indexPath, 'utf8').trim();
    const line = JSON.parse(raw) as GlobalIndexLine;

    expect(line.turn_id).toBe('turn-001');
    expect(line.session_id).toBe('sess-001');
    expect(line.project_id).toBe('abc123def456');
    expect(line.project_path).toBe('/project');
    expect(line.project_turn_dir).toBe(turnDir);
    expect(line.agent).toBe('main');
    expect(line.parent_turn_id).toBeNull();
    expect(line.finalization_reason).toBe('stop');
    expect(line.t).toBe('2026-04-13T10:01:00Z');
  });

  it('creates index file with mode 0600', () => {
    appendGlobalIndexLine(paths, '/project', makeMeta(), '/dir', noDevArmy);
    const indexPath = join(paths.globalProjectDir, 'index.jsonl');
    const mode = statSync(indexPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates target dir with mode 0700', () => {
    appendGlobalIndexLine(paths, '/project', makeMeta(), '/dir', noDevArmy);
    const dirMode = statSync(paths.globalProjectDir).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('appends multiple lines to the same file', () => {
    const meta1 = makeMeta({ turn_id: 'turn-001' });
    const meta2 = makeMeta({ turn_id: 'turn-002' });

    appendGlobalIndexLine(paths, '/project', meta1, '/dir1', noDevArmy);
    appendGlobalIndexLine(paths, '/project', meta2, '/dir2', noDevArmy);

    const raw = readFileSync(join(paths.globalProjectDir, 'index.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).turn_id).toBe('turn-001');
    expect(JSON.parse(lines[1]).turn_id).toBe('turn-002');
  });

  it('auto-creates target dir when it does not exist', () => {
    expect(existsSync(paths.globalProjectDir)).toBe(false);
    appendGlobalIndexLine(paths, '/project', makeMeta(), '/dir', noDevArmy);
    expect(existsSync(paths.globalProjectDir)).toBe(true);
  });

  it('uses "unknown" when finalization_reason is null', () => {
    const meta = makeMeta({ finalization_reason: null });
    appendGlobalIndexLine(paths, '/project', meta, '/dir', noDevArmy);
    const raw = readFileSync(join(paths.globalProjectDir, 'index.jsonl'), 'utf8').trim();
    expect(JSON.parse(raw).finalization_reason).toBe('unknown');
  });
});

describe('migrateGlobalDirOnMove', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  it('renames old dir to new dir and rewrites index paths', () => {
    const oldDir = join(tmpBase, 'oldhash');
    const newDir = join(tmpBase, 'newhash');

    // Seed 3 index lines referencing /old/project
    mkdirSync(oldDir, { recursive: true });
    const lines = [
      { turn_id: 't1', project_path: '/old/project', project_turn_dir: '/old/project/captures/t1' },
      { turn_id: 't2', project_path: '/old/project', project_turn_dir: '/old/project/captures/t2' },
      { turn_id: 't3', project_path: '/old/project', project_turn_dir: '/old/project/captures/t3' },
    ];
    writeFileSync(
      join(oldDir, 'index.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      { mode: 0o600 },
    );

    const result = migrateGlobalDirOnMove(oldDir, newDir, '/new/project');

    expect(result.moved).toBe(true);
    expect(result.linesRewritten).toBe(3);

    // Old dir gone, new dir exists
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);

    // Rewritten index
    const raw = readFileSync(join(newDir, 'index.jsonl'), 'utf8');
    const rewritten = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rewritten).toHaveLength(3);
    for (const line of rewritten) {
      expect(line.project_path).toBe('/new/project');
      expect(line.project_turn_dir).toContain('/new/project');
      expect(line.project_turn_dir).not.toContain('/old/project');
    }

    // Migration log exists
    const migrationLog = readFileSync(join(newDir, 'migration.log'), 'utf8');
    expect(migrationLog).toContain('moved from');
    expect(migrationLog).toContain('rewrote 3 lines');
  });

  it('returns no-op when old and new dirs are the same', () => {
    const dir = join(tmpBase, 'samedir');
    const result = migrateGlobalDirOnMove(dir, dir, '/project');
    expect(result.moved).toBe(false);
    expect(result.linesRewritten).toBe(0);
  });

  it('aborts on collision when both dirs exist', () => {
    const oldDir = join(tmpBase, 'old-collision');
    const newDir = join(tmpBase, 'new-collision');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });

    // Seed old with data
    writeFileSync(join(oldDir, 'index.jsonl'), '{"turn_id":"x"}\n', { mode: 0o600 });
    // Seed new with existing data that should not be clobbered
    writeFileSync(join(newDir, 'index.jsonl'), '{"turn_id":"existing"}\n', { mode: 0o600 });

    const result = migrateGlobalDirOnMove(oldDir, newDir, '/new');

    expect(result.moved).toBe(false);

    // Old dir is untouched
    expect(existsSync(oldDir)).toBe(true);
    expect(readFileSync(join(oldDir, 'index.jsonl'), 'utf8')).toContain('x');

    // New dir's existing data is preserved
    expect(readFileSync(join(newDir, 'index.jsonl'), 'utf8')).toContain('existing');

    // Collision logged
    const migrationLog = readFileSync(join(newDir, 'migration.log'), 'utf8');
    expect(migrationLog).toContain('collision');
    expect(migrationLog).toContain(oldDir);
  });

  it('returns no-op when old dir does not exist', () => {
    const result = migrateGlobalDirOnMove(
      join(tmpBase, 'nonexistent'),
      join(tmpBase, 'new'),
      '/project',
    );
    expect(result.moved).toBe(false);
    expect(result.linesRewritten).toBe(0);
  });
});

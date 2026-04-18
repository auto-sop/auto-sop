/**
 * Statusline verb tests — v11 rewrite using REAL Claude Code settings.json fixtures.
 *
 * Real Claude Code settings.json structure (three levels deep):
 *   {
 *     "hooks": {                           // Level 1: top-level "hooks" key
 *       "UserPromptSubmit": [              // Level 2: event name → array of entries
 *         {
 *           "hooks": [                     // Level 3: each entry has nested "hooks" array
 *             {
 *               "type": "command",
 *               "command": "/path/to/claude-sop/shim.cjs",
 *               "timeout": 10,
 *               "id": "claude-sop"
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * v10 bug: the parser iterated TOP-level keys and checked val.hooks directly,
 * missing the event-name → entries nesting. All fixtures here use the real shape.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { runCli } from '../../../src/cli/main.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Mock PathResolver (unused by statusline but needed by other verbs at import time)
vi.mock('../../../src/path-resolver/index.js', () => ({
  PathResolver: class MockPathResolver {
    async resolve() {
      return {
        identity: { projectId: 'abc123def456', slug: 'test-proj' },
      };
    }
  },
}));

// Mock pickBackend (unused by statusline)
vi.mock('../../../src/scheduler/index.js', () => ({
  pickBackend: vi.fn().mockResolvedValue({
    backend: {
      name: 'launchd',
      install: vi.fn(),
      uninstall: vi.fn(),
      status: vi.fn(),
    },
  }),
}));

// Mock scrubber
vi.mock('../../../src/scrubber/index.js', () => ({
  loadRulePack: vi.fn(),
}));

// Mock runInstall for install tip test
vi.mock('../../../src/installer/orchestrator.js', () => ({
  runInstall: vi.fn().mockResolvedValue({
    verdict: 'fresh',
    installedVersion: '0.0.0',
    scheduler: 'launchd',
    gitignore: 'updated',
    warnings: [],
  }),
}));

/** Helper: set up a tmp project with a given fixture file as .claude/settings.json */
function setupProjectWithFixture(tmpDir: string, fixtureName: string): void {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const fixturePath = path.join(FIXTURES_DIR, fixtureName);
  fs.copyFileSync(fixturePath, path.join(claudeDir, 'settings.json'));
}

/** Helper: set up a tmp project with raw JSON string as .claude/settings.json */
function setupProjectWithRaw(tmpDir: string, content: string): void {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), content);
}

describe('statusline verb', () => {
  let stdoutChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let tmpDir: string;

  beforeEach(() => {
    stdoutChunks = [];
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-'));
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // === v11 regression: real Claude Code settings.json structure ===

  it('detects claude-sop hooks in real Claude Code settings.json structure (v11 regression)', async () => {
    setupProjectWithFixture(tmpDir, 'real-settings-installed.json');

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:on]');
  });

  it('does not match when non-claude-sop hooks present', async () => {
    setupProjectWithFixture(tmpDir, 'real-settings-not-installed.json');

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:off]');
  });

  it('does not match when hooks object is empty', async () => {
    setupProjectWithFixture(tmpDir, 'real-settings-empty-hooks.json');

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:off]');
  });

  it('does not match when hooks key missing entirely', async () => {
    setupProjectWithFixture(tmpDir, 'real-settings-no-hooks-key.json');

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:off]');
  });

  it('returns [sop:off] on malformed JSON', async () => {
    setupProjectWithRaw(tmpDir, '{not valid json');

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:off]');
  });

  it('returns [sop:off] when settings.json is absent', async () => {
    // tmpDir exists but no .claude/ at all
    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:off]');
  });

  it('returns [sop:off] when .claude/ directory is missing', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-noclaudedr-'));
    try {
      const code = await runCli([
        'node',
        'claude-sop',
        'statusline',
        '--project',
        emptyDir,
      ]);

      expect(code).toBe(0);
      expect(stdoutChunks.join('')).toBe('[sop:off]');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('substring match — hook command path contains claude-sop somewhere', async () => {
    // Use real structure with a wrapper script that has 'claude-sop' in its path
    setupProjectWithRaw(
      tmpDir,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/opt/bin/claude-sop-wrapper.sh',
                  timeout: 10,
                  id: 'custom-wrapper',
                },
              ],
            },
          ],
        },
      }),
    );

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:on]');
  });

  it('mixed hooks — one claude-sop hook among several non-claude-sop hooks', async () => {
    setupProjectWithRaw(
      tmpDir,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/bin/unrelated-linter',
                  timeout: 5,
                  id: 'linter',
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/path/to/claude-sop/shim.cjs',
                  timeout: 10,
                  id: 'claude-sop',
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/another/tool/run.sh',
                  timeout: 8,
                  id: 'another',
                },
              ],
            },
          ],
        },
      }),
    );

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:on]');
  });

  it('deeply nested false — entry.hooks array exists but none have command matching', async () => {
    setupProjectWithRaw(
      tmpDir,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/bin/totally-different-tool',
                  timeout: 10,
                  id: 'different-tool',
                },
                {
                  type: 'command',
                  command: '/opt/another-unrelated',
                  timeout: 5,
                  id: 'another',
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/bin/cleanup.sh',
                  timeout: 3,
                  id: 'cleanup',
                },
              ],
            },
          ],
        },
      }),
    );

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:off]');
  });

  it('prints [sop:off] when settings.json is an array (not object)', async () => {
    setupProjectWithRaw(tmpDir, '[]');

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(stdoutChunks.join('')).toBe('[sop:off]');
  });

  // === --json mode tests ===

  it('--json outputs structured JSON without exposing settings', async () => {
    setupProjectWithFixture(tmpDir, 'real-settings-installed.json');

    const code = await runCli([
      'node',
      'claude-sop',
      '--json',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output);
    expect(parsed.on).toBe(true);
    expect(parsed.project_root).toBe(tmpDir);
    expect(parsed.project_slug).toBe(path.basename(tmpDir));
    // Security: must NOT expose raw settings contents
    expect(output).not.toContain('shim.cjs');
    expect(output).not.toContain('synthetic');
  });

  it('--json outputs on:false for missing project', async () => {
    const code = await runCli([
      'node',
      'claude-sop',
      '--json',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output);
    expect(parsed.on).toBe(false);
  });

  it('no trailing newline in plain output', async () => {
    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).not.toMatch(/\n$/);
    expect(output).toBe('[sop:off]');
    expect(output.length).toBe(9);
  });

  // === Perf test ===

  it('perf: 10 serial invocations each under 200ms (p95)', async () => {
    setupProjectWithFixture(tmpDir, 'real-settings-installed.json');

    const durations: number[] = [];
    for (let i = 0; i < 10; i++) {
      stdoutChunks = [];
      const start = performance.now();
      const code = await runCli([
        'node',
        'claude-sop',
        'statusline',
        '--project',
        tmpDir,
      ]);
      const elapsed = performance.now() - start;
      durations.push(elapsed);
      expect(code).toBe(0);
      expect(stdoutChunks.join('')).toBe('[sop:on]');
    }
    const sorted = durations.sort((a, b) => a - b);
    const p95 = sorted[9];
    expect(p95).toBeLessThan(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B5 regression: statusline reads workspace JSON from stdin
// ═══════════════════════════════════════════════════════════════════════
//
// Claude Code's statusline integration pipes a JSON envelope on stdin:
//   { "workspace": { "current_dir": "/absolute/path/to/project" }, ... }
//
// In dev-army panes (and other wrapper spawns) `process.cwd()` points at
// the wrapper's directory, NOT the real project. Ignoring stdin → every
// such pane reports `[sop:off]` even when hooks are installed. Fix: when
// stdin is not a TTY, read and parse the envelope before falling back.
//
// Tests spawn the built CLI (`dist/cli.cjs`) so we can pipe real bytes
// into stdin — in-process tests cannot exercise the /dev/stdin path.
describe('statusline stdin JSON (B5 regression)', () => {
  // B11: Copy dist/cli.cjs into an isolated tmpdir at suite start.
  // When vitest runs the full suite in parallel, another test may rebuild
  // dist/ while these spawns are mid-flight, causing ENOENT races.
  const SRC_CLI = path.join(process.cwd(), 'dist', 'cli.cjs');
  let cliBinDir: string;
  let CLI: string;
  let tmpDir: string;

  // NODE_PATH allows the copied cli.cjs to resolve project deps (execa, nanoid, etc.)
  const spawnEnv = { ...process.env, NODE_PATH: path.join(process.cwd(), 'node_modules') };

  beforeAll(() => {
    if (fs.existsSync(SRC_CLI)) {
      cliBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sop-statusline-bin-'));
      CLI = path.join(cliBinDir, 'cli.cjs');
      // Copy content (not symlink) to survive concurrent rebuilds, but
      // spawn with NODE_PATH so require() resolves project deps.
      fs.copyFileSync(SRC_CLI, CLI);
    } else {
      cliBinDir = '';
      CLI = SRC_CLI; // tests guarded by .runIf will skip
    }
  });

  afterAll(() => {
    if (cliBinDir) {
      fs.rmSync(cliBinDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-stdin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.runIf(fs.existsSync(SRC_CLI))(
    'stdin with valid workspace JSON → uses current_dir (detects installed hooks)',
    async () => {
      setupProjectWithFixture(tmpDir, 'real-settings-installed.json');
      const { execFileSync } = await import('node:child_process');
      const payload = JSON.stringify({
        workspace: { current_dir: tmpDir },
        session_id: 'stdin-smoke',
      });
      const out = execFileSync(process.execPath, [CLI, 'statusline'], {
        input: payload,
        encoding: 'utf8',
        env: spawnEnv,
        timeout: 5000,
      });
      expect(out).toBe('[sop:on]');
    },
  );

  it.runIf(fs.existsSync(SRC_CLI))(
    'stdin with empty input → falls back to cwd',
    async () => {
      const { execFileSync } = await import('node:child_process');
      // Run from a directory with no hooks installed → expect [sop:off]
      const out = execFileSync(process.execPath, [CLI, 'statusline'], {
        input: '',
        encoding: 'utf8',
        env: spawnEnv,
        cwd: tmpDir,
        timeout: 5000,
      });
      expect(out).toBe('[sop:off]');
    },
  );

  it.runIf(fs.existsSync(SRC_CLI))(
    'stdin with malformed JSON → falls back to cwd, does not crash',
    async () => {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(process.execPath, [CLI, 'statusline'], {
        input: '{not valid json at all',
        encoding: 'utf8',
        env: spawnEnv,
        cwd: tmpDir,
        timeout: 5000,
      });
      expect(out).toBe('[sop:off]');
    },
  );

  it.runIf(fs.existsSync(SRC_CLI))(
    '--project flag overrides stdin workspace.current_dir',
    async () => {
      // stdin points at a project with installed hooks, but --project points
      // at an empty tmp dir → --project wins → [sop:off].
      const projectWithHooks = fs.mkdtempSync(
        path.join(os.tmpdir(), 'statusline-hooks-'),
      );
      try {
        setupProjectWithFixture(
          projectWithHooks,
          'real-settings-installed.json',
        );
        const { execFileSync } = await import('node:child_process');
        const payload = JSON.stringify({
          workspace: { current_dir: projectWithHooks },
        });
        const out = execFileSync(
          process.execPath,
          [CLI, 'statusline', '--project', tmpDir],
          {
            input: payload,
            encoding: 'utf8',
            env: spawnEnv,
            timeout: 5000,
          },
        );
        expect(out).toBe('[sop:off]');
      } finally {
        fs.rmSync(projectWithHooks, { recursive: true, force: true });
      }
    },
  );

  it.runIf(fs.existsSync(SRC_CLI))(
    'stdin workspace with installed hooks → [sop:on] via --json has correct project_root',
    async () => {
      setupProjectWithFixture(tmpDir, 'real-settings-installed.json');
      const { execFileSync } = await import('node:child_process');
      const payload = JSON.stringify({
        workspace: { current_dir: tmpDir },
      });
      const out = execFileSync(
        process.execPath,
        [CLI, '--json', 'statusline'],
        {
          input: payload,
          encoding: 'utf8',
          env: spawnEnv,
          timeout: 5000,
        },
      );
      const parsed = JSON.parse(out);
      expect(parsed.on).toBe(true);
      expect(parsed.project_root).toBe(tmpDir);
    },
  );
});

describe('install verb tip line', () => {
  let stdoutChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    stdoutChunks = [];
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    vi.clearAllMocks();
  });

  it('install output contains statusline tip', async () => {
    const code = await runCli([
      'node',
      'claude-sop',
      'install',
      '--project',
      '/tmp/fake-proj',
    ]);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toContain('tip: add [sop:on] indicator');
    expect(output).toContain('claude-sop statusline');
  });
});

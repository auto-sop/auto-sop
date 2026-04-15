import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCli } from '../../../src/cli/main.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    managedSection: 'present',
    gitignore: 'updated',
    warnings: [],
  }),
}));

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

  it('prints [sop:on] when project has claude-sop hooks', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        UserPromptSubmit: {
          hooks: [
            {
              type: 'command',
              command: '/home/user/.claude-sop/marketplace/claude-sop/shim.cjs',
              timeout: 10,
              id: 'claude-sop',
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
    const output = stdoutChunks.join('');
    expect(output).toBe('[sop:on]');
  });

  it('prints [sop:off] when no settings.json exists', async () => {
    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toBe('[sop:off]');
  });

  it('prints [sop:off] when settings.json has no claude-sop hooks', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        UserPromptSubmit: {
          hooks: [
            {
              type: 'command',
              command: '/some/other/tool',
              timeout: 10,
              id: 'other',
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
    const output = stdoutChunks.join('');
    expect(output).toBe('[sop:off]');
  });

  it('prints [sop:off] on malformed JSON', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      'this is not json{{{{',
    );

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toBe('[sop:off]');
  });

  it('prints [sop:off] when settings.json is an array (not object)', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '[]');

    const code = await runCli([
      'node',
      'claude-sop',
      'statusline',
      '--project',
      tmpDir,
    ]);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toBe('[sop:off]');
  });

  it('--json outputs structured JSON without exposing settings', async () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        Stop: {
          hooks: [
            {
              type: 'command',
              command: '/path/to/claude-sop/shim.cjs',
              timeout: 10,
              id: 'claude-sop',
            },
          ],
        },
        secretKey: 'should-not-appear',
      }),
    );

    // --json is a parent option, must go before the verb
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
    expect(output).not.toContain('should-not-appear');
    expect(output).not.toContain('secretKey');
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

  it('perf: 10 serial invocations each under 100ms', async () => {
    // Set up a project with hooks for realistic perf test
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        UserPromptSubmit: {
          hooks: [
            {
              type: 'command',
              command: '/path/to/claude-sop/shim.cjs',
              timeout: 10,
              id: 'claude-sop',
            },
          ],
        },
      }),
    );

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
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(100);
    }
  });
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

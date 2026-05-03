import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { runCli } from '../../../src/cli/main.js';
import type { InstallResult } from '../../../src/installer/orchestrator.js';
import { PreconditionError } from '../../../src/cli/errors.js';

// Mock runInstall before imports
vi.mock('../../../src/installer/orchestrator.js', () => ({
  runInstall: vi.fn(),
}));

import { runInstall } from '../../../src/installer/orchestrator.js';

const mockRunInstall = vi.mocked(runInstall);

function cannedResult(overrides: Partial<InstallResult> = {}): InstallResult {
  return {
    verdict: 'fresh',
    installedVersion: '1.0.0',
    warnings: [],
    pluginBundleDst: '/home/.auto-sop/marketplace/auto-sop',
    scheduler: 'launchd',
    gitignore: 'created',
    directivesRestored: 0,
    ...overrides,
  };
}

describe('install verb', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    vi.clearAllMocks();
  });

  it('install with --license passes licenseKey to runInstall', async () => {
    mockRunInstall.mockResolvedValueOnce(cannedResult());

    const code = await runCli([
      'node',
      'auto-sop',
      'install',
      '--project',
      '/tmp/test-project',
      '--license',
      'abc',
    ]);

    expect(code).toBe(0);
    expect(mockRunInstall).toHaveBeenCalledTimes(1);
    const callArgs = mockRunInstall.mock.calls[0][0];
    expect(callArgs.licenseKey).toBe('abc');
    expect(callArgs.projectRoot).toBe(path.resolve('/tmp/test-project'));
  });

  it('--json mode emits JSON output', async () => {
    mockRunInstall.mockResolvedValueOnce(cannedResult());

    const code = await runCli(['node', 'auto-sop', '--json', 'install', '--license', 'abc']);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.verb).toBe('install');
    expect(parsed.verdict).toBe('fresh');
  });

  it('PreconditionError maps to exit code 3', async () => {
    mockRunInstall.mockRejectedValueOnce(new PreconditionError('another install is in progress'));

    const code = await runCli(['node', 'auto-sop', 'install', '--license', 'abc']);

    expect(code).toBe(3);
    const stderrOutput = stderrChunks.join('');
    expect(stderrOutput).toContain('another install is in progress');
  });

  it('human output shows install complete message', async () => {
    mockRunInstall.mockResolvedValueOnce(cannedResult({ warnings: ['test warning'] }));

    const code = await runCli(['node', 'auto-sop', 'install', '--license', 'abc']);

    expect(code).toBe(0);
    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('install complete');
    expect(stdout).toContain('1.0.0');
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('test warning');
  });
});

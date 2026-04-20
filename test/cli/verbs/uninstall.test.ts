import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock dependencies BEFORE importing the verb module
vi.mock('../../../src/installer/uninstall-orchestrator.js', () => ({
  runUninstall: vi.fn(),
}));

vi.mock('../../../src/path-resolver/identity.js', () => ({
  resolveIdentity: vi.fn(async () => ({
    projectId: 'abc123def456',
    slug: 'test-project',
    source: 'cwd' as const,
    cwd: '/tmp/test',
  })),
}));

vi.mock('../../../src/path-resolver/git-runner.js', () => ({
  RealGitRunner: class {
    async remoteOriginUrl() {
      return null;
    }
    async toplevel() {
      return null;
    }
  },
}));

import { registerUninstallVerb } from '../../../src/cli/verbs/uninstall.js';
import { runUninstall } from '../../../src/installer/uninstall-orchestrator.js';

const mockRunUninstall = vi.mocked(runUninstall);

describe('uninstall verb', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let savedExitCode: number | undefined;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
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
    process.exitCode = savedExitCode;
    vi.clearAllMocks();
  });

  function makeProgram(): Command {
    const program = new Command()
      .name('auto-sop')
      .option('--json', 'emit JSON', false)
      .exitOverride();
    registerUninstallVerb(program);
    return program;
  }

  it('human mode — no warnings → prints success', async () => {
    mockRunUninstall.mockResolvedValue({
      warnings: [],
      steps: [
        { step: 'backup-managed-section', outcome: 'ok', detail: 'nothing to back up' },
        { step: 'strip-managed-section', outcome: 'ok' },
      ],
      backupPath: null,
    });

    const program = makeProgram();
    await program.parseAsync(['node', 'auto-sop', 'uninstall']);

    const output = stdoutChunks.join('');
    expect(output).toContain('uninstall complete');
    expect(process.exitCode).toBeUndefined();
  });

  it('human mode — with warnings → sets exitCode 1', async () => {
    mockRunUninstall.mockResolvedValue({
      warnings: ['scheduler: plist not loaded'],
      steps: [
        { step: 'scheduler-uninstall', outcome: 'warning', detail: 'scheduler: plist not loaded' },
      ],
      backupPath: null,
    });

    const program = makeProgram();
    await program.parseAsync(['node', 'auto-sop', 'uninstall']);

    expect(process.exitCode).toBe(1);
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('plist not loaded');
  });

  it('--purge flag forwarded to runUninstall', async () => {
    mockRunUninstall.mockResolvedValue({
      warnings: [],
      steps: [],
      backupPath: null,
    });

    const program = makeProgram();
    await program.parseAsync(['node', 'auto-sop', 'uninstall', '--purge']);

    expect(mockRunUninstall).toHaveBeenCalledWith(expect.objectContaining({ purge: true }));
  });

  it('--json mode emits JSON with ok: true when no warnings', async () => {
    mockRunUninstall.mockResolvedValue({
      warnings: [],
      steps: [{ step: 'test', outcome: 'ok' }],
      backupPath: null,
    });

    const program = makeProgram();
    await program.parseAsync(['node', 'auto-sop', '--json', 'uninstall']);

    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.verb).toBe('uninstall');
  });

  it('--json mode emits JSON with ok: false when warnings', async () => {
    mockRunUninstall.mockResolvedValue({
      warnings: ['something failed'],
      steps: [],
      backupPath: null,
    });

    const program = makeProgram();
    await program.parseAsync(['node', 'auto-sop', '--json', 'uninstall']);

    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.ok).toBe(false);
  });

  it('shows backup path when present', async () => {
    mockRunUninstall.mockResolvedValue({
      warnings: [],
      steps: [{ step: 'backup-managed-section', outcome: 'ok' }],
      backupPath: '/home/.claude/sop/abc/managed-history/uninstall-123.md',
    });

    const program = makeProgram();
    await program.parseAsync(['node', 'auto-sop', 'uninstall']);

    const output = stdoutChunks.join('');
    expect(output).toContain('managed-section backed up to');
  });
});

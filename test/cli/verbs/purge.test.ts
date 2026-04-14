import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { Command } from 'commander';

// Mock the path-resolver identity to return a deterministic hash
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
    async remoteOriginUrl() { return null; }
    async toplevel() { return null; }
  },
}));

// Mock os.homedir per-test
let mockHome = '/tmp';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome },
    homedir: () => mockHome,
  };
});

import { registerPurgeVerb } from '../../../src/cli/verbs/purge.js';

describe('purge verb', () => {
  let testDir: string;
  let homeDir: string;
  let projectRoot: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    testDir = join(tmpdir(), `purge-test-${nanoid(10)}`);
    homeDir = join(testDir, 'home');
    projectRoot = join(testDir, 'project');
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    mockHome = homeDir;

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

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await fs.rm(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function makeProgram(): Command {
    const program = new Command()
      .name('claude-sop')
      .option('--json', 'emit JSON', false)
      .exitOverride();
    registerPurgeVerb(program);
    return program;
  }

  async function seedCaptures(): Promise<void> {
    const captDir = join(projectRoot, '.claude-sop', 'captures');
    await fs.mkdir(captDir, { recursive: true });
    await fs.writeFile(join(captDir, 'data.json'), '{}');

    const globalDir = join(homeDir, '.claude', 'sop', 'abc123def456');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(join(globalDir, 'state.json'), '{}');
  }

  it('--yes flag removes both dirs without prompt', async () => {
    await seedCaptures();

    const program = makeProgram();
    await program.parseAsync([
      'node', 'claude-sop', 'purge', '--yes', '--project', projectRoot,
    ]);

    const output = stdoutChunks.join('');
    expect(output).toContain('captures purged');

    await expect(
      fs.access(join(projectRoot, '.claude-sop', 'captures')),
    ).rejects.toThrow();
    await expect(
      fs.access(join(homeDir, '.claude', 'sop', 'abc123def456')),
    ).rejects.toThrow();
  });

  it('--json mode skips prompt and emits JSON', async () => {
    await seedCaptures();

    const program = makeProgram();
    await program.parseAsync([
      'node', 'claude-sop', '--json', 'purge', '--project', projectRoot,
    ]);

    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.verb).toBe('purge');
    expect(parsed.removed).toHaveLength(2);
  });

  it('handles already-absent dirs gracefully with --yes', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node', 'claude-sop', 'purge', '--yes', '--project', projectRoot,
    ]);

    const output = stdoutChunks.join('');
    expect(output).toContain('captures purged');
  });
});

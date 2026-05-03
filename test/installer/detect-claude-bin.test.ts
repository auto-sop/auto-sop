/**
 * Unit tests for detectClaudeBinDir (src/installer/orchestrator.ts)
 *
 * Covers:
 * - `which claude` succeeds → returns dirname of resolved path
 * - `which claude` fails, first candidate exists → returns dirname of that candidate
 * - `which claude` fails, no candidates exist → returns undefined
 * - `which claude` returns empty string → falls through to candidates
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

// We need to mock execSync and statSync BEFORE importing the module.
// Use vi.mock to intercept the calls.

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
  };
});

// Import after mocks are set up
const { detectClaudeBinDir } = await import('../../src/installer/orchestrator.js');

const mockExecSync = vi.mocked(childProcess.execSync);
const mockStatSync = vi.mocked(fs.statSync);

describe('detectClaudeBinDir', () => {
  const homeDir = '/home/testuser';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns dirname when `which claude` succeeds', () => {
    mockExecSync.mockReturnValueOnce('/usr/local/bin/claude\n');

    const result = detectClaudeBinDir(homeDir);
    expect(result).toBe('/usr/local/bin');
  });

  it('returns dirname when `which claude` returns path without trailing newline', () => {
    mockExecSync.mockReturnValueOnce('/opt/bin/claude');

    const result = detectClaudeBinDir(homeDir);
    expect(result).toBe('/opt/bin');
  });

  it('falls through to candidates when `which` returns empty string', () => {
    // which returns empty
    mockExecSync.mockReturnValueOnce('');
    // First candidate: $HOME/.local/bin/claude — not found
    const localCandidate = path.join(homeDir, '.local', 'bin', 'claude');
    const usrLocalCandidate = path.join('/usr/local/bin', 'claude');
    mockStatSync.mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr === localCandidate) {
        throw new Error('ENOENT');
      }
      if (pathStr === usrLocalCandidate) {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error('ENOENT');
    });

    const result = detectClaudeBinDir(homeDir);
    expect(result).toBe(path.dirname(usrLocalCandidate));
  });

  it('returns first candidate dirname when `which` fails and candidate file exists', () => {
    // which throws
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('which: claude: not found');
    });
    // First candidate exists — use path.join to match what source code constructs
    const firstCandidate = path.join(homeDir, '.local', 'bin', 'claude');
    mockStatSync.mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr === firstCandidate) {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error('ENOENT');
    });

    const result = detectClaudeBinDir(homeDir);
    expect(result).toBe(path.join(homeDir, '.local', 'bin'));
  });

  it('tries subsequent candidates when first does not exist', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('which: claude: not found');
    });
    // First two candidates don't exist, third (.cargo) does — use path.join
    const cargoCandidate = path.join(homeDir, '.cargo', 'bin', 'claude');
    mockStatSync.mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr === cargoCandidate) {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error('ENOENT');
    });

    const result = detectClaudeBinDir(homeDir);
    expect(result).toBe(path.join(homeDir, '.cargo', 'bin'));
  });

  it('returns undefined when `which` fails and no candidates exist', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('which: claude: not found');
    });
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = detectClaudeBinDir(homeDir);
    expect(result).toBeUndefined();
  });
});

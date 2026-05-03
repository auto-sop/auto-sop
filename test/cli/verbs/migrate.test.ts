import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isWindows } from '../../setup/platform.js';
import { runCli } from '../../../src/cli/main.js';

// Mock node:fs promises
const mockStat = vi.fn();
const mockAccess = vi.fn();
const mockRename = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockRm = vi.fn();

vi.mock('node:fs', () => ({
  promises: {
    stat: (...args: unknown[]) => mockStat(...args),
    access: (...args: unknown[]) => mockAccess(...args),
    rename: (...args: unknown[]) => mockRename(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    rm: (...args: unknown[]) => mockRm(...args),
  },
  readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: '0.0.18' })),
}));

// Mock node:os
vi.mock('node:os', () => ({
  default: { homedir: () => '/mock-home' },
  homedir: () => '/mock-home',
}));

// Mock execa (used for launchctl)
vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0 }),
}));

// Mock picocolors to return plain strings
vi.mock('picocolors', () => ({
  default: {
    green: (s: string) => s,
    yellow: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    red: (s: string) => s,
  },
}));

// Mock PathResolver (used by other verbs during registration)
vi.mock('../../../src/path-resolver/index.js', () => ({
  PathResolver: class MockPathResolver {
    async resolve() {
      return { identity: { projectId: 'abc123', slug: 'test' } };
    }
  },
}));

// Mock scheduler (used by other verbs)
vi.mock('../../../src/scheduler/index.js', () => ({
  pickBackend: vi.fn().mockResolvedValue({
    backend: { name: 'launchd', install: vi.fn(), uninstall: vi.fn(), status: vi.fn() },
  }),
}));

// Helpers to configure filesystem mock state
function setupFs(opts: { dirsExist?: string[]; filesExist?: Record<string, string> }) {
  const dirs = new Set(opts.dirsExist ?? []);
  const files = opts.filesExist ?? {};

  mockStat.mockImplementation((p: string) => {
    if (dirs.has(p)) return Promise.resolve({ isDirectory: () => true });
    return Promise.reject(new Error('ENOENT'));
  });

  mockAccess.mockImplementation((p: string) => {
    if (p in files) return Promise.resolve();
    return Promise.reject(new Error('ENOENT'));
  });

  mockReadFile.mockImplementation((p: string) => {
    if (p in files) return Promise.resolve(files[p]);
    return Promise.reject(new Error('ENOENT'));
  });

  mockRename.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
}

describe.skipIf(isWindows)('migrate verb', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let originalPlatform: PropertyDescriptor | undefined;

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
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    vi.clearAllMocks();
  });

  it('fresh install — no old dir exists — exits cleanly with no-op', async () => {
    // Neither ~/.claude-sop/ nor ~/.auto-sop/ exist
    setupFs({ dirsExist: [], filesExist: {} });

    const code = await runCli(['node', 'auto-sop', 'migrate', '--json']);
    expect(code).toBe(0);

    const output = JSON.parse(stdoutChunks.join(''));
    expect(output.ok).toBe(true);
    expect(output.verb).toBe('migrate');

    const homeStep = output.steps.find((s: { step: string }) => s.step === 'move-home');
    expect(homeStep).toBeDefined();
    expect(homeStep.outcome).toBe('skipped');
    expect(homeStep.detail).toContain('no ~/.claude-sop/');
  });

  it('migration needed — old dir exists, new does not — moves correctly', async () => {
    setupFs({
      dirsExist: ['/mock-home/.claude-sop'],
      filesExist: {},
    });

    const code = await runCli(['node', 'auto-sop', 'migrate', '--json']);
    expect(code).toBe(0);

    expect(mockRename).toHaveBeenCalledWith('/mock-home/.claude-sop', '/mock-home/.auto-sop');

    const output = JSON.parse(stdoutChunks.join(''));
    const homeStep = output.steps.find((s: { step: string }) => s.step === 'move-home');
    expect(homeStep.outcome).toBe('ok');
    expect(homeStep.detail).toContain('moved');
  });

  it('already migrated — new dir exists, old does not — reports already migrated', async () => {
    setupFs({
      dirsExist: ['/mock-home/.auto-sop'],
      filesExist: {},
    });

    const code = await runCli(['node', 'auto-sop', 'migrate', '--json']);
    expect(code).toBe(0);

    const output = JSON.parse(stdoutChunks.join(''));
    const homeStep = output.steps.find((s: { step: string }) => s.step === 'move-home');
    expect(homeStep.outcome).toBe('skipped');
    expect(homeStep.detail).toContain('already');
  });

  it('both dirs exist — warns user, does NOT destroy new dir', async () => {
    setupFs({
      dirsExist: ['/mock-home/.claude-sop', '/mock-home/.auto-sop'],
      filesExist: {},
    });

    const code = await runCli(['node', 'auto-sop', 'migrate', '--json']);
    expect(code).toBe(0);

    // rename should NOT have been called — don't overwrite
    expect(mockRename).not.toHaveBeenCalled();

    const output = JSON.parse(stdoutChunks.join(''));
    const homeStep = output.steps.find((s: { step: string }) => s.step === 'move-home');
    expect(homeStep.outcome).toBe('warning');
    expect(homeStep.detail).toContain('both');
    expect(homeStep.detail).toContain('manually');
  });

  it('idempotency — running migrate twice on fresh install produces same result', async () => {
    setupFs({ dirsExist: [], filesExist: {} });

    const code1 = await runCli(['node', 'auto-sop', 'migrate', '--json']);
    const out1 = JSON.parse(stdoutChunks.join(''));
    stdoutChunks.length = 0;

    const code2 = await runCli(['node', 'auto-sop', 'migrate', '--json']);
    const out2 = JSON.parse(stdoutChunks.join(''));

    expect(code1).toBe(code2);
    expect(out1.ok).toBe(out2.ok);
    expect(out1.steps.length).toBe(out2.steps.length);
  });

  it('dry-run does not perform any mutations', async () => {
    setupFs({
      dirsExist: ['/mock-home/.claude-sop'],
      filesExist: {},
    });

    const code = await runCli(['node', 'auto-sop', 'migrate', '--dry-run', '--json']);
    expect(code).toBe(0);

    // No fs mutations should happen
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();

    const output = JSON.parse(stdoutChunks.join(''));
    expect(output.dryRun).toBe(true);
    const homeStep = output.steps.find((s: { step: string }) => s.step === 'move-home');
    expect(homeStep.outcome).toBe('ok');
    expect(homeStep.detail).toContain('would move');
  });

  it('project settings.json hook path rewrite (mocked)', async () => {
    const cwd = process.cwd();
    const settingsPath = `${cwd}/.claude/settings.json`;
    const oldSettings = JSON.stringify({
      hooks: { command: 'npx claude-sop capture' },
    });

    setupFs({
      dirsExist: [],
      filesExist: { [settingsPath]: oldSettings },
    });

    const code = await runCli(['node', 'auto-sop', 'migrate', '--json', '--project', cwd]);
    expect(code).toBe(0);

    // Should have written updated settings
    expect(mockWriteFile).toHaveBeenCalledWith(
      settingsPath,
      expect.stringContaining('auto-sop'),
      'utf8',
    );

    // The updated content should not contain claude-sop
    const writtenContent = mockWriteFile.mock.calls.find(
      (c: unknown[]) => c[0] === settingsPath,
    )?.[1] as string;
    expect(writtenContent).not.toContain('claude-sop');
    expect(writtenContent).toContain('auto-sop');
  });

  it('launchd plist removal on macOS (mocked)', async () => {
    // Force platform to darwin
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    const oldPlist = '/mock-home/Library/LaunchAgents/com.claude-sop.learner.plist';

    setupFs({
      dirsExist: [],
      filesExist: { [oldPlist]: '<plist>old</plist>' },
    });

    // Also mock access for the plist file check
    mockAccess.mockImplementation((p: string) => {
      if (p === oldPlist) return Promise.resolve();
      return Promise.reject(new Error('ENOENT'));
    });

    const code = await runCli(['node', 'auto-sop', 'migrate', '--json']);
    expect(code).toBe(0);

    // Should have removed the old plist
    expect(mockRm).toHaveBeenCalledWith(oldPlist, { force: true });

    const output = JSON.parse(stdoutChunks.join(''));
    const plistStep = output.steps.find((s: { step: string }) => s.step === 'launchd-plist');
    expect(plistStep).toBeDefined();
    expect(plistStep.outcome).toBe('ok');
    expect(plistStep.detail).toContain('removed old plist');
  });

  it('text output mode (non-JSON) completes without error', async () => {
    setupFs({ dirsExist: [], filesExist: {} });

    const code = await runCli(['node', 'auto-sop', 'migrate']);
    expect(code).toBe(0);

    const out = stdoutChunks.join('');
    expect(out).toContain('auto-sop migrate');
    expect(out).toContain('Migration complete');
  });
});

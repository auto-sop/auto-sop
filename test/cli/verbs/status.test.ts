import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCli } from '../../../src/cli/main.js';
import type { StatusReport } from '../../../src/status/collector.js';

// Mock collectStatus
vi.mock('../../../src/status/collector.js', () => ({
  collectStatus: vi.fn(),
}));

// Mock environment config — default to production
vi.mock('../../../src/config/environment.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/config/environment.js')>();
  return {
    ...original,
    APP_BASE_URL: 'https://auto-sop.com',
    ENVIRONMENT: 'production',
  };
});

// Mock PathResolver
vi.mock('../../../src/path-resolver/index.js', () => ({
  PathResolver: class MockPathResolver {
    async resolve() {
      return {
        identity: { projectId: 'abc123def456', slug: 'test-proj' },
      };
    }
  },
}));

// Mock pickBackend
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

import { collectStatus } from '../../../src/status/collector.js';

const mockCollectStatus = vi.mocked(collectStatus);

function cannedReport(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    project: { root: '/tmp/proj', hash12: 'abc123def456', slug: 'test-proj' },
    installedVersion: '2.0.0',
    hooks: {
      wiringState: 'present',
      eventsCovered: ['UserPromptSubmit', 'Stop', 'SubagentStop', 'PreToolUse', 'PostToolUse'],
      settingsPath: '/tmp/proj/.claude/settings.json',
    },
    scheduler: {
      backend: 'launchd',
      installed: true,
      lastTickAt: 1700000000000,
      lastExitCode: 0,
      details: {},
    },
    learner: { lastRunAt: null, lastExitCode: null },
    pendingCaptures: 5,
    directives: { count: 3, sectionPresent: true },
    license: { status: 'dev-key', daysRemaining: null },
    serverValidation: {
      lastValidated: new Date(Date.now() - 2 * 3600_000).toISOString(),
      graceRemaining: null,
      isOnline: true,
      plan: 'free',
      maxProjects: 1,
      boundProjects: 1,
    },
    binding: {
      exists: true,
      valid: true,
      tokenPreview: 'a1b2c3d4…',
    },
    errors: { last24h: 2 },
    disk: { usageBytes: 1536, capBytes: null },
    paused: false,
    ...overrides,
  };
}

describe('status verb', () => {
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

  it('human output contains all row labels', async () => {
    mockCollectStatus.mockResolvedValueOnce(cannedReport());

    const code = await runCli(['node', 'auto-sop', 'status', '--project', '/tmp/proj']);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toContain('auto-sop status');
    expect(output).toContain('project root');
    expect(output).toContain('project hash');
    expect(output).toContain('project slug');
    expect(output).toContain('installed version');
    expect(output).toContain('hooks');
    expect(output).toContain('scheduler');
    expect(output).toContain('last tick');
    expect(output).toContain('last learner run');
    expect(output).toContain('pending captures');
    expect(output).toContain('directives');
    expect(output).toContain('license');
    expect(output).toContain('errors (24h)');
    expect(output).toContain('disk usage');
    expect(output).toContain('paused');
    expect(output).toContain('environment');
  });

  it('--json mode emits stable JSON with all top-level fields', async () => {
    mockCollectStatus.mockResolvedValueOnce(cannedReport());

    const code = await runCli(['node', 'auto-sop', '--json', 'status', '--project', '/tmp/proj']);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.verb).toBe('status');
    expect(parsed.project).toBeDefined();
    expect(parsed.installedVersion).toBe('2.0.0');
    expect(parsed.hooks).toBeDefined();
    expect(parsed.scheduler).toBeDefined();
    expect(parsed.learner).toBeDefined();
    expect(parsed.pendingCaptures).toBe(5);
    expect(parsed.directives).toBeDefined();
    expect(parsed.license).toBeDefined();
    expect(parsed.errors).toBeDefined();
    expect(parsed.disk).toBeDefined();
    expect(parsed.paused).toBe(false);
  });

  it('stale hooks shows stale in human output', async () => {
    mockCollectStatus.mockResolvedValueOnce(
      cannedReport({
        hooks: {
          wiringState: 'stale',
          eventsCovered: ['UserPromptSubmit'],
          settingsPath: '/tmp/proj/.claude/settings.json',
        },
      }),
    );

    const code = await runCli(['node', 'auto-sop', 'status', '--project', '/tmp/proj']);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toContain('stale');
    expect(output).toContain('1/5 events');
  });

  it('not installed shows (not installed) in human output', async () => {
    mockCollectStatus.mockResolvedValueOnce(cannedReport({ installedVersion: null }));

    const code = await runCli(['node', 'auto-sop', 'status', '--project', '/tmp/proj']);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toContain('(not installed)');
  });

  it('environment row shows production by default', async () => {
    mockCollectStatus.mockResolvedValueOnce(cannedReport());

    const code = await runCli(['node', 'auto-sop', 'status', '--project', '/tmp/proj']);

    expect(code).toBe(0);
    const output = stdoutChunks.join('');
    expect(output).toContain('environment');
    expect(output).toContain('production (auto-sop.com)');
  });

  it('environment row shows staging when ENVIRONMENT is staging', async () => {
    // Override the ENVIRONMENT and APP_BASE_URL mocks for this test
    const envModule = await import('../../../src/config/environment.js');
    Object.defineProperty(envModule, 'ENVIRONMENT', { value: 'staging', writable: true, configurable: true });
    Object.defineProperty(envModule, 'APP_BASE_URL', { value: 'https://staging.auto-sop.com', writable: true, configurable: true });
    try {
      mockCollectStatus.mockResolvedValueOnce(cannedReport());

      const code = await runCli(['node', 'auto-sop', 'status', '--project', '/tmp/proj']);

      expect(code).toBe(0);
      const output = stdoutChunks.join('');
      expect(output).toContain('environment');
      expect(output).toContain('staging (staging.auto-sop.com)');
    } finally {
      Object.defineProperty(envModule, 'ENVIRONMENT', { value: 'production', writable: true, configurable: true });
      Object.defineProperty(envModule, 'APP_BASE_URL', { value: 'https://auto-sop.com', writable: true, configurable: true });
    }
  });
});

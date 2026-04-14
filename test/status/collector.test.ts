import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { collectStatus, type CollectOptions, type StatusReport } from '../../src/status/collector.js';
import { HOOK_EVENTS, CLAUDE_SOP_HOOK_ID } from '../../src/installer/hook-entries.js';
import { MANAGED_BEGIN, MANAGED_END } from '../../src/installer/managed-section.js';
import type { SchedulerBackend, SchedulerStatus } from '../../src/scheduler/types.js';

// Mock license modules since they depend on crypto
vi.mock('../../src/license/storage.js', () => ({
  readSecrets: vi.fn(),
}));
vi.mock('../../src/license/trial.js', () => ({
  trialStatus: vi.fn(),
  TRIAL_DURATION_DAYS: 14,
}));

import { readSecrets } from '../../src/license/storage.js';
import { trialStatus } from '../../src/license/trial.js';

const mockReadSecrets = vi.mocked(readSecrets);
const mockTrialStatus = vi.mocked(trialStatus);

let tmpDir: string;
let homeDir: string;
let projectRoot: string;

async function mkdirSafe(p: string) {
  await fs.mkdir(p, { recursive: true });
}

function baseOpts(overrides: Partial<CollectOptions> = {}): CollectOptions {
  return {
    projectRoot,
    homeDir,
    projectHash12: 'abc123def456',
    projectSlug: 'test-project',
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-test-'));
  homeDir = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'project');
  await mkdirSafe(homeDir);
  await mkdirSafe(projectRoot);
  mockReadSecrets.mockResolvedValue(null);
  mockTrialStatus.mockReturnValue({
    status: 'trial',
    daysRemaining: 10,
    startedAt: Date.now(),
    durationDays: 14,
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('collectStatus', () => {
  it('fresh project (nothing installed) returns defaults', async () => {
    const report = await collectStatus(baseOpts());

    expect(report.project.root).toBe(projectRoot);
    expect(report.project.hash12).toBe('abc123def456');
    expect(report.project.slug).toBe('test-project');
    expect(report.installedVersion).toBeNull();
    expect(report.hooks.wiringState).toBe('absent');
    expect(report.hooks.eventsCovered).toEqual([]);
    expect(report.license.status).toBe('none');
    expect(report.license.daysRemaining).toBeNull();
    expect(report.pendingCaptures).toBe(0);
    expect(report.errors.last24h).toBe(0);
    expect(report.paused).toBe(false);
    expect(report.directives.count).toBe(0);
    expect(report.learner.lastRunAt).toBeNull();
    expect(report.learner.lastExitCode).toBeNull();
    expect(report.disk.usageBytes).toBe(0);
    expect(report.disk.capBytes).toBeNull();
  });

  it('fully installed project returns correct state', async () => {
    // version.txt
    const claudeSopHome = path.join(homeDir, '.claude-sop');
    await mkdirSafe(claudeSopHome);
    await fs.writeFile(path.join(claudeSopHome, 'version.txt'), '2.0.1\n');

    // settings.json with all 5 hooks
    const claudeDir = path.join(projectRoot, '.claude');
    await mkdirSafe(claudeDir);
    const hooks: Record<string, unknown[]> = {};
    for (const ev of HOOK_EVENTS) {
      hooks[ev] = [{ hooks: [{ type: 'command', command: 'test', timeout: 10, id: CLAUDE_SOP_HOOK_ID }] }];
    }
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks }),
    );

    // CLAUDE.md with managed section
    await fs.writeFile(
      path.join(projectRoot, 'CLAUDE.md'),
      `# Project\n${MANAGED_BEGIN}\n- directive one\n- directive two\n${MANAGED_END}\n`,
    );

    // License: dev-key
    mockReadSecrets.mockResolvedValue({
      schema_version: 1,
      license: { key: 'dev-xxx', kind: 'dev', captured_at: Date.now() },
      trial: { started_at: Date.now(), duration_days: 14 },
      install: { version: '2.0.1', installed_at: Date.now(), machine_id_prefix: '12345678' },
    });
    mockTrialStatus.mockReturnValue({
      status: 'dev-key',
      daysRemaining: Infinity,
      startedAt: Date.now(),
      durationDays: 14,
    });

    const report = await collectStatus(baseOpts());

    expect(report.installedVersion).toBe('2.0.1');
    expect(report.hooks.wiringState).toBe('present');
    expect(report.hooks.eventsCovered).toHaveLength(5);
    expect(report.license.status).toBe('dev-key');
    expect(report.license.daysRemaining).toBeNull(); // Infinity → null
    expect(report.directives.count).toBe(2);
    expect(report.paused).toBe(false);
  });

  it('stale hooks: only one event has our hook', async () => {
    const claudeDir = path.join(projectRoot, '.claude');
    await mkdirSafe(claudeDir);
    const hooks: Record<string, unknown[]> = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'test', timeout: 10, id: CLAUDE_SOP_HOOK_ID }] }],
    };
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ hooks }),
    );

    const report = await collectStatus(baseOpts());

    expect(report.hooks.wiringState).toBe('stale');
    expect(report.hooks.eventsCovered).toEqual(['UserPromptSubmit']);
  });

  it('paused flag present → paused: true', async () => {
    const sopDir = path.join(projectRoot, '.claude-sop');
    await mkdirSafe(sopDir);
    await fs.writeFile(path.join(sopDir, 'paused.flag'), '');

    const report = await collectStatus(baseOpts());

    expect(report.paused).toBe(true);
  });

  it('directive count matches managed section content', async () => {
    await fs.writeFile(
      path.join(projectRoot, 'CLAUDE.md'),
      `${MANAGED_BEGIN}\n- directive one\n- directive two\n- directive three\n${MANAGED_END}\n`,
    );

    const report = await collectStatus(baseOpts());

    expect(report.directives.count).toBe(3);
  });

  it('errors.jsonl with mixed timestamps → counts only last 24h', async () => {
    const sopDir = path.join(projectRoot, '.claude-sop');
    await mkdirSafe(sopDir);

    const now = Date.now();
    const recent = now - 3600 * 1000; // 1h ago
    const old = now - 48 * 3600 * 1000; // 48h ago

    const lines = [
      JSON.stringify({ ts: recent, msg: 'err1' }),
      JSON.stringify({ ts: recent + 100, msg: 'err2' }),
      JSON.stringify({ ts: recent + 200, msg: 'err3' }),
      JSON.stringify({ ts: old, msg: 'old1' }),
      JSON.stringify({ ts: old + 100, msg: 'old2' }),
    ].join('\n');

    await fs.writeFile(path.join(sopDir, 'errors.jsonl'), lines);

    const report = await collectStatus(baseOpts());

    expect(report.errors.last24h).toBe(3);
  });

  it('disk usage sums file sizes in captures dir', async () => {
    const capturesDir = path.join(projectRoot, '.claude-sop', 'captures');
    await mkdirSafe(capturesDir);

    await fs.writeFile(path.join(capturesDir, 'a.json'), 'x'.repeat(100));
    await fs.writeFile(path.join(capturesDir, 'b.json'), 'y'.repeat(200));

    const report = await collectStatus(baseOpts());

    expect(report.disk.usageBytes).toBe(300);
    expect(report.disk.capBytes).toBeNull();
  });

  it('expired license returns correct status and negative daysRemaining', async () => {
    const claudeSopHome = path.join(homeDir, '.claude-sop');
    await mkdirSafe(claudeSopHome);

    const payload = {
      schema_version: 1 as const,
      license: { key: 'user-xxx', kind: 'user' as const, captured_at: Date.now() },
      trial: { started_at: Date.now() - 15 * 24 * 3600 * 1000, duration_days: 14 },
      install: { version: '1.0.0', installed_at: Date.now(), machine_id_prefix: '12345678' },
    };
    mockReadSecrets.mockResolvedValue(payload);
    mockTrialStatus.mockReturnValue({
      status: 'expired',
      daysRemaining: -1,
      startedAt: payload.trial.started_at,
      durationDays: 14,
    });

    const report = await collectStatus(baseOpts());

    expect(report.license.status).toBe('expired');
    expect(report.license.daysRemaining).toBe(-1);
  });

  it('stub schedulerBackend.status() is passed through', async () => {
    const stubStatus: SchedulerStatus = {
      backend: 'launchd',
      installed: true,
      lastTickAt: 1234567890,
      lastExitCode: 0,
      details: { plistPath: '/foo/bar' },
    };
    const mockBackend: SchedulerBackend = {
      name: 'launchd',
      install: vi.fn(),
      uninstall: vi.fn(),
      status: vi.fn().mockResolvedValue(stubStatus),
    };

    const report = await collectStatus(baseOpts({ schedulerBackend: mockBackend }));

    expect(report.scheduler).toEqual(stubStatus);
    expect(mockBackend.status).toHaveBeenCalledTimes(1);
  });

  it('no scheduler backend → returns none defaults', async () => {
    const report = await collectStatus(baseOpts());

    expect(report.scheduler.backend).toBe('none');
    expect(report.scheduler.installed).toBe(false);
    expect(report.scheduler.lastTickAt).toBeNull();
    expect(report.scheduler.lastExitCode).toBeNull();
  });

  it('pending captures counts all entries when learner never ran', async () => {
    const capturesDir = path.join(projectRoot, '.claude-sop', 'captures');
    await mkdirSafe(capturesDir);
    await fs.writeFile(path.join(capturesDir, 'cap1.json'), '{}');
    await fs.writeFile(path.join(capturesDir, 'cap2.json'), '{}');
    await fs.writeFile(path.join(capturesDir, 'cap3.json'), '{}');

    const report = await collectStatus(baseOpts());

    expect(report.pendingCaptures).toBe(3);
  });
});

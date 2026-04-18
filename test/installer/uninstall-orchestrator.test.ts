import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  runUninstall,
  type UninstallOptions,
} from '../../src/installer/uninstall-orchestrator.js';
import {
  MANAGED_BEGIN,
  MANAGED_END,
} from '../../src/installer/managed-section.js';
import { CLAUDE_SOP_HOOK_ID } from '../../src/installer/hook-entries.js';
import type { SchedulerBackend } from '../../src/scheduler/types.js';

function stubBackend(
  overrides: Partial<SchedulerBackend> = {},
): SchedulerBackend {
  return {
    name: 'launchd',
    install: async () => {},
    uninstall: async () => ({ warnings: [] }),
    status: async () => ({
      backend: 'launchd',
      installed: false,
      lastTickAt: null,
      lastExitCode: null,
      details: {},
    }),
    ...overrides,
  };
}

function settingsWithClaudeSopHooks(extraUserHook = false): string {
  const hooks: Record<string, unknown[]> = {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: '/path/to/tick.sh',
            timeout: 10,
            id: CLAUDE_SOP_HOOK_ID,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: '/path/to/tick.sh',
            timeout: 10,
            id: CLAUDE_SOP_HOOK_ID,
          },
        ],
      },
    ],
  };
  if (extraUserHook) {
    (hooks.UserPromptSubmit as unknown[]).unshift({
      hooks: [
        { type: 'command', command: '/usr/bin/my-hook', timeout: 5, id: 'my-custom' },
      ],
    });
  }
  return JSON.stringify({ hooks }, null, 2);
}

function settingsWithOnlyUserHooks(): string {
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: '/usr/bin/user-hook',
                timeout: 5,
                id: 'user-hook',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
}

describe('runUninstall', () => {
  let testDir: string;
  let homeDir: string;
  let projectRoot: string;
  const projectHash12 = 'abc123def456';
  const fixedNow = 1700000000000;

  beforeEach(async () => {
    testDir = join(tmpdir(), `uninstall-test-${nanoid(10)}`);
    homeDir = join(testDir, 'home');
    projectRoot = join(testDir, 'project');
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function baseOpts(
    overrides: Partial<UninstallOptions> = {},
  ): UninstallOptions {
    return {
      projectRoot,
      homeDir,
      purge: false,
      projectHash12,
      schedulerBackend: stubBackend(),
      now: fixedNow,
      ...overrides,
    };
  }

  /** Seed a full install fixture. */
  async function seedInstall(): Promise<void> {
    // settings.json with claude-sop hooks + a user hook
    const settingsDir = join(projectRoot, '.claude');
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      join(settingsDir, 'settings.json'),
      settingsWithClaudeSopHooks(true),
    );

    // CLAUDE.md with managed section
    const managedContent = '\nsome managed rules\n';
    await fs.writeFile(
      join(projectRoot, 'CLAUDE.md'),
      `# User rules\n\n${MANAGED_BEGIN}${managedContent}${MANAGED_END}\n\nMore user content\n`,
    );

    // tick.sh
    const binDir = join(homeDir, '.claude-sop', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(join(binDir, 'tick.sh'), '#!/bin/sh\nexec node');

    // secrets.enc
    await fs.writeFile(join(homeDir, '.claude-sop', 'secrets.enc'), 'enc');

    // version.txt
    await fs.writeFile(
      join(homeDir, '.claude-sop', 'version.txt'),
      '1.0.0',
    );

    // marketplace bundle
    const mktDir = join(homeDir, '.claude-sop', 'marketplace', 'claude-sop');
    await fs.mkdir(mktDir, { recursive: true });
    await fs.writeFile(join(mktDir, 'plugin.json'), '{}');

    // captures
    const captDir = join(projectRoot, '.claude-sop', 'captures');
    await fs.mkdir(captDir, { recursive: true });
    await fs.writeFile(join(captDir, 'turn-1.json'), '{}');

    // global sop dir
    const sopDir = join(homeDir, '.claude', 'sop', projectHash12);
    await fs.mkdir(sopDir, { recursive: true });
    await fs.writeFile(join(sopDir, 'state.json'), '{}');
  }

  it('full uninstall (no purge) — all non-purge steps report ok', async () => {
    await seedInstall();
    const result = await runUninstall(baseOpts());

    // All 10 non-purge steps should be ok (8 original + 1 deregister-project + 1 defensive-directive-backup)
    expect(result.warnings).toHaveLength(0);
    const outcomes = result.steps.map((s) => s.outcome);
    expect(outcomes).toEqual(Array(10).fill('ok'));

    // settings.json no longer has claude-sop entries
    const settings = JSON.parse(
      await fs.readFile(
        join(projectRoot, '.claude', 'settings.json'),
        'utf8',
      ),
    );
    // User hook still present
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].id).toBe('my-custom');
    // claude-sop hooks stripped
    expect(settings.hooks.Stop).toBeUndefined();

    // CLAUDE.md has no markers; user content preserved
    const claudeMd = await fs.readFile(
      join(projectRoot, 'CLAUDE.md'),
      'utf8',
    );
    expect(claudeMd).not.toContain(MANAGED_BEGIN);
    expect(claudeMd).not.toContain(MANAGED_END);
    expect(claudeMd).toContain('# User rules');
    expect(claudeMd).toContain('More user content');

    // tick.sh, secrets.enc, version.txt, marketplace bundle gone
    await expect(
      fs.access(join(homeDir, '.claude-sop', 'bin', 'tick.sh')),
    ).rejects.toThrow();
    await expect(
      fs.access(join(homeDir, '.claude-sop', 'secrets.enc')),
    ).rejects.toThrow();
    await expect(
      fs.access(join(homeDir, '.claude-sop', 'version.txt')),
    ).rejects.toThrow();
    await expect(
      fs.access(
        join(homeDir, '.claude-sop', 'marketplace', 'claude-sop', 'plugin.json'),
      ),
    ).rejects.toThrow();

    // Captures preserved (not purged)
    const captFile = await fs.readFile(
      join(projectRoot, '.claude-sop', 'captures', 'turn-1.json'),
      'utf8',
    );
    expect(captFile).toBe('{}');

    // Global sop dir preserved
    const sopState = await fs.readFile(
      join(homeDir, '.claude', 'sop', projectHash12, 'state.json'),
      'utf8',
    );
    expect(sopState).toBe('{}');

    // Backup path set
    expect(result.backupPath).toBe(
      join(
        homeDir,
        '.claude',
        'sop',
        projectHash12,
        'managed-history',
        `uninstall-${fixedNow}.md`,
      ),
    );
    const backupContent = await fs.readFile(result.backupPath!, 'utf8');
    expect(backupContent).toContain('some managed rules');
  });

  it('--purge wipes captures and global sop dir', async () => {
    await seedInstall();
    const result = await runUninstall(baseOpts({ purge: true }));

    expect(result.warnings).toHaveLength(0);
    // 10 base steps + 2 purge steps = 12
    expect(result.steps).toHaveLength(12);

    // Captures wiped
    await expect(
      fs.access(join(projectRoot, '.claude-sop', 'captures')),
    ).rejects.toThrow();

    // Global sop dir wiped (including backup — --purge implies nuke everything)
    await expect(
      fs.access(join(homeDir, '.claude', 'sop', projectHash12)),
    ).rejects.toThrow();
  });

  it('scheduler uninstall with warnings — warnings collected, step still ok', async () => {
    await seedInstall();
    const backend = stubBackend({
      uninstall: async () => ({ warnings: ['plist not loaded'] }),
    });
    const result = await runUninstall(
      baseOpts({ schedulerBackend: backend }),
    );

    // The scheduler step itself is 'ok' (the backend returned, didn't throw)
    const schedulerStep = result.steps.find(
      (s) => s.step === 'scheduler-uninstall',
    );
    expect(schedulerStep?.outcome).toBe('ok');
    // But the warning is collected
    expect(result.warnings).toContain('scheduler: plist not loaded');
  });

  it('scheduler uninstall throws — step marked warning, continues', async () => {
    await seedInstall();
    const backend = stubBackend({
      uninstall: async () => {
        throw new Error('launchctl failed');
      },
    });
    const result = await runUninstall(
      baseOpts({ schedulerBackend: backend }),
    );

    const schedulerStep = result.steps.find(
      (s) => s.step === 'scheduler-uninstall',
    );
    expect(schedulerStep?.outcome).toBe('warning');
    expect(result.warnings.some((w) => w.includes('launchctl failed'))).toBe(
      true,
    );

    // Other steps still executed
    expect(result.steps.length).toBeGreaterThanOrEqual(8);
    const tickStep = result.steps.find(
      (s) => s.step === 'remove-tick-script',
    );
    expect(tickStep?.outcome).toBe('ok');
  });

  it('missing files — every step ok, nothing throws', async () => {
    // Run on empty project/home — nothing installed
    const result = await runUninstall(baseOpts());

    expect(result.warnings).toHaveLength(0);
    for (const s of result.steps) {
      expect(s.outcome).toBe('ok');
    }
    expect(result.backupPath).toBeNull();
  });

  it('settings.json with only user hooks — file unchanged byte-for-byte', async () => {
    const settingsDir = join(projectRoot, '.claude');
    await fs.mkdir(settingsDir, { recursive: true });
    const original = settingsWithOnlyUserHooks();
    await fs.writeFile(join(settingsDir, 'settings.json'), original);

    const originalHash = createHash('sha256').update(original).digest('hex');

    const result = await runUninstall(baseOpts());

    const afterText = await fs.readFile(
      join(settingsDir, 'settings.json'),
      'utf8',
    );
    const afterHash = createHash('sha256').update(afterText).digest('hex');
    expect(afterHash).toBe(originalHash);

    const hookStep = result.steps.find(
      (s) => s.step === 'strip-project-hooks',
    );
    expect(hookStep?.outcome).toBe('ok');
  });
});

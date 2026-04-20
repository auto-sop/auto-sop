/**
 * Phase 2 end-to-end integration test.
 *
 * Simulates the full lifecycle: install → status → pause → resume → uninstall.
 * Uses a temp HOME + temp project with a stubbed scheduler backend so that
 * ZERO real OS subprocess calls (launchctl/systemctl/crontab) happen.
 *
 * ┌────────────┬──────────────────────────────────────────────────────────────┐
 * │ Req ID     │ Assertion                                                  │
 * ├────────────┼──────────────────────────────────────────────────────────────┤
 * │ INST-01    │ install wires hooks, creates secrets.enc, copies bundle    │
 * │ INST-02    │ re-install is idempotent (byte-identical settings.json)    │
 * │ INST-03    │ install preserves pre-existing user hooks                  │
 * │ INST-04    │ install appends .auto-sop/ to .gitignore                 │
 * │ INST-05    │ CLAUDE.md has managed-section markers                      │
 * │ INST-06    │ uninstall removes hooks, scheduler, secrets; --purge caps  │
 * │ SCHED-01   │ scheduler.install called with absolute tick.sh path        │
 * │ SCHED-03   │ tick.sh exists, executable, NO flock                       │
 * │ SCHED-04   │ scheduler interval is 3600s                                │
 * │ SCHED-05   │ tick.sh is pure POSIX sh, sets CLAUDE_SOP_CAPTURE_SUPPRESS │
 * │ PRIV-06    │ --purge wipes captures                                     │
 * │ CLI-01     │ status returns all I3 fields after install                 │
 * │ CLI-05     │ pause/resume toggle paused.flag and status reflects it     │
 * │ LIC-01     │ secrets.enc schema v1 with trial.started_at               │
 * │ LIC-02     │ re-install preserves trial.started_at                      │
 * │ G1         │ npm install path never sets enabledPlugins                 │
 * │ G3         │ downgrade is refused                                       │
 * └────────────┴──────────────────────────────────────────────────────────────┘
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'jsonc-parser';
import { makeTempHome, seedPluginBundleFixture, stubSchedulerBackend } from './helpers.js';
import { runInstall } from '../../src/installer/orchestrator.js';
import { runUninstall } from '../../src/installer/uninstall-orchestrator.js';
import { collectStatus } from '../../src/status/collector.js';
import { HOOK_EVENTS, CLAUDE_SOP_HOOK_ID } from '../../src/installer/hook-entries.js';
import { MANAGED_BEGIN, MANAGED_END } from '../../src/installer/managed-section.js';
import { PreconditionError } from '../../src/cli/errors.js';
import { isWindows } from '../setup/platform.js';

describe('Phase 2 e2e — install → status → pause → resume → uninstall', () => {
  let tmp: Awaited<ReturnType<typeof makeTempHome>>;
  let pluginBundleSrc: string;
  const packageVersion = '0.1.0';

  beforeEach(async () => {
    tmp = await makeTempHome();
    const fakePkgRoot = path.join(tmp.homeDir, '..', 'pkg');
    await fs.mkdir(fakePkgRoot, { recursive: true });
    pluginBundleSrc = await seedPluginBundleFixture(fakePkgRoot);
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  async function hashFile(p: string): Promise<string> {
    const buf = await fs.readFile(p);
    return createHash('sha256').update(buf).digest('hex');
  }

  function makeInstallOpts(scheduler = stubSchedulerBackend()) {
    const homeDir = tmp.homeDir;
    const marketplaceDir = path.join(homeDir, '.auto-sop', 'marketplace', 'auto-sop');
    return {
      opts: {
        projectRoot: tmp.projectRoot,
        homeDir,
        licenseKey: '123',
        pluginBundleSrc,
        packageVersion,
        nodeBin: process.execPath,
        shimAbsPath: path.join(marketplaceDir, 'shim.cjs'),
        learnerAbsPath: path.join(marketplaceDir, 'learner.cjs'),
        promptLicense: async () => '123',
        schedulerBackend: scheduler,
        now: 1_700_000_000_000,
        getMachineId: async () => 'abcdef0123456789abcdef0123456789',
      },
      scheduler,
      marketplaceDir,
    };
  }

  // ─── INST-01 ──────────────────────────────────────────────────────────────
  it('INST-01: install wires hooks, creates secrets.enc with trial, copies plugin bundle', async () => {
    const { opts, marketplaceDir, scheduler } = makeInstallOpts();
    const result = await runInstall(opts);

    expect(result.verdict).toBe('fresh');
    // Plugin bundle copied
    const shimStat = await fs.stat(path.join(marketplaceDir, 'shim.cjs'));
    expect(shimStat.isFile()).toBe(true);
    // Scheduler stub called
    expect(scheduler.calls.install).toHaveLength(1);
    // secrets.enc exists
    const secretsStat = await fs.stat(path.join(tmp.homeDir, '.auto-sop', 'secrets.enc'));
    expect(secretsStat.isFile()).toBe(true);
    // Hooks wired in project settings.json
    const settings = parse(
      await fs.readFile(path.join(tmp.projectRoot, '.claude', 'settings.json'), 'utf8'),
      [],
      { allowTrailingComma: true },
    );
    for (const ev of HOOK_EVENTS) {
      const arr: unknown[] = settings?.hooks?.[ev] ?? [];
      const hasOurs = arr.some(
        (e: unknown) =>
          (
            (e as Record<string, unknown>)?.hooks as Array<Record<string, unknown>> | undefined
          )?.some((h) => h.id === CLAUDE_SOP_HOOK_ID) ?? false,
      );
      expect(hasOurs, `hook event ${ev} should be wired`).toBe(true);
    }
  });

  // ─── INST-02 ──────────────────────────────────────────────────────────────
  it('INST-02: install is idempotent (re-run produces byte-identical settings.json)', async () => {
    const { opts } = makeInstallOpts();
    await runInstall(opts);
    const projectSettings = path.join(tmp.projectRoot, '.claude', 'settings.json');
    const firstHash = await hashFile(projectSettings);

    // Re-install with fresh scheduler stub
    await runInstall({
      ...opts,
      schedulerBackend: stubSchedulerBackend(),
    });
    const secondHash = await hashFile(projectSettings);
    expect(secondHash).toBe(firstHash);
  });

  // ─── INST-03 ──────────────────────────────────────────────────────────────
  it('INST-03: install preserves pre-existing user hooks in settings.json', async () => {
    // Seed project settings.json with a user hook
    const settingsDir = path.join(tmp.projectRoot, '.claude');
    await fs.mkdir(settingsDir, { recursive: true });
    const userHook = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: '/usr/local/bin/my-hook', timeout: 5 }],
          },
        ],
      },
    };
    await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify(userHook, null, 2));

    const { opts } = makeInstallOpts();
    await runInstall(opts);

    const after = JSON.parse(await fs.readFile(path.join(settingsDir, 'settings.json'), 'utf8'));
    // User hook preserved, ours appended after
    expect(after.hooks.UserPromptSubmit).toHaveLength(2);
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe('/usr/local/bin/my-hook');
    expect(after.hooks.UserPromptSubmit[1].hooks[0].id).toBe(CLAUDE_SOP_HOOK_ID);
  });

  // ─── INST-04 ──────────────────────────────────────────────────────────────
  it('INST-04: install appends .auto-sop/ to project .gitignore', async () => {
    const { opts } = makeInstallOpts();
    await runInstall(opts);
    const gitignore = await fs.readFile(path.join(tmp.projectRoot, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.auto-sop/');
  });

  // ─── INST-05 (v15+): installer MUST NOT write legacy markers ─────────────
  it('INST-05: installer does not touch CLAUDE.md (learner owns the managed section)', async () => {
    const { opts } = makeInstallOpts();
    await runInstall(opts);
    // With no pre-existing CLAUDE.md, the installer must not create one
    // and must not emit legacy `<!-- auto-sop:begin -->` markers.
    await expect(fs.stat(path.join(tmp.projectRoot, 'CLAUDE.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('INST-05b: installer preserves pre-existing CLAUDE.md byte-for-byte', async () => {
    const claudeMdPath = path.join(tmp.projectRoot, 'CLAUDE.md');
    const original = '# Existing Rules\n\nDo not touch me.\n';
    await fs.writeFile(claudeMdPath, original);
    const { opts } = makeInstallOpts();
    await runInstall(opts);
    const after = await fs.readFile(claudeMdPath, 'utf8');
    expect(after).toBe(original);
    expect(after).not.toContain(MANAGED_BEGIN);
    expect(after).not.toContain(MANAGED_END);
  });

  // ─── SCHED-01 + SCHED-04 ─────────────────────────────────────────────────
  it('SCHED-01/04: scheduler install called with absolute tick.sh path and 3600s interval', async () => {
    const { opts, scheduler } = makeInstallOpts();
    await runInstall(opts);
    const call = scheduler.calls.install[0]!;
    expect(call.tickScriptPath.startsWith('/')).toBe(true);
    expect(call.tickScriptPath.endsWith('/bin/tick.sh')).toBe(true);
    expect(call.intervalSec).toBe(3600);
  });

  // ─── SCHED-03 + SCHED-05 ──────────────────────────────────────────────────
  it('SCHED-03/05: tick.sh exists, is executable, is pure POSIX sh, NO flock, sets CLAUDE_SOP_CAPTURE_SUPPRESS=1', async () => {
    const { opts } = makeInstallOpts();
    await runInstall(opts);
    const tick = path.join(tmp.homeDir, '.auto-sop', 'bin', 'tick.sh');
    const st = await fs.stat(tick);
    expect(st.isFile()).toBe(true);
    if (!isWindows) {
      expect((st.mode & 0o111) !== 0).toBe(true); // executable bit set
    }
    const content = await fs.readFile(tick, 'utf8');
    // CRITICAL: flock must NOT be used as a command (macOS has no flock(1)).
    // The word "flock" may appear in comments explaining why it's absent,
    // but it must never appear as an actual shell command invocation.
    const nonCommentLines = content.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    for (const line of nonCommentLines) {
      expect(line).not.toMatch(/\bflock\b/);
    }
    // SCHED-05: CLAUDE_SOP_CAPTURE_SUPPRESS env var set (canonical)
    expect(content).toContain('CLAUDE_SOP_CAPTURE_SUPPRESS=1');
    // Legacy CLAUDE_SOP_LEARNER also still emitted for backward compat
    expect(content).toContain('CLAUDE_SOP_LEARNER=1');
    // Pure POSIX sh shebang
    if (!isWindows) {
      expect(content.split('\n')[0]).toBe('#!/bin/sh');
    }
  });

  // ─── LIC-01 ───────────────────────────────────────────────────────────────
  it('LIC-01/02: secrets.enc contains schema v1 with trial.started_at and license.kind=dev for key "123"', async () => {
    const { opts } = makeInstallOpts();
    await runInstall(opts);
    const { readSecrets } = await import('../../src/license/storage.js');
    const payload = await readSecrets(path.join(tmp.homeDir, '.auto-sop', 'secrets.enc'));
    expect(payload).not.toBeNull();
    expect(payload!.schema_version).toBe(1);
    expect(payload!.license.kind).toBe('dev');
    expect(payload!.trial.started_at).toBe(1_700_000_000_000);
    expect(payload!.trial.duration_days).toBe(14);
  });

  // ─── LIC-02 ───────────────────────────────────────────────────────────────
  it('LIC-02: re-install preserves trial.started_at (write-once invariant)', async () => {
    const { opts } = makeInstallOpts();
    await runInstall(opts);

    // Re-install with a later timestamp
    await runInstall({
      ...opts,
      now: 1_700_000_999_999,
      schedulerBackend: stubSchedulerBackend(),
    });

    const { readSecrets } = await import('../../src/license/storage.js');
    const payload = await readSecrets(path.join(tmp.homeDir, '.auto-sop', 'secrets.enc'));
    // trial.started_at must be the FIRST install's timestamp, not the re-install's
    expect(payload!.trial.started_at).toBe(1_700_000_000_000);
  });

  // ─── CLI-01 ───────────────────────────────────────────────────────────────
  it('CLI-01: status returns all I3 fields after install', async () => {
    const { opts, scheduler } = makeInstallOpts();
    await runInstall(opts);
    const report = await collectStatus({
      projectRoot: tmp.projectRoot,
      homeDir: tmp.homeDir,
      projectHash12: 'abcdef012345',
      projectSlug: 'test-project',
      schedulerBackend: scheduler,
    });
    expect(report.installedVersion).toBe(packageVersion);
    expect(report.hooks.wiringState).toBe('present');
    expect(report.hooks.eventsCovered).toHaveLength(HOOK_EVENTS.length);
    expect(report.license.status).toBe('dev-key');
    expect(report.paused).toBe(false);
    expect(report.project.root).toBe(tmp.projectRoot);
    expect(report.project.hash12).toBe('abcdef012345');
    expect(report.project.slug).toBe('test-project');
    expect(report.scheduler.backend).toBe('launchd');
    expect(report.scheduler.installed).toBe(true);
  });

  // ─── CLI-05 ───────────────────────────────────────────────────────────────
  it('CLI-05: pause/resume toggle paused.flag and status reflects it', async () => {
    const { opts, scheduler } = makeInstallOpts();
    await runInstall(opts);

    // Simulate pause: write paused.flag
    const flagPath = path.join(tmp.projectRoot, '.auto-sop', 'paused.flag');
    await fs.mkdir(path.dirname(flagPath), { recursive: true });
    await fs.writeFile(flagPath, JSON.stringify({ paused_at: Date.now() }));

    let report = await collectStatus({
      projectRoot: tmp.projectRoot,
      homeDir: tmp.homeDir,
      projectHash12: 'abcdef012345',
      projectSlug: 'test-project',
      schedulerBackend: scheduler,
    });
    expect(report.paused).toBe(true);

    // Simulate resume: remove paused.flag
    await fs.rm(flagPath);
    report = await collectStatus({
      projectRoot: tmp.projectRoot,
      homeDir: tmp.homeDir,
      projectHash12: 'abcdef012345',
      projectSlug: 'test-project',
      schedulerBackend: scheduler,
    });
    expect(report.paused).toBe(false);
  });

  // ─── INST-06: default uninstall ───────────────────────────────────────────
  it('INST-06: default uninstall removes hooks, scheduler, legacy managed section, secrets.enc but preserves captures', async () => {
    const { opts, scheduler } = makeInstallOpts();
    await runInstall(opts);

    // Simulate a pre-v15 install: seed CLAUDE.md with legacy markers so we can
    // verify uninstall's backward-compat cleanup still strips them.
    const claudeMdPath = path.join(tmp.projectRoot, 'CLAUDE.md');
    await fs.writeFile(
      claudeMdPath,
      `# Project\n\n${MANAGED_BEGIN}\nstale content\n${MANAGED_END}\n`,
    );

    // Seed a capture file that should survive default uninstall
    const capturesDir = path.join(tmp.projectRoot, '.auto-sop', 'captures');
    await fs.mkdir(capturesDir, { recursive: true });
    await fs.writeFile(path.join(capturesDir, 'turn-001.json'), '{"id":"001"}');

    const r = await runUninstall({
      projectRoot: tmp.projectRoot,
      homeDir: tmp.homeDir,
      purge: false,
      projectHash12: 'abcdef012345',
      schedulerBackend: scheduler,
    });
    expect(r.warnings).toHaveLength(0);

    // Hooks removed from settings.json
    const settings = parse(
      await fs.readFile(path.join(tmp.projectRoot, '.claude', 'settings.json'), 'utf8'),
      [],
      { allowTrailingComma: true },
    );
    for (const ev of HOOK_EVENTS) {
      const arr: unknown[] = settings?.hooks?.[ev] ?? [];
      for (const entry of arr as Array<Record<string, unknown>>) {
        for (const h of (entry.hooks as Array<Record<string, unknown>>) ?? []) {
          expect(h.id).not.toBe(CLAUDE_SOP_HOOK_ID);
        }
      }
    }

    // Legacy managed section stripped from pre-existing CLAUDE.md
    const md = await fs.readFile(claudeMdPath, 'utf8');
    expect(md).not.toContain(MANAGED_BEGIN);

    // secrets.enc removed
    await expect(fs.stat(path.join(tmp.homeDir, '.auto-sop', 'secrets.enc'))).rejects.toThrow();

    // tick.sh removed
    await expect(fs.stat(path.join(tmp.homeDir, '.auto-sop', 'bin', 'tick.sh'))).rejects.toThrow();

    // version.txt removed
    await expect(fs.stat(path.join(tmp.homeDir, '.auto-sop', 'version.txt'))).rejects.toThrow();

    // Captures preserved
    const captureContent = await fs.readFile(path.join(capturesDir, 'turn-001.json'), 'utf8');
    expect(captureContent.length).toBeGreaterThan(0);

    // Scheduler backend uninstall called
    expect(scheduler.calls.uninstall).toBe(1);
  });

  // ─── INST-06 + PRIV-06: purge ─────────────────────────────────────────────
  it('INST-06 + PRIV-06: --purge also wipes captures', async () => {
    const { opts, scheduler } = makeInstallOpts();
    await runInstall(opts);

    const capturesDir = path.join(tmp.projectRoot, '.auto-sop', 'captures');
    await fs.mkdir(capturesDir, { recursive: true });
    await fs.writeFile(path.join(capturesDir, 'turn-001.json'), '{}');

    await runUninstall({
      projectRoot: tmp.projectRoot,
      homeDir: tmp.homeDir,
      purge: true,
      projectHash12: 'abcdef012345',
      schedulerBackend: scheduler,
    });

    await expect(fs.stat(capturesDir)).rejects.toThrow();
  });

  // ─── G1: mutual exclusion ─────────────────────────────────────────────────
  it('G1: npm install path uses extraKnownMarketplaces, never sets enabledPlugins', async () => {
    const { opts } = makeInstallOpts();
    await runInstall(opts);

    // Check global settings: should have extraKnownMarketplaces, NOT enabledPlugins
    const globalSettings = parse(
      await fs.readFile(path.join(tmp.homeDir, '.claude', 'settings.json'), 'utf8'),
      [],
      { allowTrailingComma: true },
    );
    expect(globalSettings.extraKnownMarketplaces).toBeDefined();
    expect(globalSettings.enabledPlugins).toBeUndefined();

    // Check project settings: should have hooks, NOT enabledPlugins
    const projectSettings = parse(
      await fs.readFile(path.join(tmp.projectRoot, '.claude', 'settings.json'), 'utf8'),
      [],
      { allowTrailingComma: true },
    );
    expect(projectSettings.hooks).toBeDefined();
    expect(projectSettings.enabledPlugins).toBeUndefined();
  });

  // ─── G3: downgrade refused ────────────────────────────────────────────────
  it('G3: downgrade is refused', async () => {
    const { opts } = makeInstallOpts();
    // Install with a high version
    await runInstall({ ...opts, packageVersion: '9.9.9' });

    // Attempt downgrade
    await expect(
      runInstall({
        ...opts,
        packageVersion: '0.0.1',
        schedulerBackend: stubSchedulerBackend(),
      }),
    ).rejects.toBeInstanceOf(PreconditionError);
  });
});

/**
 * Integration tests for I9 — Directive preservation across uninstall/install.
 *
 * Covers:
 *   - Install restores directives from directive-history.json to CLAUDE.md
 *   - --no-restore flag bypasses restore logic
 *   - Missing directive-history.json does NOT crash install (graceful no-op)
 *   - Uninstall defensive backup: extracts directives from CLAUDE.md when
 *     directive-history.json is missing
 *   - just_restored flag causes learner to skip LLM and is cleared
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { runInstall, type InstallOptions } from '../../src/installer/orchestrator.js';
import { runUninstall } from '../../src/installer/uninstall-orchestrator.js';
import {
  saveHistory,
  updateFromProposals,
  emptyHistory,
  loadHistory,
  consumeJustRestored,
  type DirectiveProposalLike,
} from '../../src/managed-section/directive-history.js';
import { readManagedSection } from '../../src/managed-section/editor.js';
import { buildSectionBlock } from '../../src/managed-section/markers.js';
import type { SchedulerBackend, SchedulerInstallOpts } from '../../src/scheduler/types.js';

const FAKE_MACHINE_ID = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

function createStubBackend(): SchedulerBackend & { installCalls: SchedulerInstallOpts[] } {
  const installCalls: SchedulerInstallOpts[] = [];
  return {
    name: 'launchd',
    install: async (opts) => {
      installCalls.push(opts);
    },
    uninstall: async () => ({ warnings: [] }),
    status: async () => ({
      backend: 'launchd',
      installed: false,
      lastTickAt: null,
      lastExitCode: null,
      details: {},
    }),
    installCalls,
  };
}

function makeProposal(overrides: Partial<DirectiveProposalLike> = {}): DirectiveProposalLike {
  return {
    id: 'det-test-0000',
    rule_text: 'Default test directive text that is realistic and long enough.',
    severity: 'warning',
    evidence: { first_seen: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

describe('I9: directive preservation', () => {
  let testDir: string;
  let homeDir: string;
  let projectRoot: string;
  let pluginBundleSrc: string;
  const fixedNow = 1700000000000;

  beforeEach(async () => {
    testDir = join(tmpdir(), `i9-test-${nanoid(10)}`);
    homeDir = join(testDir, 'home');
    projectRoot = join(testDir, 'project');
    pluginBundleSrc = join(testDir, 'dist-plugin');
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(join(pluginBundleSrc, 'sub'), { recursive: true });
    await fs.writeFile(join(pluginBundleSrc, 'shim.cjs'), '// shim');
    await fs.writeFile(join(pluginBundleSrc, 'learner.cjs'), '// learner');
    await fs.writeFile(join(pluginBundleSrc, 'sub', 'helper.js'), '// helper');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function baseOpts(overrides: Partial<InstallOptions> = {}): InstallOptions {
    const marketplaceDir = join(homeDir, '.auto-sop', 'marketplace', 'auto-sop');
    return {
      projectRoot,
      homeDir,
      licenseKey: '123',
      pluginBundleSrc,
      packageVersion: '1.0.0',
      nodeBin: process.execPath,
      shimAbsPath: join(marketplaceDir, 'shim.cjs'),
      learnerAbsPath: join(marketplaceDir, 'learner.cjs'),
      schedulerBackend: createStubBackend(),
      promptLicense: async () => '123',
      getMachineId: async () => FAKE_MACHINE_ID,
      now: fixedNow,
      ...overrides,
    };
  }

  function seedDirectiveHistory(): void {
    const proposals: DirectiveProposalLike[] = [
      makeProposal({
        id: 'det-a',
        severity: 'error',
        rule_text: 'Always validate user input before database queries to prevent injection.',
      }),
      makeProposal({
        id: 'det-b',
        severity: 'warning',
        rule_text: 'Use try-catch blocks around all filesystem operations for robustness.',
      }),
      makeProposal({
        id: 'det-c',
        severity: 'info',
        rule_text: 'Prefer const over let for variables that are never reassigned.',
      }),
    ];
    const history = updateFromProposals(
      emptyHistory('2026-01-01T00:00:00.000Z'),
      proposals,
      '2026-01-01T00:00:00.000Z',
    );
    saveHistory(projectRoot, history);
  }

  // ─── Install with restore ────────────────────────────────

  it('restores directives from history on install', async () => {
    seedDirectiveHistory();

    const result = await runInstall(baseOpts());

    expect(result.directivesRestored).toBe(3);

    // CLAUDE.md should have the restored directives
    const managed = readManagedSection(projectRoot);
    expect(managed).not.toBeNull();
    expect(managed!.body).toContain('Directives restored from previous install');
    expect(managed!.body).toContain('Always validate user input');
    expect(managed!.body).toContain('try-catch blocks');
    expect(managed!.body).toContain('const over let');
  });

  it('sets just_restored flag after restoring', async () => {
    seedDirectiveHistory();

    await runInstall(baseOpts());

    // Flag should exist (consumeJustRestored will read + delete it)
    expect(consumeJustRestored(projectRoot)).toBe(true);
    // Second call returns false
    expect(consumeJustRestored(projectRoot)).toBe(false);
  });

  it('--no-restore skips directive restoration', async () => {
    seedDirectiveHistory();

    const result = await runInstall(baseOpts({ noRestore: true }));

    expect(result.directivesRestored).toBe(0);

    // CLAUDE.md should NOT have managed section (learner hasn't run yet)
    const managed = readManagedSection(projectRoot);
    expect(managed).toBeNull();

    // No just_restored flag
    expect(consumeJustRestored(projectRoot)).toBe(false);
  });

  it('graceful no-op when directive-history.json is missing', async () => {
    // No history seeded — fresh install
    const result = await runInstall(baseOpts());

    expect(result.directivesRestored).toBe(0);
    // Install should complete successfully
    expect(result.verdict).toBe('fresh');
  });

  it('graceful no-op when all directives are pruned', async () => {
    const proposals: DirectiveProposalLike[] = [
      makeProposal({
        id: 'det-pruned',
        rule_text: 'This directive was pruned and should not restore.',
      }),
    ];
    const history = updateFromProposals(
      emptyHistory('2026-01-01T00:00:00.000Z'),
      proposals,
      '2026-01-01T00:00:00.000Z',
    );
    history.entries['det-pruned']!.pruned = true;
    history.entries['det-pruned']!.pruned_at = '2026-01-01T00:00:00.000Z';
    saveHistory(projectRoot, history);

    const result = await runInstall(baseOpts());

    expect(result.directivesRestored).toBe(0);
  });

  // ─── Uninstall defensive backup ──────────────────────────

  it('uninstall defensive backup when history missing but CLAUDE.md has directives', async () => {
    // Write a managed section with directives to CLAUDE.md
    const body = [
      '_Data as of: 2026-04-18T12:00:00Z · 10 turns analyzed_',
      '',
      '**Learnings** (2 active directives)',
      '',
      '- **[error]** Always validate user input before database queries',
      '  _(evidence: 5 sessions)_',
      '',
      '- **[warning]** Use try-catch blocks around filesystem operations',
      '  _(evidence: 3 sessions)_',
    ].join('\n');
    const claudeMd = `# CLAUDE.md\n\n${buildSectionBlock(body)}\n`;
    await fs.writeFile(join(projectRoot, 'CLAUDE.md'), claudeMd);

    // No directive-history.json exists
    const histBefore = loadHistory(projectRoot);
    expect(Object.keys(histBefore.entries)).toHaveLength(0);

    // Run uninstall
    await runUninstall({
      projectRoot,
      homeDir,
      purge: false,
      projectHash12: 'test12345678',
      schedulerBackend: createStubBackend(),
      now: fixedNow,
    });

    // Directive history should now have the extracted directives
    const histAfter = loadHistory(projectRoot);
    const activeEntries = Object.values(histAfter.entries).filter((e) => !e.pruned);
    expect(activeEntries.length).toBe(2);
    expect(
      activeEntries.some(
        (e) => e.rule_text === 'Always validate user input before database queries',
      ),
    ).toBe(true);
    expect(
      activeEntries.some(
        (e) => e.rule_text === 'Use try-catch blocks around filesystem operations',
      ),
    ).toBe(true);
  });

  it('uninstall skips defensive backup when history already has active entries', async () => {
    // Seed directive history with existing entries
    seedDirectiveHistory();
    const histBefore = loadHistory(projectRoot);
    const beforeCount = Object.keys(histBefore.entries).length;

    // Write CLAUDE.md with markers (for strip step)
    const body = '- **[info]** Some directive text that should not be extracted';
    const claudeMd = `# CLAUDE.md\n\n${buildSectionBlock(body)}\n`;
    await fs.writeFile(join(projectRoot, 'CLAUDE.md'), claudeMd);

    await runUninstall({
      projectRoot,
      homeDir,
      purge: false,
      projectHash12: 'test12345678',
      schedulerBackend: createStubBackend(),
      now: fixedNow,
    });

    // History should not have gained extra entries from extraction
    const histAfter = loadHistory(projectRoot);
    expect(Object.keys(histAfter.entries).length).toBe(beforeCount);
  });

  it('uninstall preserves directive-history.json (no purge)', async () => {
    seedDirectiveHistory();

    await runUninstall({
      projectRoot,
      homeDir,
      purge: false,
      projectHash12: 'test12345678',
      schedulerBackend: createStubBackend(),
      now: fixedNow,
    });

    // directive-history.json should still exist
    const hist = loadHistory(projectRoot);
    expect(Object.keys(hist.entries).length).toBe(3);
  });
});

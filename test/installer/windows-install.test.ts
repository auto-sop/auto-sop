import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getPlatform } from '../../src/platform/index.js';
import { renderTickScriptCmd, writeTickScript } from '../../src/scheduler/tick-wrapper.js';

// We must mock execa before importing the scheduler module since
// windows-task-scheduler.ts imports it at module level.
vi.mock('execa', () => ({ execa: vi.fn() }));

import { pickBackend } from '../../src/scheduler/index.js';

describe('Windows install flow (simulated)', () => {
  let origUsername: string | undefined;
  let origUser: string | undefined;

  beforeEach(() => {
    origUsername = process.env.USERNAME;
    origUser = process.env.USER;
  });

  afterEach(() => {
    if (origUsername !== undefined) process.env.USERNAME = origUsername;
    else delete process.env.USERNAME;
    if (origUser !== undefined) process.env.USER = origUser;
    else delete process.env.USER;
  });

  it('pickBackend("win32") returns windowsTaskScheduler', async () => {
    const { backend } = await pickBackend('win32');
    expect(backend.name).toBe('task-scheduler');
  });

  it('writeTickScript generates .cmd content on win32', async () => {
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { nanoid } = await import('nanoid');

    const dir = join(tmpdir(), `win-install-test-${nanoid(6)}`);
    await fs.mkdir(dir, { recursive: true });
    const scriptPath = join(dir, 'tick.cmd');

    await writeTickScript(
      scriptPath,
      {
        homeDir: 'C:\\Users\\alice',
        nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
        learnerJs: 'C:\\Users\\alice\\.auto-sop\\dist\\learner.cjs',
        errorsLog: 'C:\\Users\\alice\\.auto-sop\\logs\\errors.log',
      },
      'win32',
    );

    const content = await fs.readFile(scriptPath, 'utf8');
    expect(content).toContain('@echo off');
    expect(content).toContain('setlocal');
    expect(content).toContain('AUTO_SOP_CAPTURE_SUPPRESS=1');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('getPlatform("win32").chmod is a no-op', async () => {
    const adapter = getPlatform('win32');
    // Should not throw, should resolve to undefined
    await expect(adapter.chmod('/any/path', 0o755)).resolves.toBeUndefined();
  });

  it('getPlatform("win32").currentUser returns USERNAME env var', () => {
    process.env.USERNAME = 'winuser42';
    delete process.env.USER;
    const adapter = getPlatform('win32');
    expect(adapter.currentUser()).toBe('winuser42');
  });

  it('getPlatform("win32").tickScriptExtension returns .cmd', () => {
    const adapter = getPlatform('win32');
    expect(adapter.tickScriptExtension()).toBe('.cmd');
  });

  it('renderTickScriptCmd produces valid batch file content', () => {
    const content = renderTickScriptCmd({
      homeDir: 'C:\\Users\\testuser',
      nodeBin: 'C:\\nodejs\\node.exe',
      learnerJs: 'C:\\Users\\testuser\\.auto-sop\\dist\\learner.cjs',
      errorsLog: 'C:\\Users\\testuser\\.auto-sop\\logs\\errors.log',
    });
    expect(content).toContain('@echo off');
    expect(content).toContain('set CLAUDE_SOP_LEARNER=1');
    expect(content).toContain('node.exe');
  });

  // ─── v24 Wave 2: Integration verification — simulated Windows chmod flow ───

  it('ManagedSectionEditor writes CLAUDE.md on simulated win32 without chmod throw', async () => {
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { nanoid } = await import('nanoid');

    // Create a temporary project root
    const projectRoot = join(tmpdir(), `win-editor-test-${nanoid(6)}`);
    await fs.mkdir(projectRoot, { recursive: true });

    // Mock getPlatform to return win32 adapter for default calls
    const platformMod = await import('../../src/platform/index.js');
    const originalGetPlatform = platformMod.getPlatform;
    const win32Adapter = originalGetPlatform('win32');

    // Use vi.spyOn on the module — mock getPlatform to return win32 when called without args
    const { writeManagedSection } = await import('../../src/managed-section/editor.js');

    // We need to mock the getPlatform import inside editor.ts.
    // Since editor.ts calls getPlatform() (no args), and getPlatform defaults to process.platform,
    // the simplest approach: temporarily mock the module.
    vi.spyOn(platformMod, 'getPlatform').mockReturnValue(win32Adapter);

    // Also mock isGitBusy to return false (no .git in temp dir)
    const gitStateMod = await import('../../src/managed-section/git-state.js');
    vi.spyOn(gitStateMod, 'isGitBusy').mockReturnValue(false);

    try {
      const result = writeManagedSection({
        projectRoot,
        content: { body: '- **[info]** Test directive for win32 integration' },
      });

      expect(result.verdict).toBe('created');
      expect(result.claudeMdPath).toContain('CLAUDE.md');

      // Verify file was written successfully
      const written = await fs.readFile(result.claudeMdPath, 'utf8');
      expect(written).toContain('Test directive for win32 integration');
    } finally {
      vi.restoreAllMocks();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('directive-history saves history file on simulated win32 without chmod throw', async () => {
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { nanoid } = await import('nanoid');

    const projectRoot = join(tmpdir(), `win-history-test-${nanoid(6)}`);
    await fs.mkdir(projectRoot, { recursive: true });

    const platformMod = await import('../../src/platform/index.js');
    const win32Adapter = platformMod.getPlatform('win32');
    vi.spyOn(platformMod, 'getPlatform').mockReturnValue(win32Adapter);

    try {
      const { saveHistory, loadHistory, emptyHistory } =
        await import('../../src/managed-section/directive-history.js');

      const history = emptyHistory();
      history.entries['test-directive'] = {
        id: 'test-directive',
        rule_text: 'Always use strict mode',
        severity: 'warning',
        first_seen: '2026-01-01T00:00:00Z',
        last_reinforced: '2026-01-15T00:00:00Z',
        occurrence_count: 3,
        pruned: false,
      };

      // Should not throw on win32 (chmodSync is a no-op)
      saveHistory(projectRoot, history);

      // Verify round-trip: load back what we saved
      const loaded = loadHistory(projectRoot);
      expect(loaded.entries['test-directive']).toBeDefined();
      expect(loaded.entries['test-directive']!.rule_text).toBe('Always use strict mode');
      expect(loaded.entries['test-directive']!.occurrence_count).toBe(3);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('revert verb does not crash on simulated win32', async () => {
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { nanoid } = await import('nanoid');

    const projectRoot = join(tmpdir(), `win-revert-test-${nanoid(6)}`);
    const stateDir = join(projectRoot, '.auto-sop', 'state');
    await fs.mkdir(stateDir, { recursive: true });

    // Write a CLAUDE.md and a backup to revert from
    const claudeMdPath = join(projectRoot, 'CLAUDE.md');
    const backupPath = join(stateDir, 'CLAUDE.md.backup');
    const originalContent = '# CLAUDE.md\n\nOriginal content before learner.\n';
    const currentContent = '# CLAUDE.md\n\nModified by learner.\n';

    await fs.writeFile(backupPath, originalContent);
    await fs.writeFile(claudeMdPath, currentContent);

    // Mock getPlatform to return win32 adapter
    const platformMod = await import('../../src/platform/index.js');
    const win32Adapter = platformMod.getPlatform('win32');
    vi.spyOn(platformMod, 'getPlatform').mockReturnValue(win32Adapter);

    try {
      // Import the revert verb and invoke it programmatically
      // The revert action calls getPlatform().chmodSync() — on win32 this must be a no-op
      const { Command } = await import('commander');
      const { registerRevertVerb } = await import('../../src/cli/verbs/revert.js');

      const program = new Command();
      program.option('--json', 'JSON output');
      registerRevertVerb(program);

      // Run revert with --json to capture structured output
      await program.parseAsync(['node', 'test', '--json', 'revert', '--project', projectRoot]);

      // Verify the revert completed: CLAUDE.md should now contain the backup content
      const reverted = await fs.readFile(claudeMdPath, 'utf8');
      expect(reverted).toBe(originalContent);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

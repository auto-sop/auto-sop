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

    await writeTickScript(scriptPath, {
      homeDir: 'C:\\Users\\alice',
      nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
      learnerJs: 'C:\\Users\\alice\\.auto-sop\\dist\\learner.cjs',
      errorsLog: 'C:\\Users\\alice\\.auto-sop\\logs\\errors.log',
    }, 'win32');

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
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { nanoid } from 'nanoid';
import { getPlatform } from '../../src/platform/index.js';
import { darwinAdapter } from '../../src/platform/darwin.js';
import { linuxAdapter } from '../../src/platform/linux.js';
import { win32Adapter } from '../../src/platform/win32.js';
import { isWindows } from '../setup/platform.js';

describe('getPlatform()', () => {
  it('returns darwin adapter for "darwin"', () => {
    const p = getPlatform('darwin');
    expect(p.name).toBe('darwin');
  });

  it('returns linux adapter for "linux"', () => {
    const p = getPlatform('linux');
    expect(p.name).toBe('linux');
  });

  it('returns win32 adapter for "win32"', () => {
    const p = getPlatform('win32');
    expect(p.name).toBe('win32');
  });

  it('throws for unsupported platform', () => {
    expect(() => getPlatform('freebsd' as NodeJS.Platform)).toThrow(
      'Unsupported platform: freebsd',
    );
  });
});

describe('darwinAdapter', () => {
  it('schedulerBackendName returns launchd', () => {
    expect(darwinAdapter.schedulerBackendName()).toBe('launchd');
  });

  it('tickScriptExtension returns .sh', () => {
    expect(darwinAdapter.tickScriptExtension()).toBe('.sh');
  });

  it('currentUser reads USER env var', () => {
    const orig = process.env.USER;
    process.env.USER = 'testuser';
    expect(darwinAdapter.currentUser()).toBe('testuser');
    if (orig !== undefined) process.env.USER = orig;
    else delete process.env.USER;
  });

  it('chmod sets file mode', async () => {
    if (isWindows) return; // POSIX file mode bits not meaningful on Windows
    const dir = join(tmpdir(), `plat-test-${nanoid(6)}`);
    await fs.mkdir(dir, { recursive: true });
    const f = join(dir, 'test.txt');
    await fs.writeFile(f, 'hi');
    await darwinAdapter.chmod(f, 0o755);
    const stat = await fs.stat(f);
    expect(stat.mode & 0o755).toBe(0o755);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('chmodSync sets file mode', async () => {
    if (isWindows) return; // POSIX file mode bits not meaningful on Windows
    const dir = join(tmpdir(), `plat-test-${nanoid(6)}`);
    await fs.mkdir(dir, { recursive: true });
    const f = join(dir, 'test2.txt');
    await fs.writeFile(f, 'hi');
    darwinAdapter.chmodSync(f, 0o755);
    const stat = await fs.stat(f);
    expect(stat.mode & 0o755).toBe(0o755);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('linuxAdapter', () => {
  it('schedulerBackendName returns systemd', () => {
    expect(linuxAdapter.schedulerBackendName()).toBe('systemd');
  });

  it('tickScriptExtension returns .sh', () => {
    expect(linuxAdapter.tickScriptExtension()).toBe('.sh');
  });

  it('currentUser reads USER env var', () => {
    const orig = process.env.USER;
    process.env.USER = 'linuxuser';
    expect(linuxAdapter.currentUser()).toBe('linuxuser');
    if (orig !== undefined) process.env.USER = orig;
    else delete process.env.USER;
  });
});

describe('win32Adapter', () => {
  let origUser: string | undefined;
  let origUsername: string | undefined;

  beforeEach(() => {
    origUser = process.env.USER;
    origUsername = process.env.USERNAME;
  });

  afterEach(() => {
    if (origUser !== undefined) process.env.USER = origUser;
    else delete process.env.USER;
    if (origUsername !== undefined) process.env.USERNAME = origUsername;
    else delete process.env.USERNAME;
  });

  it('schedulerBackendName returns task-scheduler', () => {
    expect(win32Adapter.schedulerBackendName()).toBe('task-scheduler');
  });

  it('tickScriptExtension returns .cmd', () => {
    expect(win32Adapter.tickScriptExtension()).toBe('.cmd');
  });

  it('currentUser prefers USERNAME over USER', () => {
    process.env.USERNAME = 'winuser';
    process.env.USER = 'posixuser';
    expect(win32Adapter.currentUser()).toBe('winuser');
  });

  it('currentUser falls back to USER', () => {
    delete process.env.USERNAME;
    process.env.USER = 'fallbackuser';
    expect(win32Adapter.currentUser()).toBe('fallbackuser');
  });

  it('currentUser returns unknown when no env vars', () => {
    delete process.env.USERNAME;
    delete process.env.USER;
    expect(win32Adapter.currentUser()).toBe('unknown');
  });

  it('chmod is a no-op (does not throw)', async () => {
    await expect(win32Adapter.chmod('/some/path', 0o755)).resolves.toBeUndefined();
  });

  it('chmodSync is a no-op (does not throw)', () => {
    expect(() => win32Adapter.chmodSync('/some/path', 0o755)).not.toThrow();
  });
});

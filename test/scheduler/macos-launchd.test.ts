import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/atomic/write.js', () => ({
  writeFileAtomic: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:fs', async (importOriginal) => {
  const orig =
    (await importOriginal()) as typeof import('node:fs');
  return {
    ...orig,
    promises: {
      ...orig.promises,
      access: vi.fn(),
      rm: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../../src/atomic/write.js';
import { macosLaunchd, renderPlist } from '../../src/scheduler/macos-launchd.js';

const mockExeca = vi.mocked(execa);
const mockWriteFileAtomic = vi.mocked(writeFileAtomic);
const mockAccess = vi.mocked(fs.access);
const mockRm = vi.mocked(fs.rm);

const TEST_UID = 501;
const baseOpts = {
  tickScriptPath: '/Users/alice/.auto-sop/bin/tick.sh',
  intervalSec: 3600,
  logDir: '/Users/alice/.auto-sop/logs',
  homeDir: '/Users/alice',
  user: 'alice',
};

describe('renderPlist', () => {
  it('renders valid plist with StartCalendarInterval (hourly at :00)', () => {
    const plist = renderPlist({
      label: 'com.auto-sop.learner',
      tickScriptPath: '/Users/alice/.auto-sop/bin/tick.sh',
      intervalSec: 3600,
      stdoutLog: '/Users/alice/.auto-sop/logs/launchd.out.log',
      stderrLog: '/Users/alice/.auto-sop/logs/launchd.err.log',
    });

    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).toContain('<key>Minute</key>');
    expect(plist).toContain('<integer>0</integer>');
    expect(plist).not.toContain('<key>StartInterval</key>');
    expect(plist).not.toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<string>/bin/sh</string>');
    expect(plist).toContain(
      '<string>/Users/alice/.auto-sop/bin/tick.sh</string>',
    );
    expect(plist).toContain('<string>Background</string>');
    expect(plist).toContain('CLAUDE_SOP_CAPTURE_SUPPRESS');
    expect(plist).toContain('CLAUDE_SOP_LEARNER'); // legacy, backward compat
  });

  it('XML-escapes ampersand in paths', () => {
    const plist = renderPlist({
      label: 'com.auto-sop.learner',
      tickScriptPath: '/Users/foo&bar/tick.sh',
      intervalSec: 3600,
      stdoutLog: '/tmp/out.log',
      stderrLog: '/tmp/err.log',
    });

    expect(plist).toContain('foo&amp;bar');
    expect(plist).not.toContain('foo&bar');
  });
});

describe('macosLaunchd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('process', {
      ...process,
      getuid: () => TEST_UID,
    });
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as any);
  });

  describe('install', () => {
    it('executes legacy-cleanup + 5-step sequence: legacy-bootout → bootout → write → bootstrap → enable → kickstart', async () => {
      await macosLaunchd.install(baseOpts);

      // writeFileAtomic called with plist path and StartCalendarInterval
      expect(mockWriteFileAtomic).toHaveBeenCalledOnce();
      const [plistPath, content] = mockWriteFileAtomic.mock.calls[0]!;
      expect(plistPath).toBe(
        '/Users/alice/Library/LaunchAgents/com.auto-sop.learner.plist',
      );
      expect(content).toContain('<key>StartCalendarInterval</key>');
      expect(content).not.toContain('<key>StartInterval</key>');

      // execa calls in order: legacy-bootout, bootout, bootstrap, enable, kickstart (all with reject:false)
      expect(mockExeca).toHaveBeenCalledTimes(5);
      // Step 0: bootout legacy label
      expect(mockExeca).toHaveBeenNthCalledWith(
        1,
        'launchctl',
        ['bootout', `gui/${TEST_UID}/com.claude-sop.learner`],
        { reject: false },
      );
      // Step 1: bootout current label
      expect(mockExeca).toHaveBeenNthCalledWith(
        2,
        'launchctl',
        ['bootout', `gui/${TEST_UID}/com.auto-sop.learner`],
        { reject: false },
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        3,
        'launchctl',
        ['bootstrap', `gui/${TEST_UID}`, plistPath],
        { reject: false },
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        4,
        'launchctl',
        ['enable', `gui/${TEST_UID}/com.auto-sop.learner`],
        { reject: false },
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        5,
        'launchctl',
        ['kickstart', '-k', `gui/${TEST_UID}/com.auto-sop.learner`],
        { reject: false },
      );
    });

    it('falls back to load -w when bootstrap fails', async () => {
      // bootstrap returns non-zero on first call
      mockExeca
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any) // legacy bootout
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any) // bootout
        .mockResolvedValueOnce({ exitCode: 113, stdout: '', stderr: 'bootstrap unsupported' } as any) // bootstrap fails
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any) // load -w fallback
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any) // enable
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any); // kickstart

      await macosLaunchd.install(baseOpts);

      expect(mockExeca).toHaveBeenCalledTimes(6);
      // After bootstrap fails, load -w is called (4th execa call)
      expect(mockExeca).toHaveBeenNthCalledWith(
        4,
        'launchctl',
        ['load', '-w', '/Users/alice/Library/LaunchAgents/com.auto-sop.learner.plist'],
        { reject: false },
      );
    });

    it('bootout failure does not abort install (idempotent fresh install)', async () => {
      mockExeca
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any) // legacy bootout
        .mockResolvedValueOnce({ exitCode: 3, stdout: '', stderr: 'not loaded' } as any) // bootout fails
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any) // bootstrap
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any) // enable
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as any); // kickstart

      // Should not throw
      await macosLaunchd.install(baseOpts);
      expect(mockWriteFileAtomic).toHaveBeenCalledOnce();
      expect(mockExeca).toHaveBeenCalledTimes(5);
    });
  });

  describe('uninstall', () => {
    it('calls bootout and removes plist file', async () => {
      const result = await macosLaunchd.uninstall({
        homeDir: '/Users/alice',
        user: 'alice',
      });

      expect(mockExeca).toHaveBeenCalledWith(
        'launchctl',
        ['bootout', `gui/${TEST_UID}/com.auto-sop.learner`],
        { reject: false },
      );
      expect(mockRm).toHaveBeenCalledWith(
        '/Users/alice/Library/LaunchAgents/com.auto-sop.learner.plist',
        { force: true },
      );
      expect(result.warnings).toEqual([]);
    });

    it('collects stderr as warning on nonzero exit', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 3,
        stdout: '',
        stderr: 'not loaded',
      } as any);

      const result = await macosLaunchd.uninstall({
        homeDir: '/Users/alice',
        user: 'alice',
      });
      expect(result.warnings).toContain('not loaded');
    });
  });

  describe('status', () => {
    it('returns installed: true when plist exists', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'last exit code = 0',
      } as any);

      const s = await macosLaunchd.status({
        homeDir: '/Users/alice',
        user: 'alice',
      });
      expect(s.backend).toBe('launchd');
      expect(s.installed).toBe(true);
      expect(s.lastExitCode).toBe(0);
    });

    it('returns installed: false when plist does not exist', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      mockExeca.mockResolvedValueOnce({
        exitCode: 113,
        stdout: '',
      } as any);

      const s = await macosLaunchd.status({
        homeDir: '/Users/alice',
        user: 'alice',
      });
      expect(s.installed).toBe(false);
    });
  });
});

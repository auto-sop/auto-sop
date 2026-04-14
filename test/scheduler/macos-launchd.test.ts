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
  tickScriptPath: '/Users/alice/.claude-sop/bin/tick.sh',
  intervalSec: 3600,
  logDir: '/Users/alice/.claude-sop/logs',
  homeDir: '/Users/alice',
  user: 'alice',
};

describe('renderPlist', () => {
  it('renders valid plist with correct interval', () => {
    const plist = renderPlist({
      label: 'com.claude-sop.learner',
      tickScriptPath: '/Users/alice/.claude-sop/bin/tick.sh',
      intervalSec: 3600,
      stdoutLog: '/Users/alice/.claude-sop/logs/launchd.out.log',
      stderrLog: '/Users/alice/.claude-sop/logs/launchd.err.log',
    });

    expect(plist).toContain('<integer>3600</integer>');
    expect(plist).toContain('<false/>');
    expect(plist).toContain('<string>/bin/sh</string>');
    expect(plist).toContain(
      '<string>/Users/alice/.claude-sop/bin/tick.sh</string>',
    );
    expect(plist).toContain('<string>Background</string>');
    expect(plist).toContain('CLAUDE_SOP_LEARNER');
  });

  it('XML-escapes ampersand in paths', () => {
    const plist = renderPlist({
      label: 'com.claude-sop.learner',
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
    it('writes plist and calls launchctl bootstrap+enable', async () => {
      await macosLaunchd.install(baseOpts);

      // writeFileAtomic called with plist path
      expect(mockWriteFileAtomic).toHaveBeenCalledOnce();
      const [plistPath, content] = mockWriteFileAtomic.mock.calls[0]!;
      expect(plistPath).toBe(
        '/Users/alice/Library/LaunchAgents/com.claude-sop.learner.plist',
      );
      expect(content).toContain('<integer>3600</integer>');

      // execa calls in order: bootout (idempotent), bootstrap, enable
      expect(mockExeca).toHaveBeenCalledTimes(3);
      expect(mockExeca).toHaveBeenNthCalledWith(
        1,
        'launchctl',
        ['bootout', `gui/${TEST_UID}/com.claude-sop.learner`],
        { reject: false },
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        2,
        'launchctl',
        ['bootstrap', `gui/${TEST_UID}`, plistPath],
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        3,
        'launchctl',
        ['enable', `gui/${TEST_UID}/com.claude-sop.learner`],
      );
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
        ['bootout', `gui/${TEST_UID}/com.claude-sop.learner`],
        { reject: false },
      );
      expect(mockRm).toHaveBeenCalledWith(
        '/Users/alice/Library/LaunchAgents/com.claude-sop.learner.plist',
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

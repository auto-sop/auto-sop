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
      mkdir: vi.fn().mockResolvedValue(undefined),
      access: vi.fn(),
      rm: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../../src/atomic/write.js';
import {
  linuxSystemd,
  renderServiceUnit,
  renderTimerUnit,
} from '../../src/scheduler/linux-systemd.js';

const mockExeca = vi.mocked(execa);
const mockWriteFileAtomic = vi.mocked(writeFileAtomic);
const mockAccess = vi.mocked(fs.access);
const mockRm = vi.mocked(fs.rm);
const mockMkdir = vi.mocked(fs.mkdir);

const baseOpts = {
  tickScriptPath: '/home/alice/.claude-sop/bin/tick.sh',
  intervalSec: 3600,
  logDir: '/home/alice/.claude-sop/logs',
  homeDir: '/home/alice',
  user: 'alice',
};

describe('renderServiceUnit', () => {
  it('contains ExecStart with tick.sh path', () => {
    const unit = renderServiceUnit({
      tickScriptPath: '/home/alice/.claude-sop/bin/tick.sh',
      user: 'alice',
      homeDir: '/home/alice',
    });
    expect(unit).toContain(
      'ExecStart=/home/alice/.claude-sop/bin/tick.sh',
    );
  });

  it('contains Environment=CLAUDE_SOP_CAPTURE_SUPPRESS=1 (canonical)', () => {
    const unit = renderServiceUnit({
      tickScriptPath: '/home/alice/.claude-sop/bin/tick.sh',
      user: 'alice',
      homeDir: '/home/alice',
    });
    expect(unit).toContain('Environment=CLAUDE_SOP_CAPTURE_SUPPRESS=1');
  });

  it('contains Environment=CLAUDE_SOP_LEARNER=1 (legacy backward compat)', () => {
    const unit = renderServiceUnit({
      tickScriptPath: '/home/alice/.claude-sop/bin/tick.sh',
      user: 'alice',
      homeDir: '/home/alice',
    });
    expect(unit).toContain('Environment=CLAUDE_SOP_LEARNER=1');
  });

  it('contains StandardOutput and StandardError log paths', () => {
    const unit = renderServiceUnit({
      tickScriptPath: '/home/alice/.claude-sop/bin/tick.sh',
      user: 'alice',
      homeDir: '/home/alice',
    });
    expect(unit).toContain(
      'StandardOutput=append:/home/alice/.claude-sop/logs/systemd.out.log',
    );
    expect(unit).toContain(
      'StandardError=append:/home/alice/.claude-sop/logs/systemd.err.log',
    );
  });
});

describe('renderTimerUnit', () => {
  it('contains OnBootSec=5min', () => {
    expect(renderTimerUnit()).toContain('OnBootSec=5min');
  });

  it('contains OnUnitActiveSec with default 3600s', () => {
    expect(renderTimerUnit()).toContain('OnUnitActiveSec=3600s');
  });

  it('honors custom intervalSec', () => {
    expect(renderTimerUnit({ intervalSec: 900 })).toContain('OnUnitActiveSec=900s');
  });

  it('contains Persistent=true', () => {
    expect(renderTimerUnit()).toContain('Persistent=true');
  });

  it('targets the service unit', () => {
    expect(renderTimerUnit()).toContain(
      'Unit=claude-sop-learner.service',
    );
  });
});

describe('linuxSystemd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    } as any);
  });

  describe('install', () => {
    it('creates unit dir, writes units, and calls systemctl+loginctl', async () => {
      await linuxSystemd.install(baseOpts);

      // mkdir for systemd user dir
      expect(mockMkdir).toHaveBeenCalledWith(
        '/home/alice/.config/systemd/user',
        { recursive: true },
      );

      // Two writeFileAtomic calls: service + timer
      expect(mockWriteFileAtomic).toHaveBeenCalledTimes(2);
      const [servicePath] = mockWriteFileAtomic.mock.calls[0]!;
      const [timerPath] = mockWriteFileAtomic.mock.calls[1]!;
      expect(servicePath).toBe(
        '/home/alice/.config/systemd/user/claude-sop-learner.service',
      );
      expect(timerPath).toBe(
        '/home/alice/.config/systemd/user/claude-sop-learner.timer',
      );

      // execa calls: daemon-reload, enable --now, loginctl enable-linger
      expect(mockExeca).toHaveBeenCalledTimes(3);
      expect(mockExeca).toHaveBeenNthCalledWith(1, 'systemctl', [
        '--user',
        'daemon-reload',
      ]);
      expect(mockExeca).toHaveBeenNthCalledWith(2, 'systemctl', [
        '--user',
        'enable',
        '--now',
        'claude-sop-learner.timer',
      ]);
      expect(mockExeca).toHaveBeenNthCalledWith(
        3,
        'loginctl',
        ['enable-linger', 'alice'],
        { reject: false },
      );
    });
  });

  describe('uninstall', () => {
    it('disables timer, removes files, and daemon-reloads', async () => {
      const result = await linuxSystemd.uninstall({
        homeDir: '/home/alice',
        user: 'alice',
      });

      expect(mockExeca).toHaveBeenNthCalledWith(
        1,
        'systemctl',
        ['--user', 'disable', '--now', 'claude-sop-learner.timer'],
        { reject: false },
      );
      expect(mockRm).toHaveBeenCalledWith(
        '/home/alice/.config/systemd/user/claude-sop-learner.timer',
        { force: true },
      );
      expect(mockRm).toHaveBeenCalledWith(
        '/home/alice/.config/systemd/user/claude-sop-learner.service',
        { force: true },
      );
      expect(mockExeca).toHaveBeenLastCalledWith(
        'systemctl',
        ['--user', 'daemon-reload'],
        { reject: false },
      );
      expect(result.warnings).toEqual([]);
    });
  });

  describe('status', () => {
    it('returns installed: true when timer file exists', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'LastTriggerUSec=1700000000000000\nResult=success\nActiveState=active',
      } as any);

      const s = await linuxSystemd.status({
        homeDir: '/home/alice',
        user: 'alice',
      });
      expect(s.backend).toBe('systemd');
      expect(s.installed).toBe(true);
      expect(s.lastTickAt).toBe(1700000000000);
      expect(s.lastExitCode).toBe(0);
    });

    it('returns installed: false when timer does not exist', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      mockExeca.mockResolvedValueOnce({
        exitCode: 4,
        stdout: '',
      } as any);

      const s = await linuxSystemd.status({
        homeDir: '/home/alice',
        user: 'alice',
      });
      expect(s.installed).toBe(false);
    });
  });
});

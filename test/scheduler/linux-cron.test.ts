import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { linuxCron } from '../../src/scheduler/linux-cron.js';

const mockExeca = vi.mocked(execa);
type ExecaResult = Awaited<ReturnType<typeof execa>>;

const baseOpts = {
  tickScriptPath: '/home/alice/.auto-sop/bin/tick.sh',
  intervalSec: 3600,
  logDir: '/home/alice/.auto-sop/logs',
  homeDir: '/home/alice',
  user: 'alice',
};

describe('linuxCron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    } as unknown as ExecaResult);
  });

  describe('install', () => {
    it('appends managed entry when crontab is empty', async () => {
      // crontab -l returns empty
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '',
      } as unknown as ExecaResult);
      // crontab - (stdin write)
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
      } as unknown as ExecaResult);

      await linuxCron.install(baseOpts);

      expect(mockExeca).toHaveBeenCalledTimes(2);
      // Verify the stdin input to crontab -
      const cronWriteCall = mockExeca.mock.calls[1]!;
      expect(cronWriteCall[0]).toBe('crontab');
      expect(cronWriteCall[1]).toEqual(['-']);
      const input = (cronWriteCall[2] as Record<string, unknown>).input as string;
      expect(input).toContain('# auto-sop:managed');
      expect(input).toContain(baseOpts.tickScriptPath);
      // Terminal newline (Pitfall 8)
      expect(input).toMatch(/\n$/);
    });

    it('preserves existing user entries and appends managed entry', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '*/5 * * * * /usr/local/bin/backup.sh\n',
      } as unknown as ExecaResult);
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as unknown as ExecaResult);

      await linuxCron.install(baseOpts);

      const input = (mockExeca.mock.calls[1]![2] as Record<string, unknown>).input as string;
      expect(input).toContain('/usr/local/bin/backup.sh');
      expect(input).toContain('# auto-sop:managed');
      expect(input).toMatch(/\n$/);
    });

    it('strips prior managed entry before appending (idempotent)', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '*/5 * * * * /usr/local/bin/backup.sh\n0 * * * * /old/tick.sh # auto-sop:managed\n',
      } as unknown as ExecaResult);
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as unknown as ExecaResult);

      await linuxCron.install(baseOpts);

      const input = (mockExeca.mock.calls[1]![2] as Record<string, unknown>).input as string;
      // Only one managed line
      const managedLines = input
        .split('\n')
        .filter((l: string) => l.includes('# auto-sop:managed'));
      expect(managedLines).toHaveLength(1);
      // Old tick.sh replaced
      expect(input).not.toContain('/old/tick.sh');
      // New tick.sh present
      expect(input).toContain(baseOpts.tickScriptPath);
    });

    it('ensures terminal newline (Pitfall 8)', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '*/5 * * * * /usr/local/bin/backup.sh',
      } as unknown as ExecaResult);
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as unknown as ExecaResult);

      await linuxCron.install(baseOpts);

      const input = (mockExeca.mock.calls[1]![2] as Record<string, unknown>).input as string;
      expect(input.endsWith('\n')).toBe(true);
      // No double newlines
      expect(input).not.toMatch(/\n\n/);
    });
  });

  describe('uninstall', () => {
    it('strips managed marker lines from crontab', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          '*/5 * * * * /usr/local/bin/backup.sh\n0 * * * * /home/alice/.auto-sop/bin/tick.sh # auto-sop:managed\n',
      } as unknown as ExecaResult);
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as unknown as ExecaResult);

      const result = await linuxCron.uninstall({
        homeDir: '/home/alice',
        user: 'alice',
      });

      const input = (mockExeca.mock.calls[1]![2] as Record<string, unknown>).input as string;
      expect(input).not.toContain('# auto-sop:managed');
      expect(input).toContain('/usr/local/bin/backup.sh');
      expect(result.warnings).toEqual([]);
    });

    it('is a no-op when no crontab exists', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'no crontab for alice',
      } as unknown as ExecaResult);

      const result = await linuxCron.uninstall({
        homeDir: '/home/alice',
        user: 'alice',
      });
      // Only crontab -l was called, no crontab - write
      expect(mockExeca).toHaveBeenCalledTimes(1);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('status', () => {
    it('returns installed: true when crontab contains marker', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '0 * * * * /home/alice/.auto-sop/bin/tick.sh # auto-sop:managed\n',
      } as unknown as ExecaResult);

      const s = await linuxCron.status({
        homeDir: '/home/alice',
        user: 'alice',
      });
      expect(s.backend).toBe('cron');
      expect(s.installed).toBe(true);
      expect(s.lastTickAt).toBeNull();
      expect(s.details).toEqual({
        note: 'cron backend; last-tick unknown from cron',
      });
    });

    it('returns installed: false when crontab has no marker', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '*/5 * * * * /usr/local/bin/backup.sh\n',
      } as unknown as ExecaResult);

      const s = await linuxCron.status({
        homeDir: '/home/alice',
        user: 'alice',
      });
      expect(s.installed).toBe(false);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/scheduler/detect.js', () => ({
  systemdUserAvailable: vi.fn(),
}));
// Must also mock execa so backend imports don't fail
vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/atomic/write.js', () => ({
  writeFileAtomic: vi.fn().mockResolvedValue(undefined),
}));

import { systemdUserAvailable } from '../../src/scheduler/detect.js';
import { pickBackend } from '../../src/scheduler/index.js';
import { macosLaunchd } from '../../src/scheduler/macos-launchd.js';
import { linuxSystemd } from '../../src/scheduler/linux-systemd.js';
import { linuxCron } from '../../src/scheduler/linux-cron.js';

const mockSystemdAvailable = vi.mocked(systemdUserAvailable);

describe('pickBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns macosLaunchd for darwin', async () => {
    const result = await pickBackend('darwin');
    expect(result.backend).toBe(macosLaunchd);
    expect(result.fallbackWarning).toBeUndefined();
  });

  it('returns linuxSystemd for linux when systemd is available', async () => {
    mockSystemdAvailable.mockResolvedValueOnce(true);
    const result = await pickBackend('linux');
    expect(result.backend).toBe(linuxSystemd);
    expect(result.fallbackWarning).toBeUndefined();
  });

  it('returns linuxCron with warning for linux when systemd is unavailable', async () => {
    mockSystemdAvailable.mockResolvedValueOnce(false);
    const result = await pickBackend('linux');
    expect(result.backend).toBe(linuxCron);
    expect(result.fallbackWarning).toBeDefined();
    expect(result.fallbackWarning).toContain('systemd --user is unavailable');
    expect(result.fallbackWarning).toContain('cron entry as a fallback');
  });

  it('returns windowsTaskScheduler for win32', async () => {
    const result = await pickBackend('win32');
    expect(result.backend.name).toBe('task-scheduler');
    expect(result.fallbackWarning).toBeUndefined();
  });

  it('throws for unsupported platform', async () => {
    await expect(pickBackend('freebsd' as NodeJS.Platform)).rejects.toThrow(
      'unsupported platform: freebsd',
    );
  });
});

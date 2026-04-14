import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { systemdUserAvailable } from '../../src/scheduler/detect.js';

const mockExeca = vi.mocked(execa);

describe('systemdUserAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when exitCode is 0 and stdout is "running"', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'running',
    } as any);

    expect(await systemdUserAvailable()).toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'is-system-running'],
      { reject: false, timeout: 2000 },
    );
  });

  it('returns true when exitCode is 1 but stdout is "degraded"', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'degraded',
    } as any);

    expect(await systemdUserAvailable()).toBe(true);
  });

  it('returns true when stdout is "starting"', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'starting',
    } as any);

    expect(await systemdUserAvailable()).toBe(true);
  });

  it('returns true when stdout is "initializing"', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'initializing',
    } as any);

    expect(await systemdUserAvailable()).toBe(true);
  });

  it('returns true when stdout is "maintenance"', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'maintenance',
    } as any);

    expect(await systemdUserAvailable()).toBe(true);
  });

  it('returns false when exitCode is 1 and stdout is "offline"', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: 'offline',
    } as any);

    expect(await systemdUserAvailable()).toBe(false);
  });

  it('returns false when execa throws (e.g. timeout)', async () => {
    mockExeca.mockRejectedValueOnce(new Error('timed out'));

    expect(await systemdUserAvailable()).toBe(false);
  });

  it('calls execa with exact expected arguments', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'running',
    } as any);

    await systemdUserAvailable();

    expect(mockExeca).toHaveBeenCalledExactlyOnceWith(
      'systemctl',
      ['--user', 'is-system-running'],
      { reject: false, timeout: 2000 },
    );
  });
});

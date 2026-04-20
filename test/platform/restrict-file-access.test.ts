import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execa before importing win32 adapter
vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

// Mock node:fs for POSIX adapters
vi.mock('node:fs', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('node:fs');
  return {
    ...orig,
    promises: {
      ...orig.promises,
      chmod: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { darwinAdapter } from '../../src/platform/darwin.js';
import { linuxAdapter } from '../../src/platform/linux.js';
import { win32Adapter } from '../../src/platform/win32.js';
import { execa } from 'execa';
import { promises as fs } from 'node:fs';

const mockExeca = vi.mocked(execa);
const mockChmod = vi.mocked(fs.chmod);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('restrictFileAccess', () => {
  it('darwin: calls chmod 0o600', async () => {
    await darwinAdapter.restrictFileAccess('/tmp/test.txt');
    expect(mockChmod).toHaveBeenCalledWith('/tmp/test.txt', 0o600);
  });

  it('linux: calls chmod 0o600', async () => {
    await linuxAdapter.restrictFileAccess('/tmp/test.txt');
    expect(mockChmod).toHaveBeenCalledWith('/tmp/test.txt', 0o600);
  });

  it('win32: calls icacls with correct args', async () => {
    await win32Adapter.restrictFileAccess('C:\\Users\\test\\file.txt');
    expect(mockExeca).toHaveBeenCalledWith('icacls', [
      'C:\\Users\\test\\file.txt',
      '/inheritance:r',
      '/grant:r',
      expect.stringMatching(/:F$/),
    ]);
  });
});

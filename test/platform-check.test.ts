import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertPlatformSupported } from '../src/platform-check.js';

describe('assertPlatformSupported', () => {
  const originalEnv = process.env['CLAUDE_SOP_FAKE_PLATFORM'];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // no-op to prevent actual exit
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    if (originalEnv === undefined) {
      delete process.env['CLAUDE_SOP_FAKE_PLATFORM'];
    } else {
      process.env['CLAUDE_SOP_FAKE_PLATFORM'] = originalEnv;
    }
  });

  it('should not exit on darwin', () => {
    process.env['CLAUDE_SOP_FAKE_PLATFORM'] = 'darwin';
    assertPlatformSupported();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should not exit on linux', () => {
    process.env['CLAUDE_SOP_FAKE_PLATFORM'] = 'linux';
    assertPlatformSupported();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should exit 1 on win32 with refusal message on stderr', () => {
    process.env['CLAUDE_SOP_FAKE_PLATFORM'] = 'win32';
    assertPlatformSupported();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Windows is not supported'));
  });
});

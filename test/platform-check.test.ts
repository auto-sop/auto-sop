import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertPlatformSupported } from '../src/platform-check.js';

describe('assertPlatformSupported', () => {
  const originalEnv = process.env['CLAUDE_SOP_FAKE_PLATFORM'];
  const originalAutoEnv = process.env['AUTO_SOP_FAKE_PLATFORM'];
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
    if (originalAutoEnv === undefined) {
      delete process.env['AUTO_SOP_FAKE_PLATFORM'];
    } else {
      process.env['AUTO_SOP_FAKE_PLATFORM'] = originalAutoEnv;
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

  it('should not exit on win32 (now supported)', () => {
    process.env['CLAUDE_SOP_FAKE_PLATFORM'] = 'win32';
    assertPlatformSupported();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('should exit 1 on unsupported platform with message on stderr', () => {
    process.env['AUTO_SOP_FAKE_PLATFORM'] = 'freebsd';
    assertPlatformSupported();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unsupported platform'));
  });
});

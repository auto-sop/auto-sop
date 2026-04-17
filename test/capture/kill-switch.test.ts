import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isCaptureDisabled,
  _resetDeprecationWarnedForTests,
} from '../../src/capture/kill-switch.js';

describe('isCaptureDisabled', () => {
  // ── base behavior ──────────────────────────────────────────
  it('returns false when no suppression vars are set', () => {
    expect(isCaptureDisabled({})).toBe(false);
  });

  // ── new canonical var: CLAUDE_SOP_CAPTURE_SUPPRESS ─────────
  describe('CLAUDE_SOP_CAPTURE_SUPPRESS (canonical)', () => {
    it('returns true when set to "1"', () => {
      expect(
        isCaptureDisabled({ CLAUDE_SOP_CAPTURE_SUPPRESS: '1' }),
      ).toBe(true);
    });

    it('returns false when set to "0"', () => {
      expect(
        isCaptureDisabled({ CLAUDE_SOP_CAPTURE_SUPPRESS: '0' }),
      ).toBe(false);
    });

    it('returns false when empty string', () => {
      expect(
        isCaptureDisabled({ CLAUDE_SOP_CAPTURE_SUPPRESS: '' }),
      ).toBe(false);
    });

    it('returns false when "true" (only literal "1" counts)', () => {
      expect(
        isCaptureDisabled({ CLAUDE_SOP_CAPTURE_SUPPRESS: 'true' }),
      ).toBe(false);
    });

    it('returns false when undefined', () => {
      expect(
        isCaptureDisabled({ CLAUDE_SOP_CAPTURE_SUPPRESS: undefined }),
      ).toBe(false);
    });
  });

  // ── legacy var: CLAUDE_SOP_LEARNER (backward compat) ───────
  describe('CLAUDE_SOP_LEARNER (legacy, backward compat)', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      _resetDeprecationWarnedForTests();
      stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('returns true when legacy var set to "1"', () => {
      expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: '1' })).toBe(true);
    });

    it('emits a deprecation notice to stderr on first hit', () => {
      isCaptureDisabled({ CLAUDE_SOP_LEARNER: '1' });
      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('CLAUDE_SOP_LEARNER is deprecated');
      expect(written).toContain('CLAUDE_SOP_CAPTURE_SUPPRESS');
    });

    it('emits the deprecation notice at most once per process', () => {
      isCaptureDisabled({ CLAUDE_SOP_LEARNER: '1' });
      isCaptureDisabled({ CLAUDE_SOP_LEARNER: '1' });
      isCaptureDisabled({ CLAUDE_SOP_LEARNER: '1' });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it('returns false when legacy var set to "0"', () => {
      expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: '0' })).toBe(false);
    });

    it('returns false when legacy var empty', () => {
      expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: '' })).toBe(false);
    });

    it('returns false when legacy var is "true"', () => {
      expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: 'true' })).toBe(false);
    });

    it('returns false when legacy var undefined', () => {
      expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: undefined })).toBe(false);
    });

    it('does NOT warn when legacy var is set but does not trigger suppression', () => {
      isCaptureDisabled({ CLAUDE_SOP_LEARNER: '0' });
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  // ── precedence: new var wins, no warning when both set ─────
  describe('precedence', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      _resetDeprecationWarnedForTests();
      stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('returns true when both vars are set to "1"', () => {
      expect(
        isCaptureDisabled({
          CLAUDE_SOP_CAPTURE_SUPPRESS: '1',
          CLAUDE_SOP_LEARNER: '1',
        }),
      ).toBe(true);
    });

    it('does NOT warn when new var short-circuits the check', () => {
      isCaptureDisabled({
        CLAUDE_SOP_CAPTURE_SUPPRESS: '1',
        CLAUDE_SOP_LEARNER: '1',
      });
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });
});

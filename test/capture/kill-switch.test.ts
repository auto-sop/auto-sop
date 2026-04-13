import { describe, it, expect } from 'vitest';
import { isCaptureDisabled } from '../../src/capture/kill-switch.js';

describe('isCaptureDisabled', () => {
  it('returns false when CLAUDE_SOP_LEARNER is not set', () => {
    expect(isCaptureDisabled({})).toBe(false);
  });

  it('returns true when CLAUDE_SOP_LEARNER is "1"', () => {
    expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: '1' })).toBe(true);
  });

  it('returns false when CLAUDE_SOP_LEARNER is "0"', () => {
    expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: '0' })).toBe(false);
  });

  it('returns false when CLAUDE_SOP_LEARNER is empty string', () => {
    expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: '' })).toBe(false);
  });

  it('returns false when CLAUDE_SOP_LEARNER is "true"', () => {
    expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: 'true' })).toBe(false);
  });

  it('returns false when CLAUDE_SOP_LEARNER is undefined explicitly', () => {
    expect(isCaptureDisabled({ CLAUDE_SOP_LEARNER: undefined })).toBe(false);
  });
});

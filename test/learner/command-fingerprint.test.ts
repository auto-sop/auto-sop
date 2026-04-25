/**
 * Unit tests for src/learner/command-fingerprint.ts
 *
 * Covers:
 * - fingerprintCommand: trimming, whitespace collapse, length cap
 * - isBashFailure: success flag, exitCode, interrupted, edge cases
 */
import { describe, it, expect } from 'vitest';
import { fingerprintCommand, isBashFailure } from '../../src/learner/command-fingerprint.js';
import type { ToolCall } from '../../src/learner/turn-loader.js';

describe('fingerprintCommand', () => {
  it('trims leading/trailing whitespace', () => {
    expect(fingerprintCommand('   npm test   ')).toBe('npm test');
  });

  it('collapses interior whitespace runs', () => {
    expect(fingerprintCommand('npm    test')).toBe('npm test');
  });

  it('caps at 100 chars', () => {
    const long = 'a'.repeat(150);
    expect(fingerprintCommand(long).length).toBe(100);
  });

  it('preserves short commands unchanged', () => {
    expect(fingerprintCommand('ls')).toBe('ls');
  });

  it('handles empty string', () => {
    expect(fingerprintCommand('')).toBe('');
  });

  it('handles tabs and newlines as whitespace', () => {
    expect(fingerprintCommand('npm\t\ttest\n--watch')).toBe('npm test --watch');
  });

  it('preserves single spaces', () => {
    expect(fingerprintCommand('git commit -m "message"')).toBe('git commit -m "message"');
  });
});

describe('isBashFailure', () => {
  it('returns true when success is false', () => {
    const call: ToolCall = {
      event: 'post',
      tool_use_id: 'tu1',
      tool: 'Bash',
      success: false,
      t: '2026-04-25T00:00:00Z',
    };
    expect(isBashFailure(call)).toBe(true);
  });

  it('returns false when success is true', () => {
    const call: ToolCall = {
      event: 'post',
      tool_use_id: 'tu1',
      tool: 'Bash',
      success: true,
      t: '2026-04-25T00:00:00Z',
    };
    expect(isBashFailure(call)).toBe(false);
  });

  it('returns true on non-zero exitCode even without success field', () => {
    const call: ToolCall = {
      event: 'post',
      tool_use_id: 'tu1',
      tool: 'Bash',
      output: { exitCode: 1, __untrusted: true },
      t: '2026-04-25T00:00:00Z',
    };
    expect(isBashFailure(call)).toBe(true);
  });

  it('returns false on exitCode 0', () => {
    const call: ToolCall = {
      event: 'post',
      tool_use_id: 'tu1',
      tool: 'Bash',
      output: { exitCode: 0, __untrusted: true },
      t: '2026-04-25T00:00:00Z',
    };
    expect(isBashFailure(call)).toBe(false);
  });

  it('returns true on interrupted: true', () => {
    const call: ToolCall = {
      event: 'post',
      tool_use_id: 'tu1',
      tool: 'Bash',
      output: { interrupted: true, __untrusted: true },
      t: '2026-04-25T00:00:00Z',
    };
    expect(isBashFailure(call)).toBe(true);
  });

  it('returns false when no failure signals present', () => {
    const call: ToolCall = {
      event: 'post',
      tool_use_id: 'tu1',
      tool: 'Bash',
      t: '2026-04-25T00:00:00Z',
    };
    expect(isBashFailure(call)).toBe(false);
  });

  it('returns false when output is null-ish', () => {
    const call: ToolCall = {
      event: 'post',
      tool_use_id: 'tu1',
      tool: 'Bash',
      output: undefined,
      t: '2026-04-25T00:00:00Z',
    };
    expect(isBashFailure(call)).toBe(false);
  });
});

/**
 * Unit tests for serializeError — the V27 error serialization fix.
 *
 * Tests the ACTUAL exported function from main.ts, not a copy of the logic.
 */
import { describe, it, expect } from 'vitest';
import { serializeError } from '../../src/learner/main.js';

describe('V27 — serializeError()', () => {
  it('serializes plain objects as JSON (not [object Object])', () => {
    const obj = {
      projectRoot: '/tmp/test',
      conflictPath: '/tmp/conflict',
      storedHash: 'abc',
      currentHash: 'def',
    };

    const result = serializeError(obj);
    expect(result).toContain('projectRoot');
    expect(result).toContain('/tmp/test');
    expect(result).toContain('storedHash');
    expect(result).toContain('abc');

    // Verify it's valid JSON
    const parsed = JSON.parse(result);
    expect(parsed.projectRoot).toBe('/tmp/test');
    expect(parsed.currentHash).toBe('def');
  });

  it('returns .message for Error instances', () => {
    const err = new Error('something failed');
    expect(serializeError(err)).toBe('something failed');
  });

  it('passes string values through unchanged', () => {
    expect(serializeError('simple error message')).toBe('simple error message');
  });

  it('stringifies null as "null"', () => {
    expect(serializeError(null)).toBe('null');
  });

  it('serializes nested objects fully', () => {
    const obj = { issues: [{ code: 'invalid_type', path: ['id'] }] };
    const result = serializeError(obj);
    expect(result).toContain('invalid_type');
    expect(result).toContain('"path":["id"]');
  });

  it('falls back to String() for circular references instead of dropping the entry', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const result = serializeError(circular);
    // Should not throw; should produce String(circular) = "[object Object]"
    // which is the safe fallback — the point is that the log entry is NOT dropped
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles undefined', () => {
    expect(serializeError(undefined)).toBe('undefined');
  });

  it('handles numeric values', () => {
    expect(serializeError(42)).toBe('42');
  });
});

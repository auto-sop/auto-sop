import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { sha4, formatRedaction } from '../../src/scrubber/redaction.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

describe('sha4', () => {
  it('returns exactly 4 hex chars', () => {
    const result = sha4('hello');
    expect(result).toHaveLength(4);
    expect(result).toMatch(/^[0-9a-f]{4}$/);
  });

  it('is deterministic — same input always produces same output', () => {
    expect(sha4('foo')).toBe(sha4('foo'));
  });

  it('produces different output for different input', () => {
    expect(sha4('foo')).not.toBe(sha4('bar'));
  });
});

describe('formatRedaction', () => {
  it('returns [REDACTED:<sha4>] format', () => {
    const result = formatRedaction('sk-ant-12345');
    const expected = `[REDACTED:${sha4('sk-ant-12345')}]`;
    expect(result).toBe(expected);
    expect(result).toMatch(/^\[REDACTED:[0-9a-f]{4}\]$/);
  });

  it('is deterministic across calls', () => {
    expect(formatRedaction('my-secret')).toBe(formatRedaction('my-secret'));
  });
});

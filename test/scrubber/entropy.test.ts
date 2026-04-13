import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import {
  shannonEntropy,
  applyEntropyCatchAll,
  ENTROPY_THRESHOLD,
  MIN_TOKEN_LEN,
} from '../../src/scrubber/entropy.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

describe('constants', () => {
  it('ENTROPY_THRESHOLD is exactly 4.5', () => {
    expect(ENTROPY_THRESHOLD).toBe(4.5);
  });

  it('MIN_TOKEN_LEN is exactly 20', () => {
    expect(MIN_TOKEN_LEN).toBe(20);
  });
});

describe('shannonEntropy', () => {
  it('returns 0 for empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('returns ≈ 0 for single repeated char', () => {
    expect(shannonEntropy('aaaaaa')).toBeCloseTo(0, 5);
  });

  it('returns > 4.5 for alphanumeric charset string', () => {
    const input = 'abcdefghijklmnopqrstuvwxyz0123456789';
    expect(shannonEntropy(input)).toBeGreaterThan(4.5);
  });

  it('returns 1 for a two-char even-split string', () => {
    // 'ab' has entropy exactly 1 bit
    expect(shannonEntropy('ab')).toBeCloseTo(1, 5);
  });
});

describe('applyEntropyCatchAll', () => {
  it('redacts a 32-char high-entropy base64 token', () => {
    const token = 'aB3dE5gH7jK9mN1pQ3sT5uW7yZ0bD2fG';
    const { output, replaced } = applyEntropyCatchAll(`key=${token}`);
    expect(output).toContain('[REDACTED:');
    expect(output).not.toContain(token);
    expect(replaced).toBe(1);
  });

  it('leaves a 19-char token alone (below MIN_TOKEN_LEN)', () => {
    const shortToken = 'aB3dE5gH7jK9mN1pQ3'; // 19 chars
    const { output, replaced } = applyEntropyCatchAll(`key=${shortToken}`);
    expect(output).toContain(shortToken);
    expect(replaced).toBe(0);
  });

  it('leaves low-entropy repeated-char token alone', () => {
    const token = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // 24 a's, entropy ≈ 0
    const { output, replaced } = applyEntropyCatchAll(`key=${token}`);
    expect(output).toContain(token);
    expect(replaced).toBe(0);
  });

  it('returns accurate count of replacements', () => {
    const t1 = 'aB3dE5gH7jK9mN1pQ3sT5uW7yZ0bD2fG';
    const t2 = 'xY8wV6uT4sR2qP0oN8mL6kJ4hG2fD0cB';
    const { replaced } = applyEntropyCatchAll(`first=${t1} second=${t2}`);
    expect(replaced).toBe(2);
  });
});

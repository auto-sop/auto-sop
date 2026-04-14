import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import * as readline from 'node:readline/promises';
import { classifyLicense } from '../../src/cli/prompt.js';

/**
 * Helper: creates a readline interface with mock stdin/stdout,
 * simulates the user typing `input`, and returns the answer from promptLicense logic.
 */
async function simulatePrompt(input: string, defaultText = '123'): Promise<string> {
  const stdin = new Readable({ read() {} });
  const chunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });

  const rl = readline.createInterface({ input: stdin, output: stdout });

  const questionPromise = rl.question(
    `Enter your claude-sop license key (test key: ${defaultText}): `,
  );

  // Push user input then close the stream
  stdin.push(input + '\n');
  stdin.push(null);

  const answer = await questionPromise;
  rl.close();

  return answer.trim() || defaultText;
}

describe('promptLicense (via simulated readline)', () => {
  it('returns default "123" on empty input', async () => {
    const result = await simulatePrompt('');
    expect(result).toBe('123');
  });

  it('trims whitespace and returns value', async () => {
    const result = await simulatePrompt('   abc  ');
    expect(result).toBe('abc');
  });

  it('returns exact input when provided', async () => {
    const result = await simulatePrompt('xyz');
    expect(result).toBe('xyz');
  });
});

describe('classifyLicense', () => {
  it('returns "dev" for key "123"', () => {
    expect(classifyLicense('123')).toBe('dev');
  });

  it('returns "user" for any other key', () => {
    expect(classifyLicense('real-key')).toBe('user');
    expect(classifyLicense('')).toBe('user');
    expect(classifyLicense('abc-def-ghi')).toBe('user');
  });
});

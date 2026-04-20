import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli } from '../../src/cli/main.js';

describe('runCli', () => {
  let stderrChunks: string[];
  let stdoutChunks: string[];
  let originalStderrWrite: typeof process.stderr.write;
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    stderrChunks = [];
    stdoutChunks = [];
    originalStderrWrite = process.stderr.write;
    originalStdoutWrite = process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
  });

  it('--version returns 0 and prints version', async () => {
    const code = await runCli(['node', 'auto-sop', '--version']);
    expect(code).toBe(0);
    // Version is printed to stdout by commander
    const output = stdoutChunks.join('');
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });

  it('--help returns 0', async () => {
    const code = await runCli(['node', 'auto-sop', '--help']);
    expect(code).toBe(0);
  });

  it('unknown verb returns 2 (MISUSE)', async () => {
    const code = await runCli(['node', 'auto-sop', 'nosuchverb']);
    expect(code).toBe(2);
  });

  it('--json + unknown verb returns 2 and emits JSON error', async () => {
    const code = await runCli(['node', 'auto-sop', '--json', 'nosuchverb']);
    expect(code).toBe(2);
    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(2);
  });
});

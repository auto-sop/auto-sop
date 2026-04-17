import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import {
  renderTickScript,
  writeTickScript,
} from '../../src/scheduler/tick-wrapper.js';

const baseOpts = {
  homeDir: '/Users/alice',
  nodeBin: '/usr/local/bin/node',
  learnerJs: '/Users/alice/.claude-sop/dist/learner.js',
  errorsLog: '/Users/alice/.claude-sop/logs/errors.log',
};

describe('renderTickScript', () => {
  it('starts with #!/bin/sh', () => {
    const script = renderTickScript(baseOpts);
    expect(script).toMatch(/^#!\/bin\/sh\n/);
  });

  it('contains set -eu', () => {
    const script = renderTickScript(baseOpts);
    expect(script).toContain('set -eu');
  });

  it('contains CLAUDE_SOP_CAPTURE_SUPPRESS=1 (canonical)', () => {
    const script = renderTickScript(baseOpts);
    expect(script).toContain('CLAUDE_SOP_CAPTURE_SUPPRESS=1');
  });

  it('contains CLAUDE_SOP_LEARNER=1 (legacy, backward compat)', () => {
    const script = renderTickScript(baseOpts);
    expect(script).toContain('CLAUDE_SOP_LEARNER=1');
  });

  it('contains export HOME with quoted path', () => {
    const script = renderTickScript(baseOpts);
    expect(script).toContain("export HOME='/Users/alice'");
  });

  it('contains exec line with proper variable references', () => {
    const script = renderTickScript(baseOpts);
    expect(script).toContain(
      'exec "$NODE_BIN" "$LEARNER_JS" 2>>"$ERRORS_LOG"',
    );
  });

  it('escapes single quotes in homeDir (POSIX style)', () => {
    const script = renderTickScript({
      ...baseOpts,
      homeDir: "/Users/O'Brien",
    });
    expect(script).toContain("export HOME='/Users/O'\\''Brien'");
  });

  it('handles spaces in homeDir', () => {
    const script = renderTickScript({
      ...baseOpts,
      homeDir: '/Users/Ayşe Çalışkan',
    });
    // Single-quoted, no shell expansion
    expect(script).toContain("export HOME='/Users/Ayşe Çalışkan'");
  });

  it('does NOT use flock as a command', () => {
    const script = renderTickScript(baseOpts);
    // Filter out comment lines; assert no executable flock usage
    const codeLines = script
      .split('\n')
      .filter((l) => !l.startsWith('#'));
    expect(codeLines.join('\n')).not.toMatch(/\bflock\b/);
  });
});

describe('writeTickScript', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tick-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('creates file with mode 0o755 and matching content', async () => {
    const scriptPath = join(testDir, 'tick.sh');
    await writeTickScript(scriptPath, baseOpts);

    const stat = await fs.stat(scriptPath);
    // Check executable bits (owner+group+other execute)
    expect(stat.mode & 0o755).toBe(0o755);

    const content = await fs.readFile(scriptPath, 'utf8');
    expect(content).toBe(renderTickScript(baseOpts));
  });
});

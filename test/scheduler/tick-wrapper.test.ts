import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import {
  renderTickScript,
  renderTickScriptCmd,
  writeTickScript,
  validatePathSegment,
} from '../../src/scheduler/tick-wrapper.js';
import { isWindows } from '../setup/platform.js';

const baseOpts = {
  homeDir: '/Users/alice',
  nodeBin: '/usr/local/bin/node',
  learnerJs: '/Users/alice/.auto-sop/dist/learner.js',
  errorsLog: '/Users/alice/.auto-sop/logs/errors.log',
};

describe('validatePathSegment', () => {
  it('returns safe paths unchanged', () => {
    expect(validatePathSegment('/usr/local/bin')).toBe('/usr/local/bin');
    expect(validatePathSegment('/opt/homebrew/bin')).toBe('/opt/homebrew/bin');
    expect(validatePathSegment('/home/user/.local/bin')).toBe('/home/user/.local/bin');
  });

  it('returns undefined for undefined/empty input', () => {
    expect(validatePathSegment(undefined)).toBeUndefined();
    expect(validatePathSegment('')).toBeUndefined();
  });

  it('rejects paths with double quotes', () => {
    expect(validatePathSegment('/path/with"quote')).toBeUndefined();
  });

  it('rejects paths with dollar sign', () => {
    expect(validatePathSegment('/path/$HOME/bin')).toBeUndefined();
  });

  it('rejects paths with backtick', () => {
    expect(validatePathSegment('/path/`whoami`/bin')).toBeUndefined();
  });

  it('allows Windows paths with backslash', () => {
    expect(validatePathSegment('C:\\Program Files\\Claude')).toBe('C:\\Program Files\\Claude');
  });

  it('rejects paths with newline', () => {
    expect(validatePathSegment('/path/with\nnewline')).toBeUndefined();
  });

  it('rejects paths with null byte', () => {
    expect(validatePathSegment('/path/with\0null')).toBeUndefined();
  });

  it('rejects paths with percent sign (Windows CMD expansion)', () => {
    expect(validatePathSegment('C:\\foo%PATH%bar')).toBeUndefined();
  });
});

describe('renderTickScript — claudeBinDir sanitization', () => {
  it('silently drops claudeBinDir with shell-special chars', () => {
    const script = renderTickScript({
      ...baseOpts,
      claudeBinDir: '/path/$EVIL',
    });
    expect(script).not.toContain('$EVIL');
    // PATH should still be well-formed
    expect(script).toContain('$HOME/.local/bin');
  });

  it('silently drops claudeBinDir with backtick injection', () => {
    const script = renderTickScript({
      ...baseOpts,
      claudeBinDir: '/path/`rm -rf /`',
    });
    expect(script).not.toContain('rm -rf');
  });
});

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
    expect(script).toContain('exec "$NODE_BIN" "$LEARNER_JS" 2>>"$ERRORS_LOG"');
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
    const codeLines = script.split('\n').filter((l) => !l.startsWith('#'));
    expect(codeLines.join('\n')).not.toMatch(/\bflock\b/);
  });

  it('always includes $HOME/.local/bin in PATH', () => {
    const script = renderTickScript(baseOpts);
    expect(script).toContain('$HOME/.local/bin');
  });

  it('includes claudeBinDir in PATH when provided', () => {
    const script = renderTickScript({
      ...baseOpts,
      claudeBinDir: '/opt/homebrew/bin',
    });
    expect(script).toContain('/opt/homebrew/bin');
    // Should also still have $HOME/.local/bin
    expect(script).toContain('$HOME/.local/bin');
    // claudeBinDir should appear after $HOME/.local/bin
    const pathLine = script.split('\n').find((l) => l.startsWith('export PATH='))!;
    const localBinIdx = pathLine.indexOf('$HOME/.local/bin');
    const claudeIdx = pathLine.indexOf('/opt/homebrew/bin');
    expect(localBinIdx).toBeLessThan(claudeIdx);
  });

  it('works without claudeBinDir (backward compat)', () => {
    const script = renderTickScript(baseOpts);
    expect(script).toContain('$HOME/.local/bin');
    expect(script).toContain('/usr/local/bin');
    // Should not have empty path segment (double colon)
    const pathLine = script.split('\n').find((l) => l.startsWith('export PATH='))!;
    expect(pathLine).not.toContain('::');
  });
});

describe('renderTickScriptCmd', () => {
  const winOpts = {
    homeDir: 'C:\\Users\\alice',
    nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
    learnerJs: 'C:\\Users\\alice\\.auto-sop\\dist\\learner.cjs',
    errorsLog: 'C:\\Users\\alice\\.auto-sop\\logs\\errors.log',
  };

  it('starts with @echo off', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toMatch(/^@echo off/);
  });

  it('uses setlocal', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain('setlocal');
  });

  it('sets AUTO_SOP_CAPTURE_SUPPRESS=1', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain('set AUTO_SOP_CAPTURE_SUPPRESS=1');
  });

  it('sets CLAUDE_SOP_CAPTURE_SUPPRESS=1', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain('set CLAUDE_SOP_CAPTURE_SUPPRESS=1');
  });

  it('references node and learner paths', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain('node.exe');
    expect(script).toContain('learner.cjs');
  });

  it('references errors log for stderr redirect', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain('errors.log');
  });

  it('uses CRLF line endings', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain('\r\n');
  });

  it('creates log directory before stderr redirect', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain(
      'if not exist "%AUTO_SOP_DATA_DIR%\\logs" mkdir "%AUTO_SOP_DATA_DIR%\\logs"',
    );
    // Ensure mkdir comes before the 2>> redirect
    const mkdirIdx = script.indexOf('mkdir "%AUTO_SOP_DATA_DIR%\\logs"');
    const redirectIdx = script.indexOf('2>>');
    expect(mkdirIdx).toBeLessThan(redirectIdx);
  });

  it('handles forward-slash homeDirs by converting to backslash in data dir', () => {
    const script = renderTickScriptCmd({
      ...winOpts,
      homeDir: 'C:/Users/alice',
    });
    expect(script).toContain('C:\\Users\\alice\\.auto-sop');
  });

  it('includes %USERPROFILE%\\.local\\bin in PATH', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain('%USERPROFILE%\\.local\\bin');
  });

  it('includes claudeBinDir in PATH when provided', () => {
    const script = renderTickScriptCmd({
      ...winOpts,
      claudeBinDir: 'C:\\Program Files\\Claude',
    });
    expect(script).toContain('C:\\Program Files\\Claude');
    expect(script).toContain('%USERPROFILE%\\.local\\bin');
  });

  it('works without claudeBinDir (backward compat)', () => {
    const script = renderTickScriptCmd(winOpts);
    expect(script).toContain('%USERPROFILE%\\.local\\bin');
    // Should not have double semicolons
    expect(script).not.toContain(';;');
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

  it('creates POSIX file with mode 0o755 and matching content', async () => {
    const scriptPath = join(testDir, 'tick.sh');
    await writeTickScript(scriptPath, baseOpts, 'darwin');

    const stat = await fs.stat(scriptPath);
    // Check executable bits (owner+group+other execute)
    if (!isWindows) {
      expect(stat.mode & 0o755).toBe(0o755);
    }

    const content = await fs.readFile(scriptPath, 'utf8');
    expect(content).toBe(renderTickScript(baseOpts));
  });

  it('creates CMD file without chmod on win32', async () => {
    const scriptPath = join(testDir, 'tick.cmd');
    await writeTickScript(scriptPath, baseOpts, 'win32');

    const content = await fs.readFile(scriptPath, 'utf8');
    expect(content).toContain('@echo off');
    expect(content).toContain('setlocal');
  });
});

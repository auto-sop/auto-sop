/**
 * Runtime smoke tests — runs BUILT artifacts (dist/).
 * Requires `npm run build` to have been run first.
 * Invoked via: npm run test:smoke
 */
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { readFileSync, mkdtempSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'dist/cli.js');
const SHIM = resolve(ROOT, 'dist/plugin/shim.cjs');
const LEARNER = resolve(ROOT, 'dist/plugin/learner.cjs');
const CAPTURE_SHIM = resolve(ROOT, 'dist/capture/shim.cjs');
const HOOKS = resolve(ROOT, 'dist/plugin/hooks/hooks.json');

describe('smoke: CLI binary', () => {
  it('--help exits 0 and lists expected commands', async () => {
    const result = await execa('node', [CLI, '--help']);
    expect(result.exitCode).toBe(0);
    for (const keyword of ['claude-sop', 'install', 'status', 'uninstall']) {
      expect(result.stdout.toLowerCase()).toContain(keyword);
    }
  });

  it('--version exits 0 and prints semver', async () => {
    const result = await execa('node', [CLI, '--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('status --json in temp dir exits 0 or 3, outputs valid JSON', async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'claude-sop-smoke-'));
    const result = await execa('node', [CLI, 'status', '--json'], {
      cwd: tmp,
      reject: false,
      env: { HOME: tmp },
    });
    // exit 0 (installed) or 3 (not installed) are both acceptable
    expect([0, 3]).toContain(result.exitCode);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});

describe('smoke: plugin shim', () => {
  it('shim exits 0 (fail-open) with synthetic UserPromptSubmit on stdin', async () => {
    const payload = JSON.stringify({
      hook_type: 'UserPromptSubmit',
      session_id: 'smoke-test',
      user_prompt: 'hello',
    });
    const start = Date.now();
    const result = await execa('node', [SHIM], {
      input: payload,
      reject: false,
      env: { CLAUDE_SOP_LEARNER: '1', HOME: mkdtempSync(resolve(tmpdir(), 'shim-smoke-')) },
      timeout: 5000,
    });
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('smoke: plugin bundle artifacts', () => {
  it('hooks.json parses and contains all 5 hook events', () => {
    const raw = readFileSync(HOOKS, 'utf8');
    const parsed = JSON.parse(raw);
    const events = Object.keys(parsed.hooks);
    expect(events).toContain('UserPromptSubmit');
    expect(events).toContain('Stop');
    expect(events).toContain('SubagentStop');
    expect(events).toContain('PreToolUse');
    expect(events).toContain('PostToolUse');
    expect(events).toHaveLength(5);
  });

  it('marketplace.json exists, parses, and has correct schema', () => {
    const mp = resolve(ROOT, 'dist/plugin/.claude-plugin/marketplace.json');
    const raw = readFileSync(mp, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe('claude-sop');
    expect(parsed.owner.name).toEqual(expect.any(String));
    expect(parsed.owner.name.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.plugins)).toBe(true);
    expect(parsed.plugins.length).toBeGreaterThan(0);
    expect(parsed.plugins[0].name).toBe('claude-sop');
    // Source shape guard: must be string OR object-with-'type', never nested 'source'
    const src = parsed.plugins[0].source;
    const isString = typeof src === 'string';
    const isObjWithType =
      typeof src === 'object' && src !== null && typeof src.type === 'string';
    expect(isString || isObjWithType).toBe(true);
    // REGRESSION GUARD: no nested source.source
    if (typeof src === 'object' && src !== null) {
      expect(src).not.toHaveProperty('source');
    }
  });

  it('plugin.json exists, parses, and name is claude-sop', () => {
    const pj = resolve(ROOT, 'dist/plugin/.claude-plugin/plugin.json');
    const raw = readFileSync(pj, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe('claude-sop');
  });
});

describe('smoke: learner stub', () => {
  it('learner.cjs exits 0 in under 500ms', async () => {
    const start = Date.now();
    const result = await execa('node', [LEARNER], {
      reject: false,
      env: { HOME: mkdtempSync(resolve(tmpdir(), 'learner-smoke-')) },
      timeout: 5000,
    });
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('smoke: shell-mode execution (shebang)', () => {
  it('shim runs via sh -c without syntax errors', async () => {
    const payload = JSON.stringify({
      hook_type: 'UserPromptSubmit',
      session_id: 'smoke-shell',
      user_prompt: 'hello',
    });
    const start = Date.now();
    const result = await execa('sh', ['-c', `"${SHIM}"`], {
      input: payload,
      reject: false,
      env: {
        CLAUDE_SOP_LEARNER: '1',
        HOME: mkdtempSync(resolve(tmpdir(), 'shim-shell-')),
        PATH: process.env.PATH,
      },
      timeout: 5000,
    });
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(500);
    expect(result.stderr).not.toMatch(/syntax error/);
  });

  it('learner runs via sh -c without syntax errors', async () => {
    const start = Date.now();
    const result = await execa('sh', ['-c', `"${LEARNER}"`], {
      reject: false,
      env: {
        HOME: mkdtempSync(resolve(tmpdir(), 'learner-shell-')),
        PATH: process.env.PATH,
      },
      timeout: 5000,
    });
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(500);
    expect(result.stderr).not.toMatch(/syntax error/);
  });
});

describe('smoke: shebang and exec bit', () => {
  const executables = [
    { name: 'plugin/shim.cjs', path: SHIM },
    { name: 'plugin/learner.cjs', path: LEARNER },
    { name: 'capture/shim.cjs', path: CAPTURE_SHIM },
  ];

  for (const { name, path: filePath } of executables) {
    it(`${name} starts with shebang`, () => {
      const buf = Buffer.alloc(20);
      const fd = require('node:fs').openSync(filePath, 'r');
      require('node:fs').readSync(fd, buf, 0, 20, 0);
      require('node:fs').closeSync(fd);
      const head = buf.toString('utf8');
      expect(head).toMatch(/^#!\/usr\/bin\/env node\n/);
    });

    it(`${name} has exec bit set`, () => {
      const st = statSync(filePath);
      // eslint-disable-next-line no-bitwise
      expect(st.mode & 0o111).not.toBe(0);
    });
  }
});

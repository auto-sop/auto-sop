/**
 * Runtime smoke tests — runs BUILT artifacts (dist/).
 * Requires `npm run build` to have been run first.
 * Invoked via: npm run test:smoke
 */
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'dist/cli.js');
const SHIM = resolve(ROOT, 'dist/plugin/shim.cjs');
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
    const learner = resolve(ROOT, 'dist/plugin/learner.cjs');
    const start = Date.now();
    const result = await execa('node', [learner], {
      reject: false,
      env: { HOME: mkdtempSync(resolve(tmpdir(), 'learner-smoke-')) },
      timeout: 5000,
    });
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });
});

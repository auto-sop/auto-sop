/**
 * Runtime smoke tests — runs BUILT artifacts (dist/).
 * Requires `npm run build` to have been run first.
 * Invoked via: npm run test:smoke
 */
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
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
});

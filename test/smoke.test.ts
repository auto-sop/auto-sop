/**
 * Runtime smoke tests — runs BUILT artifacts (dist/).
 * Requires `npm run build` to have been run first.
 * Invoked via: npm run test:smoke
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import {
  readFileSync,
  mkdtempSync,
  statSync,
  existsSync,
  readdirSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
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

describe('smoke: isolated end-to-end capture pipeline', () => {
  let tmpRoot: string;

  afterAll(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  /** Recursively find all files matching a name under a directory. */
  function findFiles(dir: string, name: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFiles(full, name));
      } else if (entry.name === name) {
        results.push(full);
      }
    }
    return results;
  }

  /** Collect diagnostic info for timeout failures, including writer re-run. */
  function collectDiagnostics(home: string, bundleDir: string): string {
    const lines: string[] = ['--- writer / tmp payload diagnostic ---'];
    const tmpDir = join(home, '.claude-sop', 'tmp');
    const capturesDir = join(home, '.claude-sop', 'captures');
    const errorsLog = join(home, '.claude-sop', 'errors.jsonl');

    try {
      const tmpFiles = existsSync(tmpDir) ? readdirSync(tmpDir) : [];
      lines.push(`tmp/: ${tmpFiles.join(', ') || '(empty)'}`);

      // Re-run writer against first stranded payload for diagnostics
      if (tmpFiles.length > 0) {
        const firstPayload = join(tmpDir, tmpFiles[0]);
        const writerPath = join(bundleDir, 'writer.cjs');
        try {
          const diag = execSync(`node "${writerPath}" "${firstPayload}" 2>&1`, {
            timeout: 5000,
            env: { ...process.env, HOME: home, PATH: process.env.PATH, NODE_OPTIONS: '' },
          });
          lines.push(`writer re-run stdout:\n${diag.toString().slice(0, 2000)}`);
        } catch (e: unknown) {
          const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
          lines.push(`writer re-run FAILED:\n${err.stderr?.toString().slice(0, 2000) || err.message || '(no output)'}`);
          if (err.stdout) lines.push(`writer re-run stdout:\n${err.stdout.toString().slice(0, 1000)}`);
        }
      }
    } catch { lines.push('tmp/: (read error)'); }
    try {
      lines.push(`captures/: ${existsSync(capturesDir) ? readdirSync(capturesDir).join(', ') || '(empty)' : '(missing)'}`);
    } catch { lines.push('captures/: (read error)'); }
    try {
      if (existsSync(errorsLog)) {
        lines.push(`errors.jsonl:\n${readFileSync(errorsLog, 'utf8').slice(0, 2000)}`);
      }
    } catch { /* ignore */ }
    return lines.join('\n');
  }

  it('writer.cjs exists in plugin bundle', () => {
    const WRITER = resolve(ROOT, 'dist/plugin/writer.cjs');
    expect(existsSync(WRITER)).toBe(true);
  });

  it('writer.cjs has no shebang', () => {
    const WRITER = resolve(ROOT, 'dist/plugin/writer.cjs');
    const buf = Buffer.alloc(2);
    const fd = require('node:fs').openSync(WRITER, 'r');
    require('node:fs').readSync(fd, buf, 0, 2, 0);
    require('node:fs').closeSync(fd);
    expect(buf.toString('utf8')).not.toBe('#!');
  });

  it('isolated shim → writer pipeline produces turn.json for UserPromptSubmit', async () => {
    // Create tmpRoot OUTSIDE the repo tree so require() can't walk up to repo node_modules
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'claude-sop-isolated-'));
    const bundleDir = join(tmpRoot, 'bundle');

    // Copy the entire dist/plugin/ bundle to tmpRoot/bundle/
    cpSync(resolve(ROOT, 'dist/plugin'), bundleDir, { recursive: true });

    const shimPath = join(bundleDir, 'shim.cjs');

    // Exact payload shape from src/capture/events.ts — UserPromptSubmit schema
    const payload = JSON.stringify({
      session_id: 'e2e-isolated-smoke',
      transcript_path: '/dev/null',
      cwd: tmpRoot,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'isolated e2e smoke test prompt',
    });

    // Spawn the shim from the ISOLATED bundle dir (not from repo tree)
    const result = await execa('sh', ['-c', `"${shimPath}"`], {
      input: payload,
      reject: false,
      env: {
        HOME: tmpRoot,
        PATH: process.env.PATH,
        NODE_OPTIONS: '',
      },
      cwd: tmpRoot,
      timeout: 5000,
    });

    // Shim must exit 0 and not crash
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(/Cannot find module/);
    expect(result.stderr).not.toMatch(/syntax error/i);

    // Writer is a detached grandchild — poll for meta.json up to 5s
    const capturesDir = join(tmpRoot, '.claude-sop', 'captures');
    const deadline = Date.now() + 5000;
    let metaFiles: string[] = [];

    while (Date.now() < deadline) {
      metaFiles = findFiles(capturesDir, 'meta.json');
      if (metaFiles.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    if (metaFiles.length === 0) {
      throw new Error(
        `Timed out waiting for writer to produce meta.json in isolated environment.\n${collectDiagnostics(tmpRoot, bundleDir)}`,
      );
    }

    // Assert: exactly one meta.json (= one turn)
    expect(metaFiles).toHaveLength(1);

    // Assert: parses as valid JSON with expected fields
    const meta = JSON.parse(readFileSync(metaFiles[0], 'utf8'));
    expect(meta.session_id).toBe('e2e-isolated-smoke');
    expect(meta.schema_version).toBe(1);
    expect(meta.started_at).toEqual(expect.any(String));
    expect(meta.turn_id).toEqual(expect.any(String));

    // Assert: prompt.md sibling exists
    const turnDir = dirname(metaFiles[0]);
    expect(existsSync(join(turnDir, 'prompt.md'))).toBe(true);

    // Assert: turn dir is .pending (no Stop was sent)
    expect(turnDir).toMatch(/\.pending$/);

    // Assert: no .pending siblings left over (clean write)
    const turnParent = dirname(turnDir);
    const pendingSiblings = readdirSync(turnParent).filter(
      (f) => f.endsWith('.pending') && join(turnParent, f) !== turnDir,
    );
    expect(pendingSiblings).toEqual([]);
  }, 10000);

  it('writer.cjs bundles all non-node runtime deps (regression guard)', () => {
    const WRITER = resolve(ROOT, 'dist/plugin/writer.cjs');
    const content = readFileSync(WRITER, 'utf8');

    // Extract all require("...") calls
    const requireMatches = [...content.matchAll(/require\(["']([^"']+)["']\)/g)];
    const requiredModules = requireMatches.map((m) => m[1]);

    // Node.js built-in modules
    const NODE_BUILTINS = new Set([
      'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
      'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events',
      'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
      'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
      'repl', 'stream', 'stream/promises', 'string_decoder', 'timers',
      'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8',
      'vm', 'wasi', 'worker_threads', 'zlib', 'async_hooks',
    ]);

    // Filter: keep only bare requires that are NOT node: prefixed, NOT relative, NOT builtins
    const bareRequires = requiredModules.filter((mod) => {
      if (mod.startsWith('node:')) return false;
      if (mod.startsWith('./') || mod.startsWith('../')) return false;
      if (NODE_BUILTINS.has(mod)) return false;
      // Handle subpath imports like 'stream/promises'
      const topLevel = mod.split('/')[0];
      if (NODE_BUILTINS.has(topLevel)) return false;
      return true;
    });

    if (bareRequires.length > 0) {
      const unique = [...new Set(bareRequires)];
      throw new Error(
        `Found ${unique.length} bare (non-bundled) require(s) in writer.cjs: ${JSON.stringify(unique)}. ` +
          'These will crash at runtime in an installed bundle where node_modules is absent.',
      );
    }
    expect(bareRequires).toEqual([]);
  });
});

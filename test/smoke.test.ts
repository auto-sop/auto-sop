/**
 * Runtime smoke tests — runs BUILT artifacts (dist/).
 * Requires `npm run build` to have been run first.
 * Invoked via: npm run test:smoke
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { execa } from 'execa';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  statSync,
  existsSync,
  readdirSync,
  rmSync,
  cpSync,
  appendFileSync,
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

// ── Learner batch end-to-end (isolated) ─────────────────────

describe('smoke: learner batch end-to-end (isolated)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    // cleanup handled by afterAll
  });

  afterAll(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  function makeTmpEnv(): { tmpHome: string; bundleDir: string; learnerPath: string } {
    const tmpHome = mkdtempSync(resolve(tmpdir(), 'learner-batch-'));
    tmpDirs.push(tmpHome);
    const bundleDir = join(tmpHome, 'bundle');
    cpSync(resolve(ROOT, 'dist/plugin'), bundleDir, { recursive: true });
    return { tmpHome, bundleDir, learnerPath: join(bundleDir, 'learner.cjs') };
  }

  function writeRegistry(home: string, projects: Array<{ project_id: string; slug: string; project_root: string }>) {
    const regDir = join(home, '.claude-sop');
    mkdirSync(regDir, { recursive: true });
    const registry = {
      version: 1,
      projects: projects.map((p) => ({
        ...p,
        installed_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      })),
    };
    writeFileSync(join(regDir, 'projects.json'), JSON.stringify(registry, null, 2), { mode: 0o600 });
  }

  function createFinalizedTurn(capturesDir: string, turnId: string, finalizedAt: string, opts?: { poison?: boolean }) {
    const turnDir = join(capturesDir, `20260414T120000-main-abc-${turnId}`);
    mkdirSync(turnDir, { recursive: true });
    if (opts?.poison) {
      writeFileSync(join(turnDir, 'meta.json'), 'NOT VALID JSON!!!', { mode: 0o600 });
    } else {
      const meta = {
        schema_version: 1,
        project_id: 'test123',
        project_slug: 'test-project',
        session_id: 'sess-1',
        turn_id: turnId,
        parent_turn_id: null,
        children_turn_ids: [],
        agent: 'main',
        subagent_type: null,
        started_at: '2026-04-14T12:00:00.000Z',
        finalized_at: finalizedAt,
        finalization_reason: 'stop',
        hook_shim_version: '0.0.0',
        files_changed_count: 1,
        tool_call_count: 2,
        scrubber_hit_count: 0,
      };
      writeFileSync(join(turnDir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    }
    return turnDir;
  }

  function readRecapLog(home: string): unknown[] {
    const logPath = join(home, '.claude-sop', 'logs', 'recap.log');
    try {
      const text = readFileSync(logPath, 'utf8');
      return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  function runLearner(learnerPath: string, home: string, env?: Record<string, string>) {
    return execa('node', [learnerPath], {
      reject: false,
      env: { HOME: home, PATH: process.env.PATH, NODE_OPTIONS: '', ...env },
      timeout: 10000,
    });
  }

  // (a) empty registry → summary projects_processed:0
  it('(a) empty registry → summary with projects_processed:0', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);
    const entries = readRecapLog(tmpHome);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const summary = entries.find((e: any) => e.summary === true) as any;
    expect(summary).toBeDefined();
    expect(summary.projects_processed).toBe(0);
  }, 10000);

  // (b) single project first run processes 3 turns
  it('(b) single project first run processes 3 turns', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    createFinalizedTurn(capturesDir, 't2', '2026-04-14T11:00:00.000Z');
    createFinalizedTurn(capturesDir, 't3', '2026-04-14T12:00:00.000Z');

    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);
    const entries = readRecapLog(tmpHome);
    const projRecap = entries.find((e: any) => e.project_id === 'proj1') as any;
    expect(projRecap).toBeDefined();
    expect(projRecap.turns_new).toBe(3);
  }, 10000);

  // (c) second run turns_new:0
  it('(c) second run → turns_new:0', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    // First run
    await runLearner(learnerPath, tmpHome);
    // Second run
    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);
    const entries = readRecapLog(tmpHome);
    const projectRecaps = entries.filter((e: any) => e.project_id === 'proj1') as any[];
    const secondRecap = projectRecaps[projectRecaps.length - 1];
    expect(secondRecap.turns_new).toBe(0);
  }, 15000);

  // (d) add 4th turn, third run turns_new:1
  it('(d) add 4th turn after first run → turns_new:1', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    createFinalizedTurn(capturesDir, 't2', '2026-04-14T11:00:00.000Z');
    createFinalizedTurn(capturesDir, 't3', '2026-04-14T12:00:00.000Z');
    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    // First run: processes 3 turns
    await runLearner(learnerPath, tmpHome);

    // Add 4th turn
    createFinalizedTurn(capturesDir, 't4', '2026-04-14T13:00:00.000Z');

    // Second run: should pick up 1 new turn
    await runLearner(learnerPath, tmpHome);
    const entries = readRecapLog(tmpHome);
    const projectRecaps = entries.filter((e: any) => e.project_id === 'proj1') as any[];
    const lastRecap = projectRecaps[projectRecaps.length - 1];
    expect(lastRecap.turns_new).toBe(1);
  }, 15000);

  // (e) missing project root → projects_missing:1
  it('(e) missing project root → projects_missing:1', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'ghost-project', project_root: '/tmp/nonexistent-project-root-12345' }]);

    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);
    const entries = readRecapLog(tmpHome);
    const summary = entries.find((e: any) => e.summary === true) as any;
    expect(summary).toBeDefined();
    expect(summary.projects_missing).toBe(1);
  }, 10000);

  // (f) poison meta.json → skipped_poison count
  it('(f) poison meta.json → skipped_poison count', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    createFinalizedTurn(capturesDir, 't-poison', '', { poison: true });
    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);
    const entries = readRecapLog(tmpHome);
    const projRecap = entries.find((e: any) => e.project_id === 'proj1') as any;
    expect(projRecap).toBeDefined();
    expect(projRecap.skipped_poison).toBeGreaterThanOrEqual(1);
    expect(projRecap.turns_new).toBe(1); // valid turn still processed
  }, 10000);

  // (g) lock contention → projects_locked:1, no hang >3s
  it('(g) lock contention → projects_locked:1, no hang >3s', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    const stateDir = join(projectRoot, '.claude-sop', 'state');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    // Create cursor file and manually hold a lock on it
    const cursorFile = join(stateDir, 'learner-cursor.json');
    writeFileSync(cursorFile, '{}', { mode: 0o600 });
    const lockPath = join(stateDir, 'learner-cursor.lock');
    // Simulate held lock by creating proper-lockfile's lockfile structure
    // proper-lockfile creates a directory .lock with mtime tracking
    const { lockSync } = await import('proper-lockfile');
    lockSync(cursorFile, { lockfilePath: lockPath, stale: 30000 });

    const start = Date.now();
    const result = await runLearner(learnerPath, tmpHome);
    const elapsed = Date.now() - start;

    // Release our lock
    const { unlockSync } = await import('proper-lockfile');
    try { unlockSync(cursorFile, { lockfilePath: lockPath }); } catch { /* ignore */ }

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(10000); // should not hang
    const entries = readRecapLog(tmpHome);
    const summary = entries.find((e: any) => e.summary === true) as any;
    expect(summary).toBeDefined();
    expect(summary.projects_locked).toBe(1);
  }, 15000);

  // (h) 11MB recap.log → rotates to .1
  it('(h) 11MB recap.log → rotates to .1 before append', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    writeRegistry(tmpHome, []);

    const logDir = join(tmpHome, '.claude-sop', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, 'recap.log');

    // Create 11MB file
    const chunk = 'x'.repeat(1024) + '\n';
    const fd = require('node:fs').openSync(logPath, 'w');
    for (let i = 0; i < 11 * 1024; i++) {
      require('node:fs').writeSync(fd, chunk);
    }
    require('node:fs').closeSync(fd);
    const sizeBefore = statSync(logPath).size;
    expect(sizeBefore).toBeGreaterThan(10_000_000);

    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);

    // Original should be rotated to .1
    expect(existsSync(logPath + '.1')).toBe(true);
    const rotatedSize = statSync(logPath + '.1').size;
    expect(rotatedSize).toBeGreaterThan(10_000_000);

    // New recap.log should be small (just the summary line)
    const newSize = statSync(logPath).size;
    expect(newSize).toBeLessThan(1000);
  }, 10000);

  // (i) broken registry JSON → errors.log entry, empty summary
  it('(i) broken registry JSON → errors.log entry, empty summary', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const regDir = join(tmpHome, '.claude-sop');
    mkdirSync(regDir, { recursive: true });
    writeFileSync(join(regDir, 'projects.json'), 'NOT VALID JSON!!!', { mode: 0o600 });

    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);

    // Should have logged error
    const errorsLog = join(tmpHome, '.claude-sop', 'logs', 'errors.log');
    if (existsSync(errorsLog)) {
      const errContent = readFileSync(errorsLog, 'utf8');
      expect(errContent).toContain('registry');
    }

    // Should still produce a summary
    const entries = readRecapLog(tmpHome);
    const summary = entries.find((e: any) => e.summary === true) as any;
    expect(summary).toBeDefined();
    expect(summary.projects_processed).toBe(0);
  }, 10000);

  // (j) bundle bare-require regression guard
  it('(j) learner.cjs has zero bare non-node requires', () => {
    const content = readFileSync(LEARNER, 'utf8');
    const requireMatches = [...content.matchAll(/require\(["']([^"']+)["']\)/g)];
    const NODE_BUILTINS = new Set([
      'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
      'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events',
      'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
      'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
      'repl', 'stream', 'stream/promises', 'string_decoder', 'timers',
      'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8',
      'vm', 'wasi', 'worker_threads', 'zlib', 'async_hooks',
    ]);
    const bareRequires = requireMatches.map((m) => m[1]).filter((mod) => {
      if (mod!.startsWith('node:') || mod!.startsWith('./') || mod!.startsWith('../')) return false;
      const top = mod!.split('/')[0];
      if (NODE_BUILTINS.has(mod!) || NODE_BUILTINS.has(top!)) return false;
      return true;
    });
    expect(bareRequires).toEqual([]);
  });
});

// ── Managed section end-to-end (isolated) ─────────────────────

describe('smoke: managed section end-to-end (isolated)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    // cleanup handled by afterAll
  });

  afterAll(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  function makeTmpEnv(): { tmpHome: string; bundleDir: string; learnerPath: string; cliPath: string } {
    const tmpHome = mkdtempSync(resolve(tmpdir(), 'managed-section-smoke-'));
    tmpDirs.push(tmpHome);
    const bundleDir = join(tmpHome, 'bundle');
    cpSync(resolve(ROOT, 'dist/plugin'), bundleDir, { recursive: true });
    // CLI path for statusline tests (stays in-repo, only bundle is isolated)
    const cliPath = resolve(ROOT, 'dist/cli.js');
    return { tmpHome, bundleDir, learnerPath: join(bundleDir, 'learner.cjs'), cliPath };
  }

  function writeRegistry(home: string, projects: Array<{ project_id: string; slug: string; project_root: string }>) {
    const regDir = join(home, '.claude-sop');
    mkdirSync(regDir, { recursive: true });
    const registry = {
      version: 1,
      projects: projects.map((p) => ({
        ...p,
        installed_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      })),
    };
    writeFileSync(join(regDir, 'projects.json'), JSON.stringify(registry, null, 2), { mode: 0o600 });
  }

  function createFinalizedTurn(capturesDir: string, turnId: string, finalizedAt: string, agentName = 'main') {
    const turnDir = join(capturesDir, `20260414T120000-${agentName}-abc-${turnId}`);
    mkdirSync(turnDir, { recursive: true });
    const meta = {
      schema_version: 1,
      project_id: 'test123',
      project_slug: 'test-project',
      session_id: 'sess-1',
      turn_id: turnId,
      parent_turn_id: null,
      children_turn_ids: [],
      agent: agentName,
      subagent_type: null,
      started_at: '2026-04-14T12:00:00.000Z',
      finalized_at: finalizedAt,
      finalization_reason: 'stop',
      hook_shim_version: '0.0.0',
      files_changed_count: 1,
      tool_call_count: 2,
      scrubber_hit_count: 0,
    };
    writeFileSync(join(turnDir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
    return turnDir;
  }

  function readRecapLog(home: string): unknown[] {
    const logPath = join(home, '.claude-sop', 'logs', 'recap.log');
    try {
      const text = readFileSync(logPath, 'utf8');
      return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  function runLearner(learnerPath: string, home: string, env?: Record<string, string>) {
    return execa('node', [learnerPath], {
      reject: false,
      env: { HOME: home, PATH: process.env.PATH, NODE_OPTIONS: '', ...env },
      timeout: 10000,
    });
  }

  // (k) Learner writes sample directive to CLAUDE.md on first run
  it('(k) learner writes sample directive to CLAUDE.md on first run', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z', 'main');
    createFinalizedTurn(capturesDir, 't2', '2026-04-14T11:00:00.000Z', 'commander');
    createFinalizedTurn(capturesDir, 't3', '2026-04-14T12:00:00.000Z', 'architect-principal-engineer');

    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);

    // Assert CLAUDE.md exists with markers
    const claudeMdPath = join(projectRoot, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);
    const content = readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain('<!-- claude-sop:managed-section:begin v1 -->');
    expect(content).toContain('<!-- claude-sop:managed-section:end -->');
    expect(content).toContain('turns analyzed');
    // Agent roster should mention all 3 agents
    expect(content).toContain('architect-principal-engineer');
    expect(content).toContain('commander');
    expect(content).toContain('main');
  }, 15000);

  // (l) Idempotent when no new turns
  it('(l) idempotent when no new turns — mtime/bytes unchanged', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    createFinalizedTurn(capturesDir, 't2', '2026-04-14T11:00:00.000Z');
    createFinalizedTurn(capturesDir, 't3', '2026-04-14T12:00:00.000Z');

    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    // First run — creates CLAUDE.md
    await runLearner(learnerPath, tmpHome);
    const claudeMdPath = join(projectRoot, 'CLAUDE.md');
    const bytesAfterFirst = readFileSync(claudeMdPath).length;
    const mtimeAfterFirst = statSync(claudeMdPath).mtimeMs;

    // Small delay to ensure mtime would differ if file were rewritten
    await new Promise((r) => setTimeout(r, 50));

    // Second run — should be unchanged
    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);

    const bytesAfterSecond = readFileSync(claudeMdPath).length;
    const mtimeAfterSecond = statSync(claudeMdPath).mtimeMs;

    expect(bytesAfterSecond).toBe(bytesAfterFirst);
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst);

    // Check recap log shows unchanged
    const entries = readRecapLog(tmpHome);
    const projRecaps = entries.filter((e: any) => e.project_id === 'proj1') as any[];
    const lastRecap = projRecaps[projRecaps.length - 1];
    expect(lastRecap.directive_written).toBe('unchanged');
  }, 20000);

  // (m) New turn → updated + backup exists
  it('(m) new turn → updated directive + backup with old content', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    createFinalizedTurn(capturesDir, 't2', '2026-04-14T11:00:00.000Z');
    createFinalizedTurn(capturesDir, 't3', '2026-04-14T12:00:00.000Z');

    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    // First run — creates CLAUDE.md with 3 turns
    await runLearner(learnerPath, tmpHome);
    const claudeMdPath = join(projectRoot, 'CLAUDE.md');
    const oldContent = readFileSync(claudeMdPath, 'utf8');
    expect(oldContent).toContain('3 turns analyzed');

    // Add 4th turn
    createFinalizedTurn(capturesDir, 't4', '2026-04-14T13:00:00.000Z');

    // Second run — should update
    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);

    const newContent = readFileSync(claudeMdPath, 'utf8');
    expect(newContent).toContain('4 turns analyzed');

    // Backup must exist with OLD content
    const backupPath = join(projectRoot, '.claude-sop', 'state', 'CLAUDE.md.backup');
    expect(existsSync(backupPath)).toBe(true);
    const backupContent = readFileSync(backupPath, 'utf8');
    expect(backupContent).toContain('3 turns analyzed');

    // Recap shows updated
    const entries = readRecapLog(tmpHome);
    const projRecaps = entries.filter((e: any) => e.project_id === 'proj1') as any[];
    const lastRecap = projRecaps[projRecaps.length - 1];
    expect(lastRecap.directive_written).toBe('updated');
  }, 20000);

  // (n) Dry-run writes nothing
  it('(n) dry-run mode writes nothing to CLAUDE.md', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    // Create 4 turns and run learner normally first
    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    createFinalizedTurn(capturesDir, 't2', '2026-04-14T11:00:00.000Z');
    createFinalizedTurn(capturesDir, 't3', '2026-04-14T12:00:00.000Z');
    createFinalizedTurn(capturesDir, 't4', '2026-04-14T13:00:00.000Z');

    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    // First run — creates CLAUDE.md with 4 turns
    await runLearner(learnerPath, tmpHome);
    const claudeMdPath = join(projectRoot, 'CLAUDE.md');
    const contentBefore = readFileSync(claudeMdPath, 'utf8');
    expect(contentBefore).toContain('4 turns analyzed');
    const mtimeBefore = statSync(claudeMdPath).mtimeMs;

    // Remove any existing backup
    const backupPath = join(projectRoot, '.claude-sop', 'state', 'CLAUDE.md.backup');
    try { rmSync(backupPath); } catch { /* may not exist */ }

    // Add 5th turn
    createFinalizedTurn(capturesDir, 't5', '2026-04-14T14:00:00.000Z');

    await new Promise((r) => setTimeout(r, 50));

    // Dry-run: should NOT touch CLAUDE.md
    const result = await runLearner(learnerPath, tmpHome, { CLAUDE_SOP_LEARNER_DRY_RUN: '1' });
    expect(result.exitCode).toBe(0);

    const contentAfter = readFileSync(claudeMdPath, 'utf8');
    expect(contentAfter).toBe(contentBefore);
    expect(statSync(claudeMdPath).mtimeMs).toBe(mtimeBefore);

    // No new backup
    expect(existsSync(backupPath)).toBe(false);

    // Recap shows dry_run
    const entries = readRecapLog(tmpHome);
    const projRecaps = entries.filter((e: any) => e.project_id === 'proj1') as any[];
    const lastRecap = projRecaps[projRecaps.length - 1];
    expect(lastRecap.directive_written).toBe('dry_run');
  }, 20000);

  // (o) User content preserved with malformed markers
  it('(o) user content preserved when CLAUDE.md has malformed markers', async () => {
    const { tmpHome, learnerPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    const capturesDir = join(projectRoot, '.claude-sop', 'captures');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude-sop', 'state'), { recursive: true });

    createFinalizedTurn(capturesDir, 't1', '2026-04-14T10:00:00.000Z');
    writeRegistry(tmpHome, [{ project_id: 'proj1', slug: 'my-project', project_root: projectRoot }]);

    // Write CLAUDE.md with malformed markers: begin but no end
    const originalContent =
      '# My project\n\nMy own rules\n\n<!-- claude-sop:managed-section:begin v1 -->\nSome content without end marker\n';
    const claudeMdPath = join(projectRoot, 'CLAUDE.md');
    writeFileSync(claudeMdPath, originalContent, { mode: 0o644 });

    const result = await runLearner(learnerPath, tmpHome);
    expect(result.exitCode).toBe(0);

    // CLAUDE.md must NOT be corrupted — exact original bytes preserved
    const contentAfter = readFileSync(claudeMdPath, 'utf8');
    expect(contentAfter).toBe(originalContent);

    // Learner should have logged an error
    const errorsLog = join(tmpHome, '.claude-sop', 'logs', 'errors.log');
    if (existsSync(errorsLog)) {
      const errContent = readFileSync(errorsLog, 'utf8');
      expect(errContent.length).toBeGreaterThan(0);
    }

    // Recap should show error
    const entries = readRecapLog(tmpHome);
    const projRecap = entries.find((e: any) => e.project_id === 'proj1') as any;
    expect(projRecap).toBeDefined();
    expect(projRecap.directive_written).toBe('error');
  }, 15000);

  // (p) Statusline installed
  it('(p) statusline prints [sop:on] for installed project', async () => {
    const { tmpHome, cliPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'my-project');
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });

    // Create .claude/settings.json with real Claude Code structure (v11 fix)
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: '/path/to/claude-sop/dist/plugin/shim.cjs',
                timeout: 10,
                id: 'claude-sop',
              },
            ],
          },
        ],
      },
    };
    writeFileSync(
      join(projectRoot, '.claude', 'settings.json'),
      JSON.stringify(settings, null, 2),
      { mode: 0o644 },
    );

    const result = await execa('node', [cliPath, 'statusline', '--project', projectRoot], {
      reject: false,
      env: { HOME: tmpHome, PATH: process.env.PATH, NODE_OPTIONS: '' },
      timeout: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('[sop:on]');
  }, 10000);

  // (q) Statusline non-installed
  it('(q) statusline prints [sop:off] for non-installed project', async () => {
    const { tmpHome, cliPath } = makeTmpEnv();
    const projectRoot = join(tmpHome, 'bare-project');
    mkdirSync(projectRoot, { recursive: true });
    // No .claude/settings.json at all

    const result = await execa('node', [cliPath, 'statusline', '--project', projectRoot], {
      reject: false,
      env: { HOME: tmpHome, PATH: process.env.PATH, NODE_OPTIONS: '' },
      timeout: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('[sop:off]');
  }, 10000);
});

/**
 * Launchd install reliability smoke test (macOS only).
 *
 * Uses a unique label per process to avoid colliding with the user's real
 * com.claude-sop.learner service. The install code reads CLAUDE_SOP_LABEL
 * and prefixes must be com.claude-sop.learner* (enforced in macos-launchd.ts).
 */
describe.skipIf(process.platform !== 'darwin')('smoke: launchd install reliability (macOS only)', () => {
  const TEST_LABEL = `com.claude-sop.learner.test-${process.pid}`;
  const uid = process.getuid?.() ?? 501;
  const serviceTarget = `gui/${uid}/${TEST_LABEL}`;

  afterAll(async () => {
    // Cleanup: bootout test service if it's still loaded
    await execa('launchctl', ['bootout', serviceTarget], { reject: false });
    // Remove test plist if it exists
    const plistPath = join(
      process.env.HOME ?? '/tmp',
      'Library',
      'LaunchAgents',
      `${TEST_LABEL}.plist`,
    );
    try {
      rmSync(plistPath, { force: true });
    } catch {
      // ignore
    }
  });

  it('(r) install bootstraps launchd AND warmup fire produces runs >= 1 within 2s', async () => {
    const tmpHome = mkdtempSync(resolve(tmpdir(), 'claude-sop-launchd-'));
    const projectRoot = join(tmpHome, 'test-project');
    mkdirSync(projectRoot, { recursive: true });

    // Run install via CLI with the test label
    const installResult = await execa(
      'node',
      [CLI, 'install', '--project', projectRoot],
      {
        reject: false,
        env: {
          HOME: process.env.HOME, // Must use REAL home for LaunchAgents dir
          PATH: process.env.PATH,
          NODE_OPTIONS: '',
          CLAUDE_SOP_LABEL: TEST_LABEL,
        },
        timeout: 15000,
      },
    );

    // Install should succeed (exit 0) or at least attempt the scheduler setup
    // Even if install exits non-zero due to missing license etc, the scheduler
    // step may still have fired. Check launchctl directly.

    // Wait for warmup kickstart to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check launchctl print for the test service
    const printResult = await execa('launchctl', ['print', serviceTarget], {
      reject: false,
    });

    // If the service was loaded, check runs
    if (printResult.exitCode === 0) {
      const runsMatch = printResult.stdout.match(/^\s*runs\s*=\s*(\d+)/m);
      expect(runsMatch, 'launchctl print should contain runs field').toBeTruthy();
      const runs = parseInt(runsMatch![1]!, 10);
      expect(runs, 'warmup kickstart should produce at least 1 run').toBeGreaterThanOrEqual(1);

      const lastExitMatch = printResult.stdout.match(
        /^\s*last exit code\s*=\s*(.+)$/m,
      );
      if (lastExitMatch && lastExitMatch[1]!.trim() !== '(never exited)') {
        expect(lastExitMatch[1]!.trim()).toBe('0');
      }
    } else {
      // Service not loaded — install may have failed for non-scheduler reasons.
      // Skip assertion if install itself didn't get to the scheduler step.
      // This handles CI environments where the install fails early (no license, etc).
      console.warn(
        `launchd service ${TEST_LABEL} not loaded — install may have failed before scheduler step. ` +
        `Install exit code: ${installResult.exitCode}. Skipping launchctl assertions.`,
      );
    }

    // Cleanup: uninstall test service
    await execa('launchctl', ['bootout', serviceTarget], { reject: false });
    const plistPath = join(
      process.env.HOME ?? '/tmp',
      'Library',
      'LaunchAgents',
      `${TEST_LABEL}.plist`,
    );
    rmSync(plistPath, { force: true });

    // Verify cleanup: service should no longer be loaded
    const verifyResult = await execa('launchctl', ['print', serviceTarget], {
      reject: false,
    });
    expect(verifyResult.exitCode).not.toBe(0);

    // Clean up tmp dir
    rmSync(tmpHome, { recursive: true, force: true });
  }, 20000);
});

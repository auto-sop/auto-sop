import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BENCH_WRITER_ENV, LEGACY_BENCH_WRITER_ENV, resolveBenchWriter } from '../main-bench.js';

const REPO_ROOT = process.cwd();
const BENCH_SCRIPT = join(REPO_ROOT, 'scripts', 'bench-capture-concurrency.sh');
const BUILT_BENCH_SHIM = join(REPO_ROOT, 'dist', 'capture', 'shim-bench.cjs');
const BUILT_WRITER = join(REPO_ROOT, 'dist', 'capture', 'writer.cjs');

/** Exit codes documented in the bench script header. */
const EXIT_PASS = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

/** A deliberately small session shape so each harness run stays fast. */
const SMALL_RUN = { turns: 1, tools: 2, subagentTools: 1 } as const;
/** UserPromptSubmit + a Pre/Post pair per tool call + SubagentStop + Stop. */
const EVENTS_PER_TURN = 1 + 2 * SMALL_RUN.tools + 2 * SMALL_RUN.subagentTools + 1 + 1;
/** Every hook invocation is one shim process that spawns one writer process. */
const NODE_PROCESSES_PER_INVOCATION = 2;
/** Lightweight mode keeps UserPromptSubmit, SubagentStop and Stop — one each per turn. */
const LIGHTWEIGHT_WRITERS_PER_TURN = 3;
const FULL_CAPTURE_PERCENT = 100;
const HARNESS_TIMEOUT_MS = 120_000;

interface BenchResult {
  mode: 'full' | 'lightweight';
  invocations: number;
  expectedInvocations: number;
  expectedWriterStarts: number;
  nodeProcessesSpawned: number;
  nodeProcessesByRole: { shim: number; writer: number; other: number };
  childProcessSpawns: Record<string, number>;
  hookLatencyMs: { n: number; p50: number; p95: number };
  peakConcurrentNodeProcesses: number;
  peakProcessRssMb: number;
  bytesWritten: number;
  capturedPercent: number;
  completeness: { toolCallLines: string };
  scrubbing: { canaryLeaks: number; redactionMarkers: number };
  verdict: 'PASS' | 'INVALID' | 'DEGRADED';
  invalid: string[];
  degraded: string[];
}

let workDir: string;

function runBench(
  sessions: number,
  env: Record<string, string> = {},
  extraArgs: string[] = [],
): { status: number | null; stdout: string; result: BenchResult | null } {
  const jsonPath = join(workDir, `result-${sessions}-${Date.now()}.json`);
  const proc = spawnSync(
    'bash',
    [
      BENCH_SCRIPT,
      String(sessions),
      '--turns',
      String(SMALL_RUN.turns),
      '--tools',
      String(SMALL_RUN.tools),
      '--subagent-tools',
      String(SMALL_RUN.subagentTools),
      '--think-ms',
      '0',
      '--transcript-kb',
      '4',
      '--json',
      jsonPath,
      ...extraArgs,
    ],
    { encoding: 'utf8', env: { ...process.env, ...env }, timeout: HARNESS_TIMEOUT_MS },
  );
  const result = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as BenchResult)
    : null;
  return { status: proc.status, stdout: proc.stdout, result };
}

/** Pull the sandbox path a failing run keeps, so the test can clean it up. */
function removeKeptSandbox(stdout: string): void {
  const kept = /sandbox kept[^:]*: (\S+)/.exec(stdout)?.[1];
  if (kept) rmSync(kept, { recursive: true, force: true });
}

describe('resolveBenchWriter', () => {
  const always = (): boolean => true;
  const never = (): boolean => false;

  it('uses the canonical env var', () => {
    expect(resolveBenchWriter({ [BENCH_WRITER_ENV]: '/w.cjs' }, always)).toBe('/w.cjs');
  });

  it('falls back to the legacy env var', () => {
    expect(resolveBenchWriter({ [LEGACY_BENCH_WRITER_ENV]: '/legacy.cjs' }, always)).toBe(
      '/legacy.cjs',
    );
  });

  it('prefers the canonical env var over the legacy one', () => {
    const env = { [BENCH_WRITER_ENV]: '/new.cjs', [LEGACY_BENCH_WRITER_ENV]: '/old.cjs' };
    expect(resolveBenchWriter(env, always)).toBe('/new.cjs');
  });

  it('throws when neither env var is set', () => {
    expect(() => resolveBenchWriter({}, always)).toThrow(/Neither AUTO_SOP_BENCH_WRITER/);
  });

  it('throws when the writer entry does not exist instead of spawning nothing', () => {
    expect(() => resolveBenchWriter({ [BENCH_WRITER_ENV]: '/missing.cjs' }, never)).toThrow(
      /does not exist: \/missing\.cjs/,
    );
  });
});

describe('bench-capture-concurrency.sh (against the build)', () => {
  beforeAll(() => {
    for (const artifact of [BUILT_BENCH_SHIM, BUILT_WRITER]) {
      if (!existsSync(artifact)) {
        throw new Error(`${artifact} is missing — run 'npm run build' before this suite`);
      }
    }
    workDir = mkdtempSync(join(tmpdir(), 'auto-sop-bench-test-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('built bench shim exits non-zero when its writer entry is missing', () => {
    const proc = spawnSync(process.execPath, [BUILT_BENCH_SHIM], {
      input: '{}',
      env: { ...process.env, [BENCH_WRITER_ENV]: join(workDir, 'no-such-writer.cjs') },
      encoding: 'utf8',
    });
    expect(proc.status).not.toBe(EXIT_PASS);
    expect(proc.stderr).toMatch(/does not exist/);
  });

  it('rejects a missing or out-of-range session count', () => {
    expect(spawnSync('bash', [BENCH_SCRIPT]).status).toBe(EXIT_USAGE);
    expect(spawnSync('bash', [BENCH_SCRIPT, '0']).status).toBe(EXIT_USAGE);
    expect(spawnSync('bash', [BENCH_SCRIPT, 'nine']).status).toBe(EXIT_USAGE);
  });

  it('rejects an unknown mode, and DEV_ARMY_* through --env, so counts always match the mode', () => {
    expect(spawnSync('bash', [BENCH_SCRIPT, '1', '--mode', 'turbo']).status).toBe(EXIT_USAGE);
    const viaEnv = spawnSync('bash', [BENCH_SCRIPT, '1', '--env', 'DEV_ARMY_PROJECT_NAME=x'], {
      encoding: 'utf8',
    });
    expect(viaEnv.status).toBe(EXIT_USAGE);
    expect(viaEnv.stderr).toMatch(/use --mode/);
  });

  it(
    'N=1 drives real shim and writer processes and every count matches the script',
    () => {
      const { status, stdout, result } = runBench(1);
      expect(status, stdout).toBe(EXIT_PASS);
      expect(result).not.toBeNull();
      const r = result!;
      const expected = EVENTS_PER_TURN * SMALL_RUN.turns;

      expect(r.verdict).toBe('PASS');
      expect(r.expectedInvocations).toBe(expected);
      expect(r.invocations).toBe(expected);
      expect(r.nodeProcessesByRole.shim).toBe(expected);
      expect(r.nodeProcessesByRole.writer).toBe(expected);
      expect(r.nodeProcessesSpawned).toBe(expected * NODE_PROCESSES_PER_INVOCATION);
      expect(r.childProcessSpawns.node).toBe(expected); // each shim spawned its writer
      expect(r.hookLatencyMs.n).toBe(expected);
      expect(r.hookLatencyMs.p50).toBeGreaterThan(0);
      expect(r.hookLatencyMs.p95).toBeGreaterThanOrEqual(r.hookLatencyMs.p50);
      expect(r.peakProcessRssMb).toBeGreaterThan(0);
      expect(r.bytesWritten).toBeGreaterThan(0);
      expect(r.capturedPercent).toBe(FULL_CAPTURE_PERCENT);
      expect(r.scrubbing.canaryLeaks).toBe(0);
      expect(r.scrubbing.redactionMarkers).toBeGreaterThan(0);
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'N=2 runs the sessions concurrently',
    () => {
      const sessions = 2;
      const { status, stdout, result } = runBench(sessions);
      removeKeptSandbox(stdout);
      // Two sessions may already lose capture data (DEGRADED); the harness
      // itself must still have done all the work.
      expect(status, stdout).not.toBe(EXIT_INVALID);
      expect(result!.invocations).toBe(sessions * EVENTS_PER_TURN * SMALL_RUN.turns);
      expect(result!.peakConcurrentNodeProcesses).toBeGreaterThanOrEqual(sessions);
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'a shim that spawns nothing makes the run INVALID, never PASS',
    () => {
      const noopShim = join(workDir, 'noop-shim.cjs');
      writeFileSync(
        noopShim,
        'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
      );
      const { status, stdout, result } = runBench(1, { AUTO_SOP_BENCH_SHIM: noopShim });
      removeKeptSandbox(stdout);

      expect(status, stdout).toBe(EXIT_INVALID);
      expect(result!.verdict).toBe('INVALID');
      expect(result!.nodeProcessesByRole.writer).toBe(0);
      expect(result!.invalid.join('\n')).toMatch(/writer processes start/);
      expect(stdout).not.toMatch(/RESULT: PASS/);
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'lightweight N=1 spawns writers only for turn-level events, and the count is exact',
    () => {
      const { status, stdout, result } = runBench(1, {}, ['--mode', 'lightweight']);
      expect(status, stdout).toBe(EXIT_PASS);
      const r = result!;
      const invocations = EVENTS_PER_TURN * SMALL_RUN.turns;
      const writers = LIGHTWEIGHT_WRITERS_PER_TURN * SMALL_RUN.turns;

      expect(r.mode).toBe('lightweight');
      expect(r.verdict).toBe('PASS');
      expect(r.invocations).toBe(invocations);
      expect(r.nodeProcessesByRole.shim).toBe(invocations);
      expect(r.expectedWriterStarts).toBe(writers);
      expect(r.nodeProcessesByRole.writer).toBe(writers);
      expect(r.childProcessSpawns.node).toBe(writers);
      expect(r.completeness.toolCallLines).toBe('0/0');
      expect(r.capturedPercent).toBe(FULL_CAPTURE_PERCENT);
      expect(r.scrubbing.canaryLeaks).toBe(0);
      expect(r.scrubbing.redactionMarkers).toBeGreaterThan(0);
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'a lightweight run whose shim spawns nothing is INVALID, never PASS',
    () => {
      const noopShim = join(workDir, 'noop-shim-lightweight.cjs');
      writeFileSync(
        noopShim,
        'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
      );
      const { status, stdout, result } = runBench(1, { AUTO_SOP_BENCH_SHIM: noopShim }, [
        '--mode',
        'lightweight',
      ]);
      removeKeptSandbox(stdout);

      expect(status, stdout).toBe(EXIT_INVALID);
      expect(result!.nodeProcessesByRole.writer).toBe(0);
      expect(result!.invalid.join('\n')).toMatch(/writer processes start \(lightweight mode\)/);
      expect(stdout).not.toMatch(/RESULT: PASS/);
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'a lightweight run whose shim still spawns a writer for every event is INVALID',
    () => {
      // Hands every payload off, as the shim did before it learned to drop
      // lightweight tool events itself.
      const alwaysShim = join(workDir, 'always-handoff-shim.cjs');
      writeFileSync(
        alwaysShim,
        `const fs = require('node:fs'); const path = require('node:path');
const cp = require('node:child_process'); const os = require('node:os');
const chunks = []; process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const dir = path.join(os.homedir(), '.auto-sop', 'tmp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, process.pid + '-' + Date.now() + '.json');
  fs.writeFileSync(p, Buffer.concat(chunks), { mode: 0o600 });
  cp.spawn(process.execPath, [process.env.AUTO_SOP_BENCH_WRITER, p], { detached: true, stdio: 'ignore' }).unref();
  process.exit(0);
});`,
      );
      const { status, stdout, result } = runBench(1, { AUTO_SOP_BENCH_SHIM: alwaysShim }, [
        '--mode',
        'lightweight',
      ]);
      removeKeptSandbox(stdout);

      expect(status, stdout).toBe(EXIT_INVALID);
      expect(result!.nodeProcessesByRole.writer).toBe(EVENTS_PER_TURN * SMALL_RUN.turns);
      expect(result!.invalid.join('\n')).toMatch(/writer processes start \(lightweight mode\)/);
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'a writer that consumes payloads but records nothing makes the run INVALID',
    () => {
      const emptyWriter = join(workDir, 'empty-writer.cjs');
      writeFileSync(
        emptyWriter,
        'try { require("node:fs").unlinkSync(process.argv[2]); } catch {} process.exit(0);',
      );
      const { status, stdout, result } = runBench(1, { AUTO_SOP_BENCH_WRITER: emptyWriter });
      removeKeptSandbox(stdout);

      expect(status, stdout).toBe(EXIT_INVALID);
      expect(result!.verdict).toBe('INVALID');
      expect(result!.invalid.join('\n')).toMatch(/no capture bytes reached disk/);
    },
    HARNESS_TIMEOUT_MS,
  );
});

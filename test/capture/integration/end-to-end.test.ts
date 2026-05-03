/**
 * End-to-end integration tests for Phase 1: Capture Foundation.
 *
 * Replays fixture JSONL sessions through the BUILT shim+writer binary.
 * Each describe block maps to specific ROADMAP success criteria (CAPT-XX / PRIV-XX).
 *
 * Traceability table (printed at end):
 *   CAPT-01 → main-only: turn dir schema + 5 required files
 *   CAPT-02 → secret-scrub: mode 0600/0700 + scrub audit
 *   CAPT-03 → (bench job, not tested here)
 *   CAPT-04 → main-with-subagent: bidirectional linking
 *   CAPT-05 → global mirror: index.jsonl entries
 *   CAPT-06 → (bench job latency, not tested here)
 *   CAPT-07 → concurrent-sessions: session isolation
 *   CAPT-08 → orphan-recovery: timeout finalization
 *   CAPT-09 → main-with-subagent: dual representation
 *   CAPT-10 → large-output: gzip offload
 *   PRIV-04 → secret-scrub: zero secret matches across all files
 *   PRIV-07 → kill-switch: zero-write behavior
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

import { runScenario, walkDir, walkDirs, type ScenarioRun } from './run-scenario.js';
import { isWindows } from '../../setup/platform.js';

// ── Fixture paths ──────────────────────────────────────────────────────
const FIXTURES_DIR = resolve(__dirname, 'fixtures/sessions');
const fixture = (name: string) => join(FIXTURES_DIR, name);

// ── Secret patterns from the baseline scrubber rules ──────────────────
// These patterns are used in the scrub audit to verify no secrets leak.
const SECRET_PATTERNS: RegExp[] = [/sk-ant-[A-Za-z0-9_-]{20,}/g, /AKIA[0-9A-Z]{16}/g];

// ── Shared temp root ──────────────────────────────────────────────────
let sharedTmpRoot: string;

beforeAll(() => {
  // Build the project fresh
  execSync('npm run build', {
    cwd: resolve(__dirname, '../../..'),
    stdio: 'pipe',
    timeout: 180_000,
  });
  sharedTmpRoot = mkdtempSync(join(tmpdir(), 'e2e-capture-'));
});

// ── Helpers ───────────────────────────────────────────────────────────

/** List finalized (non-.pending) turn dirs in captures/ */
function listFinalizedTurnDirs(captureDir: string): string[] {
  if (!existsSync(captureDir)) return [];
  return readdirSync(captureDir).filter(
    (name) =>
      !name.endsWith('.pending') &&
      name !== 'pending-capture' &&
      statSync(join(captureDir, name)).isDirectory(),
  );
}

/** Poll until the expected number of finalized turn dirs appear, or timeout. */
async function waitForDirs(
  captureDir: string,
  expected: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dirs = listFinalizedTurnDirs(captureDir);
    if (dirs.length >= expected) return dirs;
    await new Promise((r) => setTimeout(r, 200));
  }
  const final = listFinalizedTurnDirs(captureDir);
  throw new Error(
    `waitForDirs timed out after ${timeoutMs}ms. Expected ${expected} dirs, got ${final.length}.`,
  );
}

/** Read and parse meta.json from a turn dir */
function readMeta(turnDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(turnDir, 'meta.json'), 'utf8'));
}

/** Read tool-calls.jsonl lines from a turn dir */
function readToolCallLines(turnDir: string): Record<string, unknown>[] {
  const path = join(turnDir, 'tool-calls.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Decompress a .gz file and return its contents as string */
async function readGzFile(path: string): Promise<string> {
  const chunks: Buffer[] = [];
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    }),
  );
  return Buffer.concat(chunks).toString('utf8');
}

/** Read ALL text content from a turn dir (recursing into large-outputs, decompressing .gz) */
async function readAllTurnContent(turnDir: string): Promise<string> {
  const files = walkDir(turnDir);
  const parts: string[] = [];
  for (const f of files) {
    if (f.endsWith('.gz')) {
      parts.push(await readGzFile(f));
    } else {
      try {
        parts.push(readFileSync(f, 'utf8'));
      } catch {
        // binary file — skip
      }
    }
  }
  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 1: main-only (CAPT-01, CAPT-05)
// ═══════════════════════════════════════════════════════════════════════
describe('main-only', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'main-only-'));
    run = await runScenario({
      fixturePath: fixture('main-only.jsonl'),
      tmpRoot,
      // W2 mid-stream assertion: between PostToolUse (line 2) and Stop (line 3),
      // verify no finalized dirs exist yet — only .pending should be visible.
      midCheckpoints: [
        {
          afterLine: 2, // after PostToolUse, before Stop
          assert: (r) => {
            if (!existsSync(r.captureDir)) return; // captures dir might not exist yet
            const entries = readdirSync(r.captureDir);
            const finalized = entries.filter((n) => !n.endsWith('.pending') && n !== 'pending-capture');
            expect(
              finalized.length,
              'W2: No finalized dirs should exist while turn is in-flight',
            ).toBe(0);
          },
        },
      ],
    });
  }, 180_000);

  it('produces exactly one finalized turn dir', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    expect(dirs.length).toBe(1);
    expect(dirs[0]).toMatch(/main/);
  });

  it('turn dir contains 5 required files', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const turnDir = join(run.captureDir, dirs[0]);
    const required = [
      'prompt.md',
      'response.md',
      'tool-calls.jsonl',
      'files-changed.txt',
      'meta.json',
    ];
    for (const f of required) {
      expect(existsSync(join(turnDir, f)), `Missing: ${f}`).toBe(true);
    }
  });

  it('meta.json has correct schema (CAPT-01)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const meta = readMeta(join(run.captureDir, dirs[0]));
    expect(meta.schema_version).toBe(1);
    expect(meta.finalization_reason).toBe('stop');
    expect(meta.turn_id).toBeTruthy();
    expect(typeof meta.turn_id).toBe('string');
    expect(meta.session_id).toBe('s-main-1');
    expect(meta.tool_call_count).toBe(1);
    expect(meta.agent).toBe('main');
  });

  it('tool-calls.jsonl has pre+post pair with matching tool_use_id', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const lines = readToolCallLines(join(run.captureDir, dirs[0]));
    expect(lines.length).toBe(2);
    const pre = lines.find((l) => l.event === 'pre');
    const post = lines.find((l) => l.event === 'post');
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    expect(pre!.tool_use_id).toBe('tu-1');
    expect(post!.tool_use_id).toBe('tu-1');
  });

  it('W2: after Stop, exactly one finalized (non-.pending) dir exists', () => {
    const entries = readdirSync(run.captureDir);
    const pending = entries.filter((n) => n.endsWith('.pending'));
    const finalized = entries.filter(
      (n) =>
        !n.endsWith('.pending') &&
        n !== 'pending-capture' &&
        statSync(join(run.captureDir, n)).isDirectory(),
    );
    expect(pending.length).toBe(0);
    expect(finalized.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 2: main-with-subagent (CAPT-04, CAPT-09)
// ═══════════════════════════════════════════════════════════════════════
describe('main-with-subagent', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'subagent-'));
    run = await runScenario({
      fixturePath: fixture('main-with-subagent.jsonl'),
      tmpRoot,
    });
    // Wait for both turn dirs to finalize before tests run
    await waitForDirs(run.captureDir, 2);
  }, 180_000);

  it('produces two finalized turn dirs (main + subagent)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    expect(dirs.length).toBe(2);
  });

  it('bidirectional linking: parent→child and child→parent (CAPT-04)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const metas = dirs.map((d) => readMeta(join(run.captureDir, d)));

    const mainMeta = metas.find((m) => m.agent === 'main');
    const childMeta = metas.find((m) => m.agent !== 'main');

    expect(mainMeta).toBeDefined();
    expect(childMeta).toBeDefined();

    // Parent knows about child
    expect(mainMeta!.children_turn_ids).toContain(childMeta!.turn_id);
    // Child knows about parent
    expect(childMeta!.parent_turn_id).toBe(mainMeta!.turn_id);
    expect(childMeta!.subagent_type).toBe('code-reviewer');
  });

  it('dual representation: main has Task tool-call, subagent has own tool-calls (CAPT-09)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const metas = dirs.map((d) => ({ dir: d, meta: readMeta(join(run.captureDir, d)) }));

    const mainEntry = metas.find((m) => m.meta.agent === 'main')!;
    const childEntry = metas.find((m) => m.meta.agent !== 'main')!;

    const mainTools = readToolCallLines(join(run.captureDir, mainEntry.dir));
    const childTools = readToolCallLines(join(run.captureDir, childEntry.dir));

    // Main has Task pre+post
    const taskPre = mainTools.find((l) => l.event === 'pre' && l.tool === 'Task');
    const taskPost = mainTools.find((l) => l.event === 'post' && l.tool_use_id === 'tu-task');
    expect(taskPre).toBeDefined();
    expect(taskPost).toBeDefined();

    // Subagent has its own Read pre+post
    const subPre = childTools.find((l) => l.event === 'pre' && l.tool === 'Read');
    const subPost = childTools.find((l) => l.event === 'post' && l.tool_use_id === 'tu-sub-1');
    expect(subPre).toBeDefined();
    expect(subPost).toBeDefined();

    // No cross-contamination: main tools don't have subagent's tu-sub-1
    const crossContamination = mainTools.find((l) => l.tool_use_id === 'tu-sub-1');
    expect(crossContamination).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 3: large-output (CAPT-10 / A4)
// ═══════════════════════════════════════════════════════════════════════
describe.sequential('large-output', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'large-'));
    run = await runScenario({
      fixturePath: fixture('large-output.jsonl'),
      tmpRoot,
    });
  }, 180_000);

  it('offloads large output to gzipped file in large-outputs/ (CAPT-10)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    expect(dirs.length).toBe(1);

    const turnDir = join(run.captureDir, dirs[0]);
    const largeDir = join(turnDir, 'large-outputs');
    expect(existsSync(largeDir)).toBe(true);

    const gzFiles = readdirSync(largeDir).filter((f) => f.endsWith('.gz'));
    expect(gzFiles.length).toBeGreaterThanOrEqual(1);

    // The gz file should be non-empty
    const gzPath = join(largeDir, gzFiles[0]);
    const stat = statSync(gzPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('tool-calls.jsonl carries output_ref and bytes for offloaded output', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const lines = readToolCallLines(join(run.captureDir, dirs[0]));
    const postLine = lines.find((l) => l.event === 'post');
    expect(postLine).toBeDefined();
    expect(postLine!.output_ref).toMatch(/large-outputs\//);
    expect(typeof postLine!.bytes).toBe('number');
    expect(postLine!.bytes as number).toBeGreaterThanOrEqual(250000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 4: orphan-recovery (CAPT-08 / B1/B2)
// ═══════════════════════════════════════════════════════════════════════
describe.sequential('orphan-recovery', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'orphan-'));
    run = await runScenario({
      fixturePath: fixture('orphan-recovery.jsonl'),
      tmpRoot,
      midActions: [{ kind: 'age-pending-dirs', minusSeconds: 45 }],
    });
  }, 180_000);

  it('orphan turn is finalized with timeout reason (CAPT-08)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    // Should have at least 2 turns: the orphan (timed out) + the recovery session
    expect(dirs.length).toBeGreaterThanOrEqual(2);

    const metas = dirs.map((d) => readMeta(join(run.captureDir, d)));
    const timeoutMeta = metas.find((m) => m.finalization_reason === 'timeout');
    const stopMeta = metas.find((m) => m.finalization_reason === 'stop');

    expect(timeoutMeta).toBeDefined();
    expect(stopMeta).toBeDefined();
  });

  it('no .pending dirs remain after sweep', () => {
    const entries = readdirSync(run.captureDir);
    const pending = entries.filter((n) => n.endsWith('.pending'));
    expect(pending.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 5: paused-skip (F3)
// ═══════════════════════════════════════════════════════════════════════
describe('paused-skip', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'paused-'));
    run = await runScenario({
      fixturePath: fixture('paused-skip.jsonl'),
      tmpRoot,
      preActions: [{ kind: 'create-paused-flag' }],
    });
  }, 180_000);

  it('no turn dirs created when paused (F3)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    expect(dirs.length).toBe(0);
  });

  it('errors.jsonl has paused_skipped entry', () => {
    const errorsPath = join(run.projectRoot, '.auto-sop', 'errors.jsonl');
    expect(existsSync(errorsPath)).toBe(true);
    const lines = readFileSync(errorsPath, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const pausedEntry = lines.find((l: Record<string, unknown>) => l.kind === 'paused_skipped');
    expect(pausedEntry).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 6: secret-scrub (PRIV-01, PRIV-04, CAPT-02)
// ═══════════════════════════════════════════════════════════════════════
describe('secret-scrub', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'scrub-'));
    run = await runScenario({
      fixturePath: fixture('secret-scrub.jsonl'),
      tmpRoot,
    });
  }, 180_000);

  it('no raw secrets appear in any captured file (PRIV-04)', async () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    expect(dirs.length).toBe(1);

    const allContent = await readAllTurnContent(join(run.captureDir, dirs[0]));

    for (const pattern of SECRET_PATTERNS) {
      const matches = allContent.match(pattern);
      expect(matches, `Secret pattern ${pattern} found in captured content`).toBeNull();
    }
  });

  it('file permissions: 0600 for files, 0700 for dirs (CAPT-02)', () => {
    if (isWindows) return;
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const turnDir = join(run.captureDir, dirs[0]);

    // Check files
    const files = walkDir(turnDir);
    for (const f of files) {
      const mode = statSync(f).mode & 0o777;
      expect(mode, `File ${f} should be 0600, got ${mode.toString(8)}`).toBe(0o600);
    }

    // Check directories
    const directories = walkDirs(turnDir);
    for (const d of directories) {
      const mode = statSync(d).mode & 0o777;
      expect(mode, `Dir ${d} should be 0700, got ${mode.toString(8)}`).toBe(0o700);
    }
  });

  it('meta.scrubber_hit_count >= 3 (planted secrets)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const meta = readMeta(join(run.captureDir, dirs[0]));
    expect(meta.scrubber_hit_count as number).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SCENARIO 7: concurrent-sessions (CAPT-07 / Pitfall 5)
// ═══════════════════════════════════════════════════════════════════════
describe('concurrent-sessions', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'conc-'));
    run = await runScenario({
      fixturePath: fixture('concurrent-sessions.jsonl'),
      tmpRoot,
    });
  }, 180_000);

  it('produces two separate turn dirs, one per session', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    expect(dirs.length).toBe(2);

    const metas = dirs.map((d) => readMeta(join(run.captureDir, d)));
    const sessionIds = new Set(metas.map((m) => m.session_id));
    expect(sessionIds.size).toBe(2);
    expect(sessionIds.has('s-conc-a')).toBe(true);
    expect(sessionIds.has('s-conc-b')).toBe(true);
  });

  it('no cross-contamination: each session has only its own tool calls', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const entries = dirs.map((d) => ({
      dir: d,
      meta: readMeta(join(run.captureDir, d)),
      tools: readToolCallLines(join(run.captureDir, d)),
    }));

    const sessionA = entries.find((e) => e.meta.session_id === 's-conc-a')!;
    const sessionB = entries.find((e) => e.meta.session_id === 's-conc-b')!;

    // Session A should have tu-a1 and tu-a2 (pre+post each = 4 lines)
    expect(sessionA.tools.length).toBe(4);
    const aIds = sessionA.tools.map((t) => t.tool_use_id);
    expect(aIds).toContain('tu-a1');
    expect(aIds).toContain('tu-a2');
    expect(aIds).not.toContain('tu-b1');
    expect(aIds).not.toContain('tu-b2');

    // Session B should have tu-b1 and tu-b2 (pre+post each = 4 lines)
    expect(sessionB.tools.length).toBe(4);
    const bIds = sessionB.tools.map((t) => t.tool_use_id);
    expect(bIds).toContain('tu-b1');
    expect(bIds).toContain('tu-b2');
    expect(bIds).not.toContain('tu-a1');
    expect(bIds).not.toContain('tu-a2');
  });

  it('both turn dirs fully finalized (no .pending)', () => {
    const entries = readdirSync(run.captureDir);
    const pending = entries.filter((n) => n.endsWith('.pending'));
    expect(pending.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL MIRROR COVERAGE (CAPT-05)
// ═══════════════════════════════════════════════════════════════════════
describe('global mirror coverage', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'global-'));
    run = await runScenario({
      fixturePath: fixture('main-only.jsonl'),
      tmpRoot,
    });
  }, 180_000);

  it('global index.jsonl exists with correct entry (CAPT-05)', () => {
    // Find the index.jsonl under the global dir
    const globalFiles = walkDir(run.globalDir);
    const indexFiles = globalFiles.filter((f) => f.endsWith('index.jsonl'));
    expect(indexFiles.length).toBeGreaterThanOrEqual(1);

    const indexContent = readFileSync(indexFiles[0], 'utf8').trim();
    const lines = indexContent
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = lines[0];
    expect(entry.turn_id).toBeTruthy();
    expect(entry.project_path).toBe(run.projectRoot);
    expect(entry.agent).toBe('main');

    // Cross-check: turn_id matches the local meta
    const dirs = listFinalizedTurnDirs(run.captureDir);
    const meta = readMeta(join(run.captureDir, dirs[0]));
    expect(entry.turn_id).toBe(meta.turn_id);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// KILL-SWITCH (PRIV-07)
// ═══════════════════════════════════════════════════════════════════════
describe('CLAUDE_SOP_LEARNER kill-switch', () => {
  let run: ScenarioRun;

  beforeAll(async () => {
    const tmpRoot = mkdtempSync(join(sharedTmpRoot, 'killswitch-'));
    run = await runScenario({
      fixturePath: fixture('main-only.jsonl'),
      tmpRoot,
      env: { CLAUDE_SOP_LEARNER: '1' },
    });
  }, 180_000);

  it('no captures directory content when kill-switch active (PRIV-07)', () => {
    const dirs = listFinalizedTurnDirs(run.captureDir);
    expect(dirs.length).toBe(0);
  });

  it('no global index entries', () => {
    const globalFiles = walkDir(run.globalDir);
    const indexFiles = globalFiles.filter((f) => f.endsWith('index.jsonl'));
    // Either no index file exists, or it's empty
    if (indexFiles.length > 0) {
      const content = readFileSync(indexFiles[0], 'utf8').trim();
      expect(content.length).toBe(0);
    }
  });

  it('no tmp payload files remain', () => {
    if (existsSync(run.tmpDir)) {
      const files = readdirSync(run.tmpDir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TRACEABILITY TABLE (logged after all tests)
// ═══════════════════════════════════════════════════════════════════════
afterAll(() => {
  const table = `
╔═══════════╤══════════════════════════════════════════════════════════════╗
║ Criterion │ Test                                                       ║
╠═══════════╪══════════════════════════════════════════════════════════════╣
║ CAPT-01   │ main-only: meta.json schema, 5 required files              ║
║ CAPT-02   │ secret-scrub: file 0600 / dir 0700 permissions             ║
║ CAPT-03   │ (bench job — not integration tested)                       ║
║ CAPT-04   │ main-with-subagent: bidirectional linking                  ║
║ CAPT-05   │ global mirror: index.jsonl entries                         ║
║ CAPT-06   │ (bench job latency — not integration tested)               ║
║ CAPT-07   │ concurrent-sessions: session isolation                     ║
║ CAPT-08   │ orphan-recovery: timeout finalization                      ║
║ CAPT-09   │ main-with-subagent: dual representation (Task + subagent)  ║
║ CAPT-10   │ large-output: gzip offload + output_ref                   ║
║ PRIV-04   │ secret-scrub: zero secret matches across all files         ║
║ PRIV-07   │ kill-switch: zero-write behavior                           ║
╚═══════════╧══════════════════════════════════════════════════════════════╝
`;
  console.log(table);
});

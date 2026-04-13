/**
 * Integration test helper: replay JSONL fixture through dist/capture/shim.cjs + writer.
 *
 * Each fixture line is piped as stdin to the shim binary. The detached writer runs
 * asynchronously; waitForQuiescence polls until all .pending dirs are finalized.
 *
 * Uses real filesystem (NOT memfs) against the actually-built binary.
 */
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SHIM_PATH = resolve(__dirname, '../../../dist/capture/shim.cjs');
const WRITER_PATH = resolve(__dirname, '../../../dist/capture/writer.cjs');

export interface ScenarioRun {
  projectRoot: string;
  captureDir: string;
  globalDir: string;
  fakeHome: string;
  tmpDir: string;
}

export interface RunScenarioOpts {
  fixturePath: string;
  tmpRoot: string;
  env?: Record<string, string>;
  preActions?: Array<
    | { kind: 'create-paused-flag' }
    | { kind: 'age-pending-dirs'; minusSeconds: number }
  >;
  midActions?: Array<{ kind: 'age-pending-dirs'; minusSeconds: number }>;
  /**
   * W2: optional inline checkpoints invoked after line N has been processed (0-indexed).
   * Used by the main-only test to assert .pending visibility rules mid-turn.
   */
  midCheckpoints?: Array<{ afterLine: number; assert: (run: ScenarioRun) => void }>;
}

/**
 * Create the minimal transcript file expected by extractLastAssistantMessage().
 */
function createStubTranscript(dir: string): string {
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Assistant response text.' }] },
    }) + '\n',
    { mode: 0o600 },
  );
  return transcriptPath;
}

/**
 * Initialize a git repo in the project root so `git diff --name-only HEAD` works.
 */
function initGitRepo(projectRoot: string): void {
  try {
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    writeFileSync(join(projectRoot, '.gitkeep'), '', { mode: 0o600 });
    execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  } catch {
    // Git not available — files-changed.txt will be empty, which is fine.
  }
}

/**
 * Replay a JSONL fixture through dist/capture/shim.cjs against a fresh project dir.
 * Handles placeholder substitution, split markers, and mtime aging for orphan tests.
 */
export async function runScenario(opts: RunScenarioOpts): Promise<ScenarioRun> {
  const { fixturePath, tmpRoot } = opts;

  // Create isolated directories
  const projectRoot = mkdtempSync(join(tmpRoot, 'proj-'));
  const fakeHome = mkdtempSync(join(tmpRoot, 'home-'));
  mkdirSync(join(projectRoot, '.claude-sop'), { recursive: true, mode: 0o700 });

  const transcriptPath = createStubTranscript(projectRoot);
  initGitRepo(projectRoot);

  // Read and parse fixture lines
  const raw = readFileSync(fixturePath, 'utf8').trim();
  const allLines = raw.split('\n');

  // Substitute placeholders
  const substituted = allLines.map((line) =>
    line
      .replace(/<PROJECT_ROOT>/g, projectRoot)
      .replace(/<FIXTURE_TRANSCRIPT>/g, transcriptPath),
  );

  // Build the ScenarioRun result early (for preActions and midCheckpoints)
  const claudeSopDir = join(projectRoot, '.claude-sop');
  const captureDir = join(claudeSopDir, 'captures');
  const globalSopHome = join(fakeHome, '.claude', 'sop');
  const claudeSopTmpDir = join(fakeHome, '.claude-sop', 'tmp');

  const run: ScenarioRun = {
    projectRoot,
    captureDir,
    globalDir: globalSopHome,
    fakeHome,
    tmpDir: claudeSopTmpDir,
  };

  // Execute preActions
  if (opts.preActions) {
    for (const action of opts.preActions) {
      if (action.kind === 'create-paused-flag') {
        mkdirSync(claudeSopDir, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(claudeSopDir, 'paused.flag'),
          JSON.stringify({ at: new Date().toISOString(), used: 999999999, cap: 2147483648, threshold: 1073741824 }),
          { mode: 0o600 },
        );
      }
    }
  }

  // Build the base env for spawned processes
  const baseEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: fakeHome,
    ...(opts.env ?? {}),
  };

  // Build sorted checkpoint map
  const checkpointMap = new Map<number, ((run: ScenarioRun) => void)[]>();
  if (opts.midCheckpoints) {
    for (const cp of opts.midCheckpoints) {
      const arr = checkpointMap.get(cp.afterLine) ?? [];
      arr.push(cp.assert);
      checkpointMap.set(cp.afterLine, arr);
    }
  }

  // Process each line
  let lineIdx = 0;
  for (const line of substituted) {
    // Check for scenario break marker
    try {
      const parsed = JSON.parse(line);
      if (parsed._scenario_marker === 'BREAK_HERE') {
        // Wait for writers to finish processing (tmp payloads consumed).
        // NOTE: We do NOT wait for .pending dirs to finalize here — orphan
        // .pending dirs are expected and will be swept by the next session.
        await waitForWritersIdle(claudeSopTmpDir, 5000);

        // Apply mid-actions
        if (opts.midActions) {
          for (const action of opts.midActions) {
            if (action.kind === 'age-pending-dirs') {
              agePendingDirs(captureDir, action.minusSeconds);
            }
          }
        }
        lineIdx++;
        continue;
      }
    } catch {
      // Not JSON — skip
      lineIdx++;
      continue;
    }

    // Pipe the JSON line to the shim
    try {
      execFileSync(process.execPath, [SHIM_PATH], {
        input: line,
        env: baseEnv,
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Shim should always exit 0, but don't crash the test harness
      const exitCode = (err as { status?: number }).status ?? -1;
      throw new Error(
        `Shim exited with code ${exitCode} on line ${lineIdx}: ${line.slice(0, 200)}`,
      );
    }

    // Run mid-checkpoints for this line
    const fns = checkpointMap.get(lineIdx);
    if (fns) {
      // Short wait for the writer to start processing (it's detached async)
      await sleep(100);
      for (const fn of fns) {
        fn(run);
      }
    }

    lineIdx++;
  }

  // Wait for all detached writers to finish
  await waitForQuiescence(captureDir, claudeSopTmpDir, 10000);

  return run;
}

/**
 * Block until all detached writers have finalized (poll for no .pending dirs + no tmp payloads).
 */
export async function waitForQuiescence(
  captureDir: string,
  tmpDir: string,
  timeoutMs: number = 5000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const hasPending = hasPendingDirs(captureDir);
    const hasTmp = hasTmpPayloads(tmpDir);

    if (!hasPending && !hasTmp) {
      return; // Quiescent!
    }

    await sleep(50);
  }

  // Timeout — build diagnostic message
  const pendingList = listPendingDirs(captureDir);
  const tmpList = listTmpFiles(tmpDir);
  throw new Error(
    `waitForQuiescence timed out after ${timeoutMs}ms.\n` +
    `  Pending dirs: ${pendingList.join(', ') || '(none)'}\n` +
    `  Tmp files: ${tmpList.join(', ') || '(none)'}`,
  );
}

/**
 * Wait until all tmp payload files are consumed (writers done), ignoring .pending dirs.
 * Used during BREAK_HERE markers where orphan .pending dirs are expected.
 */
async function waitForWritersIdle(
  tmpDir: string,
  timeoutMs: number = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!hasTmpPayloads(tmpDir)) return;
    await sleep(50);
  }
  const tmpList = listTmpFiles(tmpDir);
  throw new Error(
    `waitForWritersIdle timed out after ${timeoutMs}ms.\n` +
    `  Tmp files: ${tmpList.join(', ') || '(none)'}`,
  );
}

// ── Internal helpers ────────────────────────────────────���─────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasPendingDirs(captureDir: string): boolean {
  if (!existsSync(captureDir)) return false;
  try {
    const entries = readdirSync(captureDir);
    return entries.some((name) => name.endsWith('.pending'));
  } catch {
    return false;
  }
}

function listPendingDirs(captureDir: string): string[] {
  if (!existsSync(captureDir)) return [];
  try {
    return readdirSync(captureDir).filter((name) => name.endsWith('.pending'));
  } catch {
    return [];
  }
}

function hasTmpPayloads(tmpDir: string): boolean {
  if (!existsSync(tmpDir)) return false;
  try {
    const entries = readdirSync(tmpDir);
    return entries.some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

function listTmpFiles(tmpDir: string): string[] {
  if (!existsSync(tmpDir)) return [];
  try {
    return readdirSync(tmpDir);
  } catch {
    return [];
  }
}

/**
 * Age all files inside .pending dirs by setting mtime to (now - seconds).
 */
function agePendingDirs(captureDir: string, minusSeconds: number): void {
  if (!existsSync(captureDir)) return;

  const entries = readdirSync(captureDir);
  const pendingDirs = entries.filter((name) => name.endsWith('.pending'));

  const targetTime = new Date(Date.now() - minusSeconds * 1000);

  for (const pendingName of pendingDirs) {
    const pendingPath = join(captureDir, pendingName);
    try {
      // Age the dir itself
      utimesSync(pendingPath, targetTime, targetTime);

      // Age all files inside
      const children = readdirSync(pendingPath);
      for (const child of children) {
        const childPath = join(pendingPath, child);
        try {
          utimesSync(childPath, targetTime, targetTime);
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
}

/**
 * Walk a directory tree recursively and return all file paths.
 */
export function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          stack.push(p);
        } else {
          results.push(p);
        }
      } catch {
        // skip
      }
    }
  }
  return results;
}

/**
 * Walk a directory tree and return all directory paths (including root).
 */
export function walkDirs(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    results.push(d);
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          stack.push(p);
        }
      } catch {
        // skip
      }
    }
  }
  return results;
}

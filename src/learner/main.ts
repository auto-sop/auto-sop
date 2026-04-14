/**
 * Learner main — real Phase 3 entry point.
 * Reads project registry, scans captures, produces recap log entries.
 *
 * FAIL-OPEN POLICY: Every error at every layer is caught, logged to
 * ~/.claude-sop/logs/errors.log as one-line JSON, then process exits 0.
 * No non-zero exit path anywhere.
 */
import { existsSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { lockSync, unlockSync, checkSync } from 'proper-lockfile';
import { readRegistry, validateProjectRoot } from './project-registry.js';
import { readCursor, writeCursor, withCursorLock } from './cursor.js';
import { scanNewTurns, type TurnSummary } from './turn-scanner.js';
import { appendRecap, type PerProjectRecap, type TickSummary } from './recap-log.js';

// ── Constants ──────────────────────────────────────────────

const HARD_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TURNS_FIRST_RUN = 500;

// ── Error logger (inline, fail-safe) ───────────────────────

function logError(kind: string, err: unknown, home?: string): void {
  try {
    const logDir = join(home ?? homedir(), '.claude-sop', 'logs');
    mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({
      t: new Date().toISOString(),
      kind,
      err: err instanceof Error ? err.message : String(err),
    }) + '\n';
    appendFileSync(join(logDir, 'errors.log'), line, { mode: 0o600 });
  } catch {
    // Error logging must never itself throw
  }
}

// ── Tick ID ────────────────────────────────────────────────

function makeTickId(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `ck-${hh}h${mm}`;
}

// ── Pause check ────────────────────────────────────────────

function isPaused(home: string): boolean {
  try {
    // Check global pause flag
    return existsSync(join(home, '.claude-sop', 'paused.flag'));
  } catch {
    return false;
  }
}

// ── Learner lock ───────────────────────────────────────────

function acquireLearnerLock(home: string): (() => void) | null {
  const lockDir = join(home, '.claude-sop');
  const lockFile = join(lockDir, 'learner.lock');
  mkdirSync(lockDir, { recursive: true });

  // Create lockfile target if missing
  if (!existsSync(lockFile)) {
    writeFileSync(lockFile, '', { mode: 0o600 });
  }

  try {
    // Check if already locked
    if (checkSync(lockFile, { lockfilePath: lockFile + '.proper' })) {
      // Already locked (another learner is running)
      return null;
    }
  } catch {
    // checkSync can fail if no lock exists — that's fine
  }

  try {
    lockSync(lockFile, {
      lockfilePath: lockFile + '.proper',
      stale: HARD_TIMEOUT_MS + 10_000, // stale after 130s
      retries: 0,
    });
    return () => {
      try {
        unlockSync(lockFile, { lockfilePath: lockFile + '.proper' });
      } catch {
        // best-effort
      }
    };
  } catch {
    return null; // can't acquire — another tick running
  }
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const home = homedir();
  const tickId = makeTickId();
  const tickStart = Date.now();

  // Hard timeout via AbortController (SEC-002: hard-kill fallback for sync ops)
  const ac = new AbortController();
  const timeout = setTimeout(() => {
    ac.abort();
    // If abort doesn't stop sync operations within 5s, force-exit
    const killTimer = setTimeout(() => process.exit(0), 5000);
    killTimer.unref();
  }, HARD_TIMEOUT_MS);
  timeout.unref();

  try {
    // Pause check
    if (isPaused(home)) {
      process.exit(0);
    }

    // Learner lock (skip if another tick running)
    const releaseLock = acquireLearnerLock(home);
    if (!releaseLock) {
      logError('learner_lock_held', 'skipping tick — another learner is running', home);
      process.exit(0);
    }

    try {
      await runLearnerTick(home, tickId, tickStart, ac.signal);
    } finally {
      releaseLock();
    }
  } catch (err) {
    logError('learner_main_uncaught', err, home);
  } finally {
    clearTimeout(timeout);
  }

  process.exit(0);
}

async function runLearnerTick(
  home: string,
  tickId: string,
  tickStart: number,
  signal: AbortSignal,
): Promise<void> {
  const registry = readRegistry(home);
  const now = new Date().toISOString();

  let projects_processed = 0;
  let projects_skipped = 0;
  let projects_locked = 0;
  let projects_missing = 0;
  let total_turns_new = 0;
  const errors: string[] = [];

  for (const project of registry.projects) {
    if (signal.aborted) {
      logError('learner_timeout', 'hard timeout reached during tick', home);
      break;
    }

    const projectStart = Date.now();

    try {
      // Validate project root (SEC-001: prevent path traversal)
      let validRoot: string;
      try {
        validRoot = validateProjectRoot(project.project_root);
      } catch (validationErr) {
        logError('learner_invalid_root', validationErr, home);
        projects_skipped++;
        continue;
      }

      // Check project root exists
      if (!existsSync(validRoot)) {
        projects_missing++;
        continue;
      }

      const stateDir = join(validRoot, '.claude-sop', 'state');
      const capturesDir = join(validRoot, '.claude-sop', 'captures');

      // Acquire cursor lock
      const result = withCursorLock(stateDir, () => {
        const cursor = readCursor(stateDir);
        const scan = scanNewTurns(capturesDir, cursor.last_finalized_at, MAX_TURNS_FIRST_RUN);

        // Build per-project recap
        const recap: PerProjectRecap = {
          v: 1,
          t: now,
          tick_id: tickId,
          project_id: project.project_id,
          project_slug: project.slug,
          turns_new: scan.turns.length,
          turns_total_seen: cursor.total_turns_seen + scan.turns.length,
          tool_calls_new: sum(scan.turns, 'tool_call_count'),
          scrubber_hits_new: sum(scan.turns, 'scrubber_hit_count'),
          files_changed_new: sum(scan.turns, 'files_changed_count'),
          finalization_failures_new: 0, // not tracked yet
          skipped_poison: scan.skipped_poison,
          oldest_new_turn_at: scan.turns.length > 0 ? scan.turns[0]!.finalized_at : null,
          newest_new_turn_at: scan.turns.length > 0 ? scan.turns[scan.turns.length - 1]!.finalized_at : null,
          duration_ms: Date.now() - projectStart,
          llm_mode: false,
        };

        // Update cursor
        const newCursor = {
          last_finalized_at: scan.turns.length > 0
            ? scan.turns[scan.turns.length - 1]!.finalized_at
            : cursor.last_finalized_at,
          total_turns_seen: cursor.total_turns_seen + scan.turns.length,
          last_tick_id: tickId,
          updated_at: now,
        };
        writeCursor(stateDir, newCursor);

        return recap;
      });

      if (result === null) {
        projects_locked++;
        continue;
      }

      // Append per-project recap
      appendRecap(result, home);
      total_turns_new += result.turns_new;
      projects_processed++;
    } catch (err) {
      const msg = `project ${project.slug}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      logError('learner_project_error', msg, home);
      projects_skipped++;
    }
  }

  // Emit tick summary
  const summary: TickSummary = {
    v: 1,
    t: now,
    tick_id: tickId,
    summary: true,
    projects_processed,
    projects_skipped,
    projects_locked,
    projects_missing,
    total_turns_new,
    total_duration_ms: Date.now() - tickStart,
    errors,
  };
  appendRecap(summary, home);

  // LLM mode (feature-flagged)
  if (process.env.CLAUDE_SOP_LEARNER_MODE === 'llm') {
    try {
      const { runLlmBatch } = await import('./llm-mode.js');
      await runLlmBatch(home, tickId, registry, total_turns_new);
    } catch (err) {
      logError('learner_llm_error', err, home);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────

function sum(turns: TurnSummary[], key: keyof TurnSummary): number {
  let total = 0;
  for (const t of turns) {
    const val = t[key];
    if (typeof val === 'number') total += val;
  }
  return total;
}

// ── Entry ──────────────────────────────────────────────────

main().catch((err) => {
  // Ultimate fail-open: even if main() somehow rejects uncaught
  try {
    const logDir = join(homedir(), '.claude-sop', 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, 'errors.log'),
      JSON.stringify({ t: new Date().toISOString(), kind: 'learner_fatal', err: String(err) }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // absolutely nothing we can do
  }
  process.exit(0);
});

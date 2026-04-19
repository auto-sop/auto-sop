/**
 * Learner main — real Phase 3 entry point.
 * Reads project registry, scans captures, produces recap log entries.
 *
 * FAIL-OPEN POLICY: Every error at every layer is caught, logged to
 * ~/.auto-sop/logs/errors.log as one-line JSON, then process exits 0.
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
import { writeManagedSection } from '../managed-section/editor.js';
import { isGitBusy } from '../managed-section/git-state.js';
import {
  applyDirectiveHistory,
  getDirectiveConfig,
  consumeJustRestored,
  type DirectiveHistoryEntry,
} from '../managed-section/directive-history.js';
import { buildDirectiveBody } from './directive-builder.js';
import { loadTurnsForDetection } from './turn-loader.js';
import {
  detectors,
  countBashFailureCandidates,
  countEditFailureCandidates,
} from './detectors/index.js';
import {
  DirectiveProposal,
  type DirectiveProposalType,
} from './directive-schema.js';
import { runLlmAnalysis } from './llm-mode.js';
import { mergeProposalsWithDedup } from './merge-proposals.js';

// ── Constants ──────────────────────────────────────────────

/**
 * (PLAN-v17 I6) Hard-timeout for the entire learner tick. Covers every
 * layer: detectors, file I/O, cursor locks, `claude -p`. On expiry:
 *   1. log `learner_hard_timeout` to errors.log
 *   2. write a partial recap summary with `hard_timeout: true`
 *   3. process.exit(0) — fail-open policy
 *
 * SECURITY: this value is NOT overridable via env var or flag. A
 * malicious or misconfigured environment cannot disable the watchdog.
 *
 * Exported so unit tests can reference the exact production constant
 * without duplicating the magic number. The export is read-only (const).
 */
export const HARD_TIMEOUT_MS = 600_000; // 10 minutes
/** Inner budget for the `claude -p` spawn itself. Bounded well below
 *  HARD_TIMEOUT_MS so the watchdog remains a true fallback, not the
 *  primary kill path. */
export const LLM_SPAWN_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TURNS_FIRST_RUN = 500;

// ── Testable helpers ───────────────────────────────────────

/**
 * (PLAN-v17 I6) Build the partial TickSummary written when the
 * hard-timeout watchdog fires. Extracted so unit tests can assert on
 * the exact shape without spinning up a full learner tick. Pure —
 * depends only on arguments + Date.now().
 */
export function buildHardTimeoutSummary(
  tickId: string,
  tickStart: number,
): TickSummary {
  return {
    v: 1,
    t: new Date().toISOString(),
    tick_id: tickId,
    summary: true,
    projects_processed: 0,
    projects_skipped: 0,
    projects_locked: 0,
    projects_missing: 0,
    total_turns_new: 0,
    total_duration_ms: Date.now() - tickStart,
    errors: ['learner_hard_timeout'],
    hard_timeout: true,
  };
}

/**
 * (PLAN-v17 I8) Decide whether to skip the LLM for this tick because
 * no new turns arrived. Respects CLAUDE_SOP_FORCE_LLM=1 override.
 * Pure — environment is explicit, so tests don't have to mutate
 * process.env.
 */
export function shouldSkipLlmForIdleTick(
  turnsNew: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return turnsNew === 0 && env.AUTO_SOP_FORCE_LLM !== '1' && env.CLAUDE_SOP_FORCE_LLM !== '1';
}

/**
 * (V20) Build the final list of DirectiveProposalType objects for
 * rendering into CLAUDE.md. When directive history is available,
 * activeEntries drives the ordering; each entry is matched against
 * mergedProposals (which carry full evidence). When no matching
 * proposal exists (e.g. zero-turn tick after restore), we synthesize
 * a DirectiveProposalType from the history entry so the directive
 * is not silently dropped.
 *
 * Extracted from main() for testability.
 */
export function buildRenderProposals(
  activeEntries: DirectiveHistoryEntry[] | null,
  mergedProposals: DirectiveProposalType[],
): DirectiveProposalType[] {
  if (activeEntries === null) return mergedProposals;

  return activeEntries.map((e) => {
    const fromProposal = mergedProposals.find((p) => p.id === e.id);
    if (fromProposal) return fromProposal;

    // Synthesize a DirectiveProposalType from the history entry so
    // restored/previously-seen directives survive zero-turn ticks.
    return {
      id: e.id,
      rule_text: e.rule_text,
      severity: e.severity,
      detector: 'history',
      evidence: {
        session_ids: Array.from(
          { length: Math.max(3, Math.min(e.occurrence_count, 25)) },
          (_, i) => `history-session-${i + 1}`,
        ),
        turn_ids: [],
        pattern: 'restored-from-history',
        occurrence_count: e.occurrence_count,
        first_seen: e.first_seen,
      },
      created_at: e.last_reinforced,
    } satisfies DirectiveProposalType;
  });
}

// ── Error logger (inline, fail-safe) ───────────────────────

function logError(kind: string, err: unknown, home?: string): void {
  try {
    const logDir = join(home ?? homedir(), '.auto-sop', 'logs');
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
    return existsSync(join(home, '.auto-sop', 'paused.flag'));
  } catch {
    return false;
  }
}

// ── Learner lock ───────────────────────────────────────────

function acquireLearnerLock(home: string): (() => void) | null {
  const lockDir = join(home, '.auto-sop');
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
      stale: HARD_TIMEOUT_MS + 10_000, // stale ~10s after hard-timeout
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

export async function main(): Promise<void> {
  const home = homedir();
  const tickId = makeTickId();
  const tickStart = Date.now();

  // (PLAN-v17 I6) Hard-timeout watchdog. Covers every hang point:
  // detectors, file locks, claude -p, even synchronous I/O. Fires
  // UNCONDITIONALLY — no env/flag can disable it.
  const ac = new AbortController();
  const timeout = setTimeout(() => {
    ac.abort();
    // Best-effort: log + write a partial recap summary so observers
    // can distinguish "learner crashed" from "learner was killed by
    // the watchdog after running too long".
    logError(
      'learner_hard_timeout',
      `learner tick exceeded ${HARD_TIMEOUT_MS}ms budget`,
      home,
    );
    try {
      appendRecap(buildHardTimeoutSummary(tickId, tickStart), home);
    } catch (err) {
      // appendRecap can itself fail (disk full, permission). Log and
      // continue — the timeout handler must never throw.
      logError('learner_hard_timeout_recap_failed', err, home);
    }
    // Fail-open: exit 0 immediately. The extra 5s window that the v16
    // handler granted is unnecessary now that we proactively write the
    // partial summary before exit.
    process.exit(0);
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

export async function runLearnerTick(
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

      const stateDir = join(validRoot, '.auto-sop', 'state');
      const capturesDir = join(validRoot, '.auto-sop', 'captures');

      // Acquire cursor lock
      const lockResult = withCursorLock(stateDir, () => {
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

        // B4: expose the cumulative newest-finalized-at (post-update
        // cursor value) so the directive body can be anchored to data
        // rather than wall-clock time.
        return {
          recap,
          newestTurnFinalizedAt: newCursor.last_finalized_at || null,
        };
      });

      if (lockResult === null) {
        projects_locked++;
        continue;
      }

      const result = lockResult.recap;
      const newestTurnFinalizedAt = lockResult.newestTurnFinalizedAt;

      // PLAN-v14: LLM mode is DEFAULT ON. Opt-out via
      //   CLAUDE_SOP_LEARNER_MODE=offline
      // which skips the `claude -p` invocation and runs only the
      // rule-based detectors.
      //
      // Also skip LLM when the parent process set CLAUDE_SOP_CAPTURE_SUPPRESS=1
      // (recursion guard): this env is set inside a learner-spawned
      // `claude -p` child, so if Phase-2 capture somehow gets hold of
      // a turn from that child, a subsequent learner tick must not
      // re-invoke LLM against its own analysis output. The legacy
      // `CLAUDE_SOP_LEARNER` name is still honored for backward compat
      // with tick scripts installed by older versions.
      const isOffline =
        process.env.AUTO_SOP_LEARNER_MODE === 'offline' ||
        process.env.CLAUDE_SOP_LEARNER_MODE === 'offline' ||
        process.env.AUTO_SOP_CAPTURE_SUPPRESS === '1' ||
        process.env.CLAUDE_SOP_CAPTURE_SUPPRESS === '1' ||
        process.env.CLAUDE_SOP_LEARNER === '1';

      // Load turn data ONCE per project per tick (shared across all detectors)
      let turnData: ReturnType<typeof loadTurnsForDetection> = [];
      try {
        turnData = loadTurnsForDetection(capturesDir, MAX_TURNS_FIRST_RUN);
      } catch (err) {
        logError('turn_loader_failed', err, home);
        turnData = [];
      }

      // Execute every detector inside try/catch — a crashing detector
      // must never abort the tick. Track run/fail counts for recap.
      const ruleProposals: DirectiveProposalType[] = [];
      let detectorsRun = 0;
      let detectorsFailed = 0;

      for (const detector of detectors) {
        detectorsRun++;
        try {
          const raw = detector.detect(turnData);
          for (const proposal of raw) {
            const parsed = DirectiveProposal.safeParse(proposal);
            if (parsed.success) {
              ruleProposals.push(parsed.data);
            } else {
              logError(
                'directive_schema_rejected',
                {
                  detector: detector.name,
                  // Only log structured validation errors (not the
                  // malformed proposal itself, which could be huge).
                  issues: parsed.error.issues,
                },
                home,
              );
            }
          }
        } catch (err) {
          detectorsFailed++;
          logError('detector_failed', { detector: detector.name, err: String(err) }, home);
        }
      }

      // Count below-threshold candidates for "monitoring" status line
      let candidateCount = 0;
      try {
        candidateCount =
          countBashFailureCandidates(turnData) +
          countEditFailureCandidates(turnData);
      } catch (err) {
        logError('candidate_count_failed', err, home);
      }

      // Run LLM analysis (unless offline). Fail-open: any error → empty
      // result; we still write CLAUDE.md using just the rule-based output.
      let llmResult: Awaited<ReturnType<typeof runLlmAnalysis>> = {
        proposals: [],
        summary: '',
        turnsAnalyzed: 0,
        patternsBelowThreshold: 0,
        durationMs: 0,
        error: null,
      };

      // (PLAN-v17 I9) Skip LLM when directives were just restored from
      // a previous install. The learner would otherwise see the old
      // directives in past turns, conclude no new patterns, and write
      // "No recurring patterns detected yet" — losing all directives.
      // consumeJustRestored reads + deletes the flag atomically, so the
      // skip fires exactly once.
      const justRestored = (() => {
        try {
          return consumeJustRestored(validRoot);
        } catch {
          return false;
        }
      })();

      // (PLAN-v17 I8) Skip the LLM entirely when no new turns arrived
      // this tick. `claude -p` takes 10–30s even for an empty prompt,
      // so skipping idle ticks is a large wall-clock win. Override via
      // AUTO_SOP_FORCE_LLM=1 (wired to `auto-sop learn-now --force-llm`
      // in Wave 2).
      if (justRestored) {
        result.llm_skipped = 'just_restored';
        llmResult = {
          proposals: [],
          summary: '',
          turnsAnalyzed: 0,
          patternsBelowThreshold: 0,
          durationMs: 0,
          error: 'skipped_just_restored',
        };
      } else if (shouldSkipLlmForIdleTick(result.turns_new)) {
        // Record the skip in the recap. `llm_error` stays 'skipped_no_new_turns'
        // so structured log analysis can count skip events, but
        // `llm_fallback` is explicitly cleared below because a skip is
        // an optimization, not a failure.
        result.llm_skipped = 'no_new_turns';
        llmResult = {
          proposals: [],
          summary: '',
          turnsAnalyzed: 0,
          patternsBelowThreshold: 0,
          durationMs: 0,
          error: 'skipped_no_new_turns',
        };
      } else {
        try {
          // Count distinct sessions represented in the turn set so the LLM
          // prompt accurately reports "N turns from M sessions" rather than
          // treating every turn as its own session.
          const sessionCount = new Set(turnData.map((t) => t.session_id)).size;
          llmResult = await runLlmAnalysis(
            turnData,
            project.slug,
            sessionCount,
            { offline: isOffline, timeout: LLM_SPAWN_TIMEOUT_MS },
          );
          if (llmResult.error !== null && !isOffline) {
            logError('learner_llm_error', llmResult.error, home);
          }
        } catch (err) {
          // runLlmAnalysis is documented never to throw, but guard anyway.
          logError('learner_llm_error', err, home);
        }
      }

      // Merge rule-based + LLM proposals. On LLM failure, llmResult.proposals
      // is empty so the merger degrades gracefully to rule-only output.
      // E4: capture semantic-dedup count so it surfaces in the recap.
      const mergeResult = mergeProposalsWithDedup(
        ruleProposals,
        llmResult.proposals,
      );
      const mergedProposals = mergeResult.proposals;
      result.merge_deduped_count = mergeResult.dedupedCount;

      // E5: Run proposals through the directive history module.
      // Ordering constraint (PLAN-v16): history must happen AFTER the
      // git-busy check and BEFORE the hash drift check. The git-busy
      // check lives inside writeManagedSection; mirror it here so that
      // when git is busy we skip updating history entirely (avoids a
      // bogus last_reinforced bump for a tick that won't render).
      // writeManagedSection still performs its own git-busy check below
      // and returns the canonical 'git_busy' verdict.
      let activeEntries: DirectiveHistoryEntry[] | null = null;
      const busy = (() => {
        try {
          return isGitBusy(validRoot);
        } catch {
          return false;
        }
      })();
      if (!busy) {
        try {
          const hist = applyDirectiveHistory(validRoot, mergedProposals, {
            config: getDirectiveConfig(),
          });
          activeEntries = hist.active;
          result.directives_pruned_count =
            mergedProposals.length - hist.active.length;
        } catch (err) {
          // History failure is non-fatal — fall back to rendering the
          // merged proposals directly so we don't silently drop a tick.
          logError('directive_history_failed', err, home);
          activeEntries = null;
        }
      }

      // Translate history entries back into DirectiveProposalType shape
      // expected by buildDirectiveBody. When history is unavailable
      // (git-busy or error path) we pass mergedProposals directly.
      // V20: uses buildRenderProposals which synthesizes from history
      // when no matching mergedProposal exists (fixes zero-turn restore bug).
      const renderProposals: DirectiveProposalType[] =
        buildRenderProposals(activeEntries, mergedProposals);

      try {
        const directiveContent = buildDirectiveBody(
          project,
          now,
          result.turns_total_seen,
          renderProposals,
          candidateCount,
          // Only render the AI analysis line when the LLM actually ran
          // AND produced a summary. Suppress on fallback so stale
          // context doesn't bleed across ticks.
          !isOffline && llmResult.error === null
            ? llmResult.summary
            : undefined,
          // B4: data-anchored timestamp — identical scan inputs yield
          // byte-identical bodies, so the managed-section editor
          // reports verdict='unchanged' when nothing new has happened.
          newestTurnFinalizedAt,
        );
        const writeResult = writeManagedSection({
          projectRoot: validRoot,
          content: directiveContent,
          dryRun: process.env.AUTO_SOP_LEARNER_DRY_RUN === '1' || process.env.CLAUDE_SOP_LEARNER_DRY_RUN === '1',
          // Forward structured editor events
          // (managed_section_drift_detected / managed_section_skip_git_state)
          // into the learner's existing errors.log.
          logger: (kind, data) => logError(kind, data, home),
        });
        result.directive_written = writeResult.verdict;
        result.directive_bytes = writeResult.bytesAfter;
        result.directive_backup = writeResult.backupPath !== null;
      } catch (err) {
        logError('directive_write_failed', err, home);
        result.directive_written = 'error';
      }

      result.directives_active = renderProposals.length;
      result.directives_candidates = candidateCount;
      result.detectors_run = detectorsRun;
      result.detectors_failed = detectorsFailed;

      // Populate LLM-mode fields on the per-project recap so
      // `auto-sop recap` can surface what happened.
      result.llm_mode = !isOffline;
      result.llm_duration_ms = llmResult.durationMs;
      result.llm_directives_proposed = llmResult.proposals.length;
      // The number of LLM proposals that actually landed in the managed
      // section — i.e. survived id dedup, semantic dedup, history TTL,
      // and the cap. Computed as "rendered items whose id came from the
      // LLM set".
      const llmIds = new Set(llmResult.proposals.map((p) => p.id));
      result.llm_directives_accepted = renderProposals.filter((p) =>
        llmIds.has(p.id),
      ).length;
      result.llm_directives_rejected =
        llmResult.proposals.length - (result.llm_directives_accepted ?? 0);
      result.llm_error = llmResult.error;
      // (PLAN-v17 I8) A deliberate skip is NOT a fallback — it's an
      // optimization. The skip reason lives in `llm_skipped`; clearing
      // `llm_fallback` prevents dashboards from treating an idle tick
      // as a regression.
      result.llm_fallback =
        llmResult.error !== null &&
        llmResult.error !== 'skipped_no_new_turns' &&
        llmResult.error !== 'skipped_just_restored';

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

/**
 * Auto-invoke main() when this module is executed as a script
 * (production path: `node dist/plugin/learner.cjs`). When imported
 * by unit tests (Vitest sets `VITEST=true`), skip the auto-invocation
 * so tests can exercise `main` / `runLearnerTick` in a controlled
 * environment without process.exit firing at import time.
 */
if (process.env.VITEST !== 'true') {
  main().catch((err) => {
    // Ultimate fail-open: even if main() somehow rejects uncaught
    try {
      const logDir = join(homedir(), '.auto-sop', 'logs');
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
}

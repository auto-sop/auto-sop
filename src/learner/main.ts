/**
 * Learner main — real Phase 3 entry point.
 * Reads project registry, scans captures, produces recap log entries.
 *
 * FAIL-OPEN POLICY: Every error at every layer is caught, logged to
 * ~/.auto-sop/logs/errors.log as one-line JSON, then process exits 0.
 * No non-zero exit path anywhere.
 */
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { DirectiveProposal, type DirectiveProposalType } from './directive-schema.js';
import { runIncrementalLlmAnalysis } from './llm-mode.js';
import {
  readCandidates,
  writeCandidates,
  mergeCandidateEvidence,
  graduateCandidates,
  pruneStaleCandidates,
  type PatternCandidate,
} from './pattern-store.js';
import { mergeProposalsWithDedup } from './merge-proposals.js';
import { compactFires, readFires } from '../capture/writer/directive-fire.js';

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
export const LLM_SPAWN_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_TURNS_FIRST_RUN = 500;
/** Cap on turns sent to the LLM — keeps the prompt within context window limits. */
const MAX_TURNS_FOR_LLM = 5;

// ── Testable helpers ───────────────────────────────────────

/**
 * (PLAN-v17 I6) Build the partial TickSummary written when the
 * hard-timeout watchdog fires. Extracted so unit tests can assert on
 * the exact shape without spinning up a full learner tick. Pure —
 * depends only on arguments + Date.now().
 */
export function buildHardTimeoutSummary(tickId: string, tickStart: number): TickSummary {
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
 * Minimum new turns required before invoking the LLM. A single turn
 * rarely yields cross-session patterns — spending tokens on it is
 * wasteful. Rule-based detectors still run on every tick regardless.
 */
export const MIN_TURNS_FOR_LLM = 3;

/**
 * (PLAN-v17 I8) Decide whether to skip the LLM for this tick because
 * too few new turns arrived. Respects CLAUDE_SOP_FORCE_LLM=1 override.
 * Pure — environment is explicit, so tests don't have to mutate
 * process.env.
 */
export function shouldSkipLlmForIdleTick(
  turnsNew: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.AUTO_SOP_FORCE_LLM === '1' || env.CLAUDE_SOP_FORCE_LLM === '1') return false;
  return turnsNew < MIN_TURNS_FOR_LLM;
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

// ── Error serialization ──────────────────────────────────────

/**
 * Serialize an unknown error value into a human-readable string.
 * Exported for testing (V27 fix #3 — tests must exercise the real function).
 */
export function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

// ── Error logger (inline, fail-safe) ───────────────────────

function logError(kind: string, err: unknown, home?: string): void {
  try {
    const logDir = join(home ?? homedir(), '.auto-sop', 'logs');
    mkdirSync(logDir, { recursive: true });
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        kind,
        err: serializeError(err),
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
    logError('learner_hard_timeout', `learner tick exceeded ${HARD_TIMEOUT_MS}ms budget`, home);
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
          newest_new_turn_at:
            scan.turns.length > 0 ? scan.turns[scan.turns.length - 1]!.finalized_at : null,
          duration_ms: Date.now() - projectStart,
          llm_mode: false,
        };

        // Update cursor
        const newCursor = {
          last_finalized_at:
            scan.turns.length > 0
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
          prevFinalizedAt: cursor.last_finalized_at || null,
        };
      });

      if (lockResult === null) {
        projects_locked++;
        continue;
      }

      const result = lockResult.recap;
      const newestTurnFinalizedAt = lockResult.newestTurnFinalizedAt;
      const prevFinalizedAt = lockResult.prevFinalizedAt;

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
      // Only explicit LEARNER_MODE=offline disables LLM. The capture-suppress
      // and CLAUDE_SOP_LEARNER env vars are recursion guards for the capture
      // pipeline — they must NOT force the learner offline, otherwise the
      // hourly cron (tick.sh) never runs LLM analysis.
      const isOffline =
        process.env.AUTO_SOP_LEARNER_MODE === 'offline' ||
        process.env.CLAUDE_SOP_LEARNER_MODE === 'offline';

      // Load turn data ONCE per project per tick (shared across all detectors).
      // Skip entirely when no new turns — avoids reading hundreds of turn
      // dirs on idle ticks (pure I/O savings).
      let turnData: ReturnType<typeof loadTurnsForDetection> = [];
      if (result.turns_new > 0) {
        try {
          turnData = loadTurnsForDetection(capturesDir, MAX_TURNS_FIRST_RUN);
        } catch (err) {
          logError('turn_loader_failed', err, home);
          turnData = [];
        }
      }

      // Execute every detector inside try/catch — a crashing detector
      // must never abort the tick. Track run/fail counts for recap.
      // Skip when no new turns (detectors can't find anything new).
      const ruleProposals: DirectiveProposalType[] = [];
      let detectorsRun = 0;
      let detectorsFailed = 0;

      if (turnData.length > 0) {
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
      }

      // Count below-threshold candidates for "monitoring" status line
      let candidateCount = 0;
      try {
        candidateCount =
          countBashFailureCandidates(turnData) + countEditFailureCandidates(turnData);
      } catch (err) {
        logError('candidate_count_failed', err, home);
      }

      // ── V29: Incremental Pattern Memory pipeline ────────────
      // Instead of a single-shot LLM analysis, we accumulate pattern
      // candidates across ticks. Each tick: read existing candidates,
      // prune stale, ask LLM for new/matched candidates, merge evidence,
      // graduate candidates with 3+ sessions → directive proposals.

      // 1. Read existing candidates from persistent store
      let existingCandidates: PatternCandidate[] = [];
      try {
        existingCandidates = readCandidates(stateDir);
      } catch (err) {
        logError('pattern_store_read_failed', err, home);
      }

      // 2. Prune stale non-graduated candidates (> 30 days)
      existingCandidates = pruneStaleCandidates(existingCandidates, 30);

      // 3. Determine current session IDs from turn data
      const currentSessionIds = [...new Set(turnData.map((t) => t.session_id))];
      const primarySessionId = currentSessionIds.length > 0 ? currentSessionIds[0]! : 'unknown';

      // Track LLM-level state for recap
      let llmDurationMs = 0;
      let llmError: string | null = null;
      let llmSummary = '';
      let llmCandidatesNew = 0;
      let llmCandidatesMatched = 0;

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

      if (justRestored) {
        result.llm_skipped = 'just_restored';
        llmError = 'skipped_just_restored';
      } else if (shouldSkipLlmForIdleTick(result.turns_new)) {
        result.llm_skipped = result.turns_new === 0 ? 'no_new_turns' : 'too_few_turns';
        llmError = result.turns_new === 0 ? 'skipped_no_new_turns' : 'skipped_too_few_turns';
      } else if (!isOffline) {
        // 4. Run incremental LLM analysis
        try {
          // Cap turns sent to LLM — safety valve for prompt size.
          // Rule-based detectors still see ALL turns.
          const llmTurns = turnData.slice(-MAX_TURNS_FOR_LLM);

          const llmResult = await runIncrementalLlmAnalysis(
            llmTurns,
            project.slug,
            existingCandidates,
            primarySessionId,
            { timeout: LLM_SPAWN_TIMEOUT_MS },
          );
          llmDurationMs = llmResult.durationMs;
          llmError = llmResult.error;

          if (llmResult.error !== null) {
            logError('learner_llm_error', llmResult.error, home);
          } else {
            // 5. For new candidates, populate session_ids with ALL
            // sessions present in the current turn batch.
            for (const nc of llmResult.parsed.newCandidates) {
              nc.session_ids = currentSessionIds.length > 0 ? [...currentSessionIds] : [primarySessionId];
            }

            // 6. Merge new candidate evidence into existing store
            existingCandidates = mergeCandidateEvidence(
              existingCandidates,
              llmResult.parsed.newCandidates,
            );

            // 7. Apply matched_existing updates — add session + turn evidence
            for (const match of llmResult.parsed.matchedExisting) {
              const target = existingCandidates.find((c) => c.id === match.candidateId);
              if (target) {
                // Union session_ids
                const sessionSet = new Set(target.session_ids);
                for (const sid of currentSessionIds) sessionSet.add(sid);
                target.session_ids = [...sessionSet];
                // Union turn_ids
                const turnSet = new Set(target.turn_ids);
                for (const tid of match.turnIds) turnSet.add(tid);
                target.turn_ids = [...turnSet];
                // Add occurrences
                target.occurrence_count += match.additionalOccurrences;
                // Update last_seen
                const nowIso = new Date().toISOString();
                if (nowIso > target.last_seen) target.last_seen = nowIso;
              }
            }

            llmSummary = llmResult.summary;
            llmCandidatesNew = llmResult.parsed.newCandidates.length;
            llmCandidatesMatched = llmResult.parsed.matchedExisting.length;
          }
        } catch (err) {
          // runIncrementalLlmAnalysis is documented never to throw, but guard anyway.
          logError('learner_llm_error', err, home);
        }
      }
      // When offline: skip the LLM call but still run graduation below

      // 8. Graduate candidates with 3+ distinct sessions
      const { graduated: graduatedProposals, updated: updatedCandidates } =
        graduateCandidates(existingCandidates);
      const llmCandidatesGraduated = graduatedProposals.length;

      // 9. Write updated candidates back to persistent store
      try {
        writeCandidates(stateDir, updatedCandidates);
      } catch (err) {
        logError('pattern_store_write_failed', err, home);
      }

      // 10. Validate graduated candidates through the same Zod safeParse
      // gate used for ruleProposals — prevents managed-section marker
      // injection from crafted LLM responses (SEC-001).
      const validGraduated: DirectiveProposalType[] = [];
      for (const p of graduatedProposals) {
        const parsed = DirectiveProposal.safeParse(p);
        if (parsed.success) {
          validGraduated.push(parsed.data);
        } else {
          logError(
            'graduated_candidate_schema_rejected',
            { id: (p as Record<string, unknown>).id, issues: parsed.error.issues },
            home,
          );
        }
      }

      // 11. Feed validated graduated directives into the existing merge pipeline.
      const mergeResult = mergeProposalsWithDedup(ruleProposals, validGraduated);
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
          result.directives_pruned_count = mergedProposals.length - hist.active.length;
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
      const renderProposals: DirectiveProposalType[] = buildRenderProposals(
        activeEntries,
        mergedProposals,
      );

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
          !isOffline && llmError === null ? llmSummary : undefined,
          // B4: data-anchored timestamp — identical scan inputs yield
          // byte-identical bodies, so the managed-section editor
          // reports verdict='unchanged' when nothing new has happened.
          newestTurnFinalizedAt,
        );
        const writeResult = writeManagedSection({
          projectRoot: validRoot,
          content: directiveContent,
          dryRun:
            process.env.AUTO_SOP_LEARNER_DRY_RUN === '1' ||
            process.env.CLAUDE_SOP_LEARNER_DRY_RUN === '1',
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
      result.llm_duration_ms = llmDurationMs;
      result.llm_directives_proposed = graduatedProposals.length;
      // The number of LLM proposals that actually landed in the managed
      // section — i.e. survived id dedup, semantic dedup, history TTL,
      // and the cap. Computed as "rendered items whose id came from the
      // graduated set".
      const llmIds = new Set(graduatedProposals.map((p) => p.id));
      result.llm_directives_accepted = renderProposals.filter((p) => llmIds.has(p.id)).length;
      result.llm_directives_rejected =
        graduatedProposals.length - (result.llm_directives_accepted ?? 0);
      result.llm_error = llmError;
      // (PLAN-v17 I8) A deliberate skip is NOT a fallback — it's an
      // optimization. The skip reason lives in `llm_skipped`; clearing
      // `llm_fallback` prevents dashboards from treating an idle tick
      // as a regression.
      result.llm_fallback =
        llmError !== null &&
        llmError !== 'skipped_no_new_turns' &&
        llmError !== 'skipped_just_restored';

      // V29: Incremental candidate recap fields
      result.llm_candidates_new = llmCandidatesNew;
      result.llm_candidates_matched = llmCandidatesMatched;
      result.llm_candidates_graduated = llmCandidatesGraduated;
      result.llm_candidates_total = updatedCandidates.length;

      // V30: Directive-fire compaction + recap fields
      // Wrapped in try/catch — fire compaction failure must NEVER abort the tick.
      try {
        const compacted = compactFires(stateDir, 90);
        if (compacted > 0) {
          logError('directive_fire_compacted', { project: project.slug, removed: compacted }, home);
        }
        const allFires = readFires(stateDir);
        result.directive_fires_total = allFires.length;
        // Count fires since the previous tick's cursor timestamp (single read, filter in-memory)
        result.directive_fires_new = prevFinalizedAt
          ? allFires.filter((f) => f.t > prevFinalizedAt).length
          : allFires.length;
      } catch (err) {
        // Note: compactFires and readFires are error-swallowing; this catch
        // exists for unexpected synchronous throws only (e.g. type errors).
        logError('directive_fire_compaction_failed', err, home);
        result.directive_fires_new = 0;
        result.directive_fires_total = 0;
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
        JSON.stringify({ t: new Date().toISOString(), kind: 'learner_fatal', err: String(err) }) +
          '\n',
        { mode: 0o600 },
      );
    } catch {
      // absolutely nothing we can do
    }
    process.exit(0);
  });
}

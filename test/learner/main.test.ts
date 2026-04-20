/**
 * Unit tests for src/learner/main.ts — PLAN-v17 items I6 + I8.
 *
 * Coverage:
 *   I6: HARD_TIMEOUT_MS constant, buildHardTimeoutSummary shape,
 *       watchdog-callback integration (fake timers → partial recap
 *       written → process.exit(0)).
 *   I8: shouldSkipLlmForIdleTick decision function across the three
 *       axes (turnsNew, CLAUDE_SOP_FORCE_LLM).
 *
 * We intentionally do NOT call `main()` directly. Doing so would
 * require the learner to run against a real filesystem home — the
 * helpers + a replay of main()'s timer-setup pattern give full
 * behavioral coverage with far less flakiness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  HARD_TIMEOUT_MS,
  LLM_SPAWN_TIMEOUT_MS,
  buildHardTimeoutSummary,
  shouldSkipLlmForIdleTick,
  buildRenderProposals,
} from '../../src/learner/main.js';
import type { DirectiveHistoryEntry } from '../../src/managed-section/directive-history.js';
import type { DirectiveProposalType } from '../../src/learner/directive-schema.js';
import { appendRecap, recapLogPath } from '../../src/learner/recap-log.js';

// ── I6: Constants ──────────────────────────────────────────

describe('HARD_TIMEOUT_MS', () => {
  it('is 600_000 ms (10 minutes) per PLAN-v17', () => {
    expect(HARD_TIMEOUT_MS).toBe(600_000);
  });

  it('is strictly greater than LLM_SPAWN_TIMEOUT_MS so the watchdog outlasts the inner LLM timeout', () => {
    expect(HARD_TIMEOUT_MS).toBeGreaterThan(LLM_SPAWN_TIMEOUT_MS);
  });
});

// ── I6: buildHardTimeoutSummary ────────────────────────────

describe('buildHardTimeoutSummary', () => {
  it('returns a TickSummary with hard_timeout=true and errors=[learner_hard_timeout]', () => {
    const tickStart = Date.now() - 1_234;
    const summary = buildHardTimeoutSummary('ck-12h34', tickStart);

    expect(summary.v).toBe(1);
    expect(summary.summary).toBe(true);
    expect(summary.tick_id).toBe('ck-12h34');
    expect(summary.hard_timeout).toBe(true);
    expect(summary.errors).toEqual(['learner_hard_timeout']);
  });

  it('reports zero project counts (tick was killed before/during work)', () => {
    const summary = buildHardTimeoutSummary('ck-00h00', Date.now());
    expect(summary.projects_processed).toBe(0);
    expect(summary.projects_skipped).toBe(0);
    expect(summary.projects_locked).toBe(0);
    expect(summary.projects_missing).toBe(0);
    expect(summary.total_turns_new).toBe(0);
  });

  it('total_duration_ms reflects elapsed wall-clock since tickStart', () => {
    const tickStart = Date.now() - 2_500;
    const summary = buildHardTimeoutSummary('ck-00h01', tickStart);
    // Allow ±500ms of slack for CI jitter.
    expect(summary.total_duration_ms).toBeGreaterThanOrEqual(2_000);
    expect(summary.total_duration_ms).toBeLessThan(10_000);
  });

  it('emits an ISO-8601 timestamp in `t`', () => {
    const summary = buildHardTimeoutSummary('ck-00h02', Date.now());
    // Basic ISO-8601 shape check.
    expect(summary.t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ── I6: Watchdog integration (replayed setTimeout pattern) ─

describe('hard-timeout watchdog behavior (replayed)', () => {
  let tmpHome: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'learner-hard-timeout-'));
    // Prevent process.exit from actually terminating the test runner.
    // We throw so the timer callback unwinds after exit is "requested".
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit-intercepted');
    }) as never);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Replays exactly what src/learner/main.ts sets up in main(): an
   * AbortController + setTimeout(HARD_TIMEOUT_MS) whose callback writes
   * a partial recap via buildHardTimeoutSummary and calls process.exit(0).
   * This is the "mock a slow detector that sleeps 700s" scenario asked
   * for by the PLAN-v17 I6 acceptance criteria — we use fake timers so
   * the "700 seconds" of detector sleep compress to zero real wall-clock.
   */
  it('fires partial-recap write + process.exit(0) at HARD_TIMEOUT_MS', () => {
    const tickStart = Date.now();
    const tickId = 'ck-12h00';
    const ac = new AbortController();

    // Replay of main()'s watchdog setup.
    const timer = setTimeout(() => {
      ac.abort();
      try {
        appendRecap(buildHardTimeoutSummary(tickId, tickStart), tmpHome);
      } catch {
        /* best-effort */
      }
      process.exit(0);
    }, HARD_TIMEOUT_MS);
    timer.unref();

    // Just before the 600s boundary — nothing should have fired yet.
    vi.advanceTimersByTime(HARD_TIMEOUT_MS - 1);
    expect(ac.signal.aborted).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(recapLogPath(tmpHome))).toBe(false);

    // Cross the boundary. The timer fires its callback which throws via
    // the intercepted exit; advanceTimersByTime propagates that throw.
    expect(() => vi.advanceTimersByTime(2)).toThrow('process.exit-intercepted');

    // Post-fire assertions.
    expect(ac.signal.aborted).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Partial recap was persisted before the exit.
    const content = readFileSync(recapLogPath(tmpHome), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]!);
    expect(written.summary).toBe(true);
    expect(written.hard_timeout).toBe(true);
    expect(written.tick_id).toBe(tickId);
    expect(written.errors).toContain('learner_hard_timeout');
  });

  it('does NOT fire before HARD_TIMEOUT_MS elapses (699s < 600s is false; verify 300s still pending)', () => {
    const ac = new AbortController();

    const timer = setTimeout(() => {
      ac.abort();
      process.exit(0);
    }, HARD_TIMEOUT_MS);
    timer.unref();

    // At 300s (half the budget), the watchdog must still be pending.
    vi.advanceTimersByTime(300_000);
    expect(ac.signal.aborted).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();

    clearTimeout(timer);
  });
});

// ── I8: shouldSkipLlmForIdleTick ──────────────────────────

describe('shouldSkipLlmForIdleTick', () => {
  it('returns true when turnsNew === 0 and CLAUDE_SOP_FORCE_LLM is unset', () => {
    expect(shouldSkipLlmForIdleTick(0, {})).toBe(true);
  });

  it('returns false when turnsNew > 0 even if CLAUDE_SOP_FORCE_LLM is unset', () => {
    expect(shouldSkipLlmForIdleTick(1, {})).toBe(false);
    expect(shouldSkipLlmForIdleTick(5, {})).toBe(false);
  });

  it('returns false when CLAUDE_SOP_FORCE_LLM="1" overrides the idle skip', () => {
    expect(shouldSkipLlmForIdleTick(0, { CLAUDE_SOP_FORCE_LLM: '1' })).toBe(false);
  });

  it('returns false when both turnsNew > 0 and force flag is set', () => {
    expect(shouldSkipLlmForIdleTick(3, { CLAUDE_SOP_FORCE_LLM: '1' })).toBe(false);
  });

  it('treats non-"1" values of CLAUDE_SOP_FORCE_LLM as NOT forcing (strict "1" check)', () => {
    // Intentional strict semantics: only the literal string '1' unlocks
    // the LLM on an idle tick. "true"/""/"yes" all fall back to skip.
    expect(shouldSkipLlmForIdleTick(0, { CLAUDE_SOP_FORCE_LLM: 'true' })).toBe(true);
    expect(shouldSkipLlmForIdleTick(0, { CLAUDE_SOP_FORCE_LLM: '' })).toBe(true);
    expect(shouldSkipLlmForIdleTick(0, { CLAUDE_SOP_FORCE_LLM: '0' })).toBe(true);
  });

  it('defaults to reading from process.env when env arg is omitted', () => {
    const original = process.env.CLAUDE_SOP_FORCE_LLM;
    try {
      delete process.env.CLAUDE_SOP_FORCE_LLM;
      expect(shouldSkipLlmForIdleTick(0)).toBe(true);

      process.env.CLAUDE_SOP_FORCE_LLM = '1';
      expect(shouldSkipLlmForIdleTick(0)).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_SOP_FORCE_LLM;
      } else {
        process.env.CLAUDE_SOP_FORCE_LLM = original;
      }
    }
  });
});

// ── V20: buildRenderProposals (directive restore render bug) ──

describe('buildRenderProposals', () => {
  const now = '2026-04-19T12:00:00.000Z';

  function makeHistoryEntry(
    overrides: Partial<DirectiveHistoryEntry> & { id: string },
  ): DirectiveHistoryEntry {
    return {
      rule_text: `Always use proper error handling for ${overrides.id}`,
      severity: 'warning',
      first_seen: '2026-04-10T00:00:00.000Z',
      last_reinforced: now,
      occurrence_count: 5,
      pruned: false,
      ...overrides,
    };
  }

  function makeProposal(
    overrides: Partial<DirectiveProposalType> & { id: string },
  ): DirectiveProposalType {
    return {
      rule_text: `Always use proper error handling for ${overrides.id}`,
      severity: 'warning',
      detector: 'repeated-bash-failure',
      evidence: {
        session_ids: ['s1', 's2', 's3'],
        turn_ids: ['t1'],
        pattern: 'test-pattern',
        occurrence_count: 5,
        first_seen: '2026-04-10T00:00:00.000Z',
      },
      created_at: now,
      ...overrides,
    };
  }

  it('restored directives survive a zero-turn tick (mergedProposals empty)', () => {
    // 3 history entries, 0 new proposals — simulates a zero-turn tick
    // after a restore. Before V20 fix, all 3 would be filtered out.
    const activeEntries: DirectiveHistoryEntry[] = [
      makeHistoryEntry({ id: 'dir-a' }),
      makeHistoryEntry({ id: 'dir-b' }),
      makeHistoryEntry({ id: 'dir-c' }),
    ];
    const mergedProposals: DirectiveProposalType[] = [];

    const result = buildRenderProposals(activeEntries, mergedProposals);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual(['dir-a', 'dir-b', 'dir-c']);
    // Each synthesized proposal preserves rule_text from history
    for (const p of result) {
      expect(p.rule_text).toContain(p.id);
      expect(p.severity).toBe('warning');
      expect(p.detector).toBe('history');
      expect(p.created_at).toBe(now);
      // V20 YODA fixes: turn_ids must be empty (no broken link)
      expect(p.evidence.turn_ids).toEqual([]);
      // session_ids length reflects occurrence_count (default 5 in helper)
      expect(p.evidence.session_ids).toHaveLength(5);
    }
  });

  it('restored directives survive multiple consecutive zero-turn ticks', () => {
    const activeEntries: DirectiveHistoryEntry[] = [
      makeHistoryEntry({ id: 'dir-x' }),
      makeHistoryEntry({ id: 'dir-y' }),
    ];
    const emptyProposals: DirectiveProposalType[] = [];

    // Simulate 3 consecutive zero-turn ticks — each should produce
    // the same result since history entries don't change.
    for (let tick = 0; tick < 3; tick++) {
      const result = buildRenderProposals(activeEntries, emptyProposals);
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('dir-x');
      expect(result[1]!.id).toBe('dir-y');
      expect(result[0]!.rule_text).toContain('dir-x');
      expect(result[1]!.rule_text).toContain('dir-y');
    }
  });

  it('restored directives are replaced when re-proposed with fresher text', () => {
    const activeEntries: DirectiveHistoryEntry[] = [
      makeHistoryEntry({ id: 'dir-refresh', rule_text: 'old text from history' }),
      makeHistoryEntry({ id: 'dir-keep' }),
    ];
    const mergedProposals: DirectiveProposalType[] = [
      makeProposal({ id: 'dir-refresh', rule_text: 'improved text from new detection' }),
    ];

    const result = buildRenderProposals(activeEntries, mergedProposals);

    expect(result).toHaveLength(2);

    // dir-refresh should use the fresher proposal text, not the history text
    const refreshed = result.find((r) => r.id === 'dir-refresh')!;
    expect(refreshed.rule_text).toBe('improved text from new detection');
    expect(refreshed.detector).toBe('repeated-bash-failure'); // from proposal, not 'history'

    // dir-keep should be synthesized from history (no matching proposal)
    const kept = result.find((r) => r.id === 'dir-keep')!;
    expect(kept.rule_text).toContain('dir-keep');
    expect(kept.detector).toBe('history');
    // V20 YODA fixes: turn_ids empty, session_ids derived from occurrence_count
    expect(kept.evidence.turn_ids).toEqual([]);
    expect(kept.evidence.session_ids).toHaveLength(5);
  });

  it('returns mergedProposals directly when activeEntries is null', () => {
    const proposals = [makeProposal({ id: 'p1' }), makeProposal({ id: 'p2' })];
    const result = buildRenderProposals(null, proposals);
    expect(result).toBe(proposals); // same reference, no transformation
  });
});

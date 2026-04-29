# PLAN-v42: Persist MetricsState per Project (Stats Sync Fix)

## Overview
v41 added stats sync (CLI→server) but it reads from `~/.auto-sop/state/metrics/{hash}.json` which is never written. The raw data (directive fires, errors prevented, token estimates) is already computed in the tick — we just need to aggregate and persist it as MetricsState so stats sync can read it.

## Root Cause
`saveMetricsState()` exists in `src/metrics/state.ts` but is never called from `src/learner/main.ts`. The stats sync block calls `loadMetricsState()` which returns null for every project → no stats ever sent.

## Architecture Decisions
- Compute MetricsState from data already in scope — no new calculations needed
- Save after sync-queue append (line ~965), before recap
- Use `saveMetricsState()` which already handles directory creation + atomic write
- Token savings come from `syncEntry.token_estimate.savings_per_session * after.sessions` (cumulative estimate)
- Time saved derived from token savings (heuristic: 200 tokens/min of human review)
- `per_directive_attribution` populated from directive fires log

## Implementation Tasks

### Wave 1 (single task)

#### Task 1: ARCHITECT — Persist MetricsState in learner tick
Repo: **auto-sop**
Files: `src/learner/main.ts`
Requirements:
- Add import at top: `import { saveMetricsState } from '../metrics/state.js';`
- After line ~965 (`appendSyncEntry(stateDir, syncEntry)`), add a try/catch block that:
  1. Builds a `MetricsState` object from data already in scope:
     ```typescript
     // ── Persist MetricsState for stats sync ──
     try {
       const tokenEst = syncEntry.token_estimate;
       const totalTokensSaved = tokenEst
         ? Math.round(tokenEst.savings_per_session * (tokenEst.method === 'tool_call_heuristic'
             ? (syncEntry.session_comparison?.after?.sessions ?? 0)
             : 0))
         : 0;
       const metricsState: MetricsState = {
         v: 1,
         project_slug: project.slug,
         total_tokens_saved: totalTokensSaved,
         total_errors_prevented: result.errors_prevented_total ?? 0,
         total_time_saved_minutes: Math.round(totalTokensSaved / 200 * 10) / 10,
         per_directive_attribution: [], // TODO v43: populate from fire log
         last_computed_at: new Date().toISOString(),
       };
       await saveMetricsState(home, project.project_root, metricsState);
     } catch {
       // Non-blocking — stats sync is best-effort
     }
     ```
  2. Import `MetricsState` type from `../metrics/state.js`
  3. The `syncEntry`, `result`, `project`, and `home` variables are all already in scope
  4. This MUST be inside try/catch — metrics persist failure never aborts the tick
- NOTE: The enclosing function `runLearnerTick` is already async, so `await saveMetricsState()` works
Acceptance: After a tick, `~/.auto-sop/state/metrics/` directory exists with one JSON file per project containing real data.

#### Task 2: ARCHITECT — Verify stats sync fires end-to-end
Repo: **auto-sop**
Files: `test/license/stats-sync.test.ts` (existing)
Requirements:
- Add one integration-style test that:
  1. Creates a temp metrics state file via `saveMetricsState()`
  2. Calls `loadMetricsState()` and verifies it returns the saved data
  3. Verifies the data shape matches what `syncStats()` expects
- This validates the read/write round-trip that was previously broken
Acceptance: Test passes, proving the MetricsState pipeline is connected.

## Quality Gates (MANDATORY)
3. YODA: Code review — verify metrics computation is correct
4. APEX: Security review — no PII in metrics state files
5. ANALYZER: Code improvement review — must pass C or above

## Finalize
6. ARCHITECT: Commit with message "fix(v42): persist MetricsState in tick — unblock stats sync to server"

## Acceptance Criteria
- After a tick, `~/.auto-sop/state/metrics/{hash}.json` files exist for each project
- `loadMetricsState()` returns non-null for projects with computed data
- Stats sync fires on next tick (verify `.last-stats-sync` throttle file is created)
- Server receives stats POST (verify `asop_stats_log` table has entries)
- No existing tests broken
- All quality gates approved

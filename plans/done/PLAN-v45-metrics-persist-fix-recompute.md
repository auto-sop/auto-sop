# PLAN-v45: Metrics Persist Fix + Force Recompute + Savings Formula Refinement

## Overview
The metrics pipeline computes session comparisons and token estimates correctly, but `saveMetricsState()` is tree-shaken from the learner bundle (`dist/plugin/learner.cjs`). The function uses `writeFileAtomic` (async), and the bundler strips it because the call site is wrapped in a bare `try/catch`. This means the server never receives updated per-project stats — the dashboard shows 0 tokens saved for 4 of 5 projects despite real data existing in sync-queue entries.

Additionally, `learn-now` with no new turns skips the entire metrics path (`turnData` only loads when `turns_new > 0`), making cursor-reset ineffective for forcing recomputation. And the byte-counted savings formula produces 0 when output bytes grow (even if input bytes and tool calls dropped significantly).

## Root Cause Analysis (VERIFIED)

### Bug 1: saveMetricsState tree-shaken from bundle
- `tsup.config.ts` learner entry has `treeshake: true` + `silent: true`
- `saveMetricsState()` in `src/metrics/state.ts` uses `writeFileAtomic()` from `src/atomic/index.ts`
- The call in `src/learner/main.ts:990` is inside `try { ... } catch { /* Non-blocking */ }`
- Tree-shaker sees: async function → only caller is in a catch-all try/catch → strips it
- `silent: true` suppresses the warning that would have flagged this
- **Proof**: `grep -c "state/metrics" dist/plugin/learner.cjs` = 0
- **Working code**: `appendSyncEntry` uses `appendFileSync` (sync, not async) → survives tree-shaking

### Bug 2: Metrics only compute when turns_new > 0
- `src/learner/main.ts:500`: `if (result.turns_new > 0)` gates `loadTurnsForDetection()`
- `turnData` stays empty when no new turns → `buildSessionSummaries(turnData)` never runs
- Session comparison + token estimate never recompute
- Cursor reset forces turns_new > 0, BUT the metrics persist (Bug 1) still fails

### Bug 3: Byte-counted savings formula produces false zeros
- `auto-sop-site` has 9 before / 70 after sessions, 49.9% fewer tool calls, 44% shorter sessions
- But `before_avg_tokens=19,809` vs `after_avg_tokens=20,816` (output bytes grew 59K→71K)
- Formula: `max(0, before - after)` = `max(0, -1007)` = 0
- The tool_call_heuristic method DOES show savings (4,680/session) for the same project
- Input bytes dropped 41% (19K→11K) — real savings masked by output growth

## Architecture Decisions
- **Fix tree-shaking**: Replace `writeFileAtomic` (async) with `writeFileSync` + temp-rename pattern (sync) in `saveMetricsState`. This matches `appendSyncEntry`'s approach that survives tree-shaking. Alternative: add `saveMetricsState` to tsup's `noExternal` or disable tree-shaking for the function — but making it sync is simpler and more robust.
- **Force recompute flag**: Add `--recompute` flag to `learn-now` that sets env var `AUTO_SOP_FORCE_RECOMPUTE=1`. When set, the learner loads ALL turns (not just new ones) and recomputes metrics even if `turns_new === 0`.
- **Hybrid savings formula**: Use the BETTER of byte-counted and tool-call-heuristic methods. If byte-counted yields 0 but tool-call reduction is >20%, fall back to tool_call_heuristic. Report `estimation_method: 'hybrid'` when fallback activates.

## Implementation Tasks

### Wave 1 (parallel — no dependencies between tasks)

#### Task 1: ARCHITECT — Fix saveMetricsState to survive tree-shaking
Files: `src/metrics/state.ts` (modify), `src/atomic/index.ts` (read-only reference)
Requirements:
- Replace the async `saveMetricsState` with a sync implementation using `writeFileSync` + `renameSync`
- Pattern to follow (same as appendSyncEntry's approach):
  ```typescript
  export function saveMetricsState(
    homeDir: string,
    projectRoot: string,
    state: MetricsState,
  ): void {
    const path = metricsStatePath(homeDir, projectRoot);
    const dir = join(homeDir, '.auto-sop', 'state', 'metrics');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
  }
  ```
- Update the caller in `src/learner/main.ts:990` — remove `await` (now sync)
- Keep the existing try/catch wrapper (non-blocking is correct)
- Verify: after `npm run build`, run `grep -c "state/metrics" dist/plugin/learner.cjs` — must be > 0
Acceptance: `saveMetricsState` present in `dist/plugin/learner.cjs` after build. Metrics state files update on every learner tick.

#### Task 2: ARCHITECT — Add --recompute flag to learn-now
Files: `src/cli/verbs/learn-now.ts` (modify), `src/cli/shared/learner-spawn.ts` (modify), `src/learner/main.ts` (modify)
Requirements:
- Add `--recompute` option to learn-now command (Commander option in learn-now.ts)
- In `learner-spawn.ts`: pass `AUTO_SOP_FORCE_RECOMPUTE=1` env var when `opts.recompute` is true
- In `src/learner/main.ts`: when `AUTO_SOP_FORCE_RECOMPUTE=1` is set:
  - Always load ALL turns via `loadTurnsForDetection()` regardless of `turns_new` count
  - Still respect `turns_new` for directive detection (don't re-detect already-known patterns)
  - But always run `buildSessionSummaries()` + `compareBeforeAfter()` + `estimateTokenSavings()` + `saveMetricsState()` on the full turn set
- Usage: `auto-sop learn-now --recompute`
Acceptance: Running `auto-sop learn-now --recompute` recomputes and persists metrics for all projects even when no new turns exist.

#### Task 3: ARCHITECT — Hybrid savings formula (byte-counted + tool-call fallback)
Files: `src/learner/session-metrics.ts` (modify)
Requirements:
- Modify `estimateTokenSavings()` to implement hybrid logic:
  1. First try `byte_counted` method (existing logic)
  2. If byte_counted yields `savings_per_session <= 0` AND `tool_calls_pct < -20` (20%+ reduction in tool calls), fall back to `tool_call_heuristic`
  3. When fallback activates, set `method: 'hybrid'` in the `TokenEstimate` return
- Update `TokenEstimate.method` type to include `'hybrid'` option
- Update `MetricsState.estimation_method` type to include `'hybrid'`
- The tool_call_heuristic formula: `savings_per_session = Math.round(before_avg_tool_calls * TOKENS_PER_CALL - after_avg_tool_calls * TOKENS_PER_CALL)` where `TOKENS_PER_CALL` is derived from byte data when available (avg bytes per tool call from before bucket)
- Ensure existing tests pass and add test for the hybrid fallback case
Acceptance: auto-sop-site (50% fewer tool calls but growing output bytes) shows non-zero token savings using hybrid method.

### Wave 2 (depends on Wave 1 — all 3 fixes must be in place)

#### Task 4: ARCHITECT — Rebuild, reinstall, and force recompute all projects
Files: `package.json` (version bump to 0.0.56), `dist/` (rebuild)
Requirements:
- Bump version to 0.0.56
- `npm run build` — verify `grep -c "state/metrics" dist/plugin/learner.cjs` > 0
- `npm link` (reinstall globally)
- Run `auto-sop learn-now --recompute` to force full metrics recomputation on all 5 projects
- Verify metrics state files updated:
  ```bash
  for f in ~/.auto-sop/state/metrics/*.json; do
    python3 -c "import json; d=json.load(open('$f')); print(f\"{d['project_slug']}: tokens={d['total_tokens_saved']}, method={d.get('estimation_method','?')}\")"
  done
  ```
- Expected: auto-sop shows ~820K+ tokens (byte_counted), auto-sop-site shows non-zero (hybrid), others show values based on available session data
Acceptance: All 5 projects have updated metrics state files with correct `last_computed_at` timestamps. At least 2 projects show non-zero `total_tokens_saved`.

### Wave 3 (depends on Wave 2 — verify server receives data)

#### Task 5: ARCHITECT — Trigger stats sync and verify server-side
Files: none (validation only)
Requirements:
- Delete `~/.auto-sop/.last-stats-sync` to reset the hourly throttle
- Run `auto-sop learn-now` — this triggers stats sync with fresh metrics
- Check server received the data: verify `asop_stats_summary` table has updated values for all 5 projects
- If launchd PATH issue blocks server sync (ioreg not found), run manually:
  ```bash
  auto-sop learn-now --recompute
  ```
  Then verify sync-queue has entries with token_estimate data
Acceptance: Stats sync fires successfully OR sync-queue contains correct metrics for next successful sync.

## Quality Gates (MANDATORY)
6. YODA: Code review — focus on: sync saveMetricsState approach, tree-shake survival, hybrid formula edge cases
7. APEX: Security review — metrics state file permissions (0600), no data leaks
8. ANALYZER: Code improvement review — must pass C or above

## Finalize
9. ARCHITECT: Commit with message "fix(v45): metrics persist survives tree-shake + recompute flag + hybrid savings formula"

## Acceptance Criteria
- `saveMetricsState` is present in `dist/plugin/learner.cjs` (verified by grep)
- Metrics state files (`~/.auto-sop/state/metrics/*.json`) update on every learner tick
- `auto-sop learn-now --recompute` forces full metrics recomputation without needing new turns
- auto-sop-site shows non-zero token savings (hybrid method accounts for tool-call reduction)
- Projects with insufficient session data (< 2 before or < 2 after) gracefully show 0 (not an error)
- All existing tests pass
- New test covers hybrid fallback scenario
- Version bumped to 0.0.56
- All quality gates approved

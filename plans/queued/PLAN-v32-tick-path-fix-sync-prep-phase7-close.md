# V32: Tick PATH Fix + Cloud Sync Prep + Phase 7 Close

## Overview
Close out Phase 7 (Metrics & Social Proof) with three deliverables:

1. **Permanent tick.sh PATH fix**: The installer generates tick.sh with a hardcoded minimal PATH that doesn't include `~/.local/bin` where `claude` lives. Every reinstall overwrites the manual fix. Make the installer detect the `claude` binary location at install time and bake it into tick.sh.

2. **Cloud sync prep**: Structure local stats into a `sync-queue.jsonl` file that Phase 8 (SaaS) can pick up and push to the cloud. Define the sync envelope schema. The learner tick appends a sync entry after each project processing. No network calls — just local file prep.

3. **M2 token estimation (heuristic)**: Claude Code hooks don't expose token counts, so true token tracking is blocked. Instead, estimate token savings using a heuristic: `tool_call_count × avg_tokens_per_call` (conservative multiplier). Compare before/after directive adoption. This gives a "~X tokens saved" number for the landing page — not exact, but defensible.

Also: verify M3 (errors prevented) is fully wired end-to-end (v31 integrated it into learner tick — confirm stats display works).

## Architecture Decisions

### tick.sh PATH Fix
- At install time, run `which claude` (or check common locations: `~/.local/bin/claude`, `/usr/local/bin/claude`, `~/.cargo/bin/claude`)
- If found, extract the directory and prepend it to the PATH line in tick.sh
- If not found, fall back to current behavior (no regression)
- Also prepend `$HOME/.local/bin` as a sensible default (most common Claude Code install location)
- Fix applies to both POSIX `renderTickScript` and Windows `renderTickScriptCmd`

### Cloud Sync Prep
- New file: `sync-queue.jsonl` in project state dir
- Each learner tick appends one `SyncEntry` per project (when there's anything to report)
- Schema:
  ```typescript
  interface SyncEntry {
    v: 1;
    t: string;                    // ISO timestamp
    project_id: string;
    project_slug: string;
    tick_id: string;
    directives_active: number;
    fires_total: number;
    fires_by_category: { error_preventing: number; efficiency: number; best_practice: number };
    errors_prevented_total: number;
    session_comparison: BeforeAfterComparison | null;
    token_estimate: TokenEstimate | null;
  }
  ```
- Phase 8 CLI `sync` module will: read entries → encrypt → POST to cloud → truncate file
- Compact after 30 days (local retention only — cloud has its own retention)
- Best-effort append — never abort the tick

### Token Estimation (Heuristic M2)
- No real token data available from hooks (Claude Code doesn't expose usage)
- Heuristic: estimate tokens per session using `tool_call_count` as proxy
  - Conservative multiplier: ~200 tokens per tool call (based on typical Claude Code patterns)
  - Before-directive sessions: avg tool calls × 200
  - After-directive sessions: avg tool calls × 200
  - Savings = before - after (only when positive)
- Display as "Est. Token Savings: ~X,XXX tokens/session (-Y%)"
- Clearly labeled as estimate in both CLI and JSON output
- This is a placeholder until Claude Code exposes real token counts

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Fix tick.sh PATH generation in installer
   Files: `src/scheduler/tick-wrapper.ts`, `src/installer/orchestrator.ts`, `test/scheduler/tick-wrapper.test.ts`
   Requirements:
   - Add `claudeBinDir?: string` to `TickScriptOpts` interface
   - In `renderTickScript`: if `claudeBinDir` is provided, prepend it to PATH. Always prepend `$HOME/.local/bin` as fallback.
     ```
     Before: export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
     After:  export PATH="/Users/x/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
     ```
   - In `renderTickScriptCmd`: similar — prepend `%USERPROFILE%\.local\bin` and claudeBinDir to PATH
   - In orchestrator.ts `install()`: detect claude binary location via `which claude` or checking common paths (`~/.local/bin/claude`, `/usr/local/bin/claude`). Extract dirname. Pass as `claudeBinDir` to `writeTickScript`.
   - If detection fails, still prepend `$HOME/.local/bin` as safe default
   - Tests: renderTickScript includes claude bin dir in PATH, renderTickScript without claudeBinDir still works (backward compat), orchestrator detects claude location
   Acceptance: After `npx auto-sop install`, tick.sh PATH includes the directory containing `claude`. Manual PATH fix no longer needed.

2. ARCHITECT: Create sync-queue module
   Files: `src/learner/sync-queue.ts`, `test/learner/sync-queue.test.ts`
   Requirements:
   - Define `SyncEntry` interface (see Architecture Decisions above)
   - Implement `appendSyncEntry(stateDir: string, entry: SyncEntry): void` — JSONL append, best-effort, never throws
   - Implement `readSyncEntries(stateDir: string): SyncEntry[]` — read + parse, skip malformed lines
   - Implement `compactSyncQueue(stateDir: string, maxAgeDays: number): number` — remove old entries, atomic rewrite (same pattern as error-prevention.ts)
   - Implement `buildSyncEntry(projectResult, stateDir): SyncEntry` — construct from per-project tick result + read fire/prevention/session data
   - Filename: `sync-queue.jsonl`
   - Tests: append + read roundtrip, compact removes old entries, malformed lines skipped, buildSyncEntry produces valid schema
   Acceptance: Sync queue module works. Phase 8 can import and consume it.

3. ARCHITECT: Add token estimation to session metrics
   Files: `src/learner/session-metrics.ts`, `test/learner/session-metrics.test.ts`
   Requirements:
   - Define `TokenEstimate` interface:
     ```typescript
     interface TokenEstimate {
       method: 'tool_call_heuristic';
       tokens_per_call: number;        // constant: 200
       before_avg_tokens: number;       // before.avg_tool_calls * 200
       after_avg_tokens: number;        // after.avg_tool_calls * 200
       savings_per_session: number;     // before - after (0 if negative)
       savings_pct: number;             // percentage
     }
     ```
   - Implement `estimateTokenSavings(comparison: BeforeAfterComparison): TokenEstimate | null`
     - Returns null if comparison is null or either bucket has 0 sessions
     - savings_per_session = max(0, before_avg - after_avg)
     - savings_pct = savings_per_session / before_avg * 100 (0 if before is 0)
   - Export `TOKENS_PER_CALL = 200` constant (documented as conservative estimate)
   - Tests: estimation math, null cases, negative savings returns 0
   Acceptance: Token estimation computable from session comparison data.

### Wave 2 (depends on Wave 1)

4. ARCHITECT: Integrate sync queue + token estimation into learner tick + stats
   Files: `src/learner/main.ts`, `src/cli/stats/aggregator.ts`, `src/cli/verbs/stats.ts`, `src/learner/recap-log.ts`
   Requirements:
   - In learner tick (after fire compaction + error prevention): call `buildSyncEntry()`, `appendSyncEntry()`, `compactSyncQueue(30 days)`. Wrap in try/catch.
   - Add `sync_entries_total` to recap fields
   - In stats aggregator: add `token_estimate: TokenEstimate | null` to `ProjectStats`. Compute from session comparison.
   - In stats CLI display, add token estimation section:
     ```
     Est. Token Savings:     ~1,400 tokens/session (-18%)
       Method: tool-call heuristic (200 tokens/call)
     ```
   - In `--json` output: include `token_estimate` and `sync_queue_size` fields
   - Handle gracefully: no session comparison data, no sync entries, zero tool calls
   Acceptance: Stats shows token estimation. Sync queue populated on each tick.

### Wave 3 (depends on Wave 2)

5. ARCHITECT: Integration tests + verify M3 end-to-end
   Files: `test/learner/sync-queue-integration.test.ts`, `test/cli/stats-display.test.ts`
   Requirements:
   - Sync queue integration: learner tick produces sync entry → readable → correct fields
   - Token estimation integration: stats aggregator includes token estimate from real session data
   - M3 verification: error prevention count appears in stats output (already wired in v31 — confirm with test)
   - Stats display test: verify CLI output format for all new fields (token estimate, sync queue size)
   - Backward compat: projects without sync-queue.jsonl still produce valid stats
   Acceptance: All new features verified end-to-end. Phase 7 metrics complete.

## Quality Gates (MANDATORY)
6. YODA: Code review — tick-wrapper PATH safety, sync queue schema design, token estimation honesty (clearly labeled as heuristic), backward compat
7. APEX: Security review — no secrets in sync queue entries, no raw commands in sync data, PATH injection safety in tick.sh
8. ANALYZER: Code improvement review — grade must be C or above

## Finalize
9. ARCHITECT: Commit with message: `feat(v32): tick.sh PATH fix + cloud sync prep + token estimation + Phase 7 close`

## Acceptance Criteria
- `npx auto-sop install` generates tick.sh with `claude` binary directory in PATH
- Reinstalling no longer breaks hourly cron LLM analysis
- `sync-queue.jsonl` populated by learner tick with per-project stats snapshot
- Sync entry schema ready for Phase 8 encrypted cloud push
- Token estimation (heuristic) shown in `auto-sop stats` output
- M3 (errors prevented) confirmed working end-to-end in stats
- `npm run build` succeeds
- All tests pass
- All quality gates approved (YODA + APEX + ANALYZER)

## What This Plan Does NOT Include
- Real token tracking (blocked — Claude Code hooks don't expose token counts)
- Network calls to cloud (Phase 8)
- Cloud dashboard (Phase 8)
- Landing page proof copy generation (Phase 8 — stats gathered now, displayed later)
- License key validation (Phase 8)

## What This Closes
- **Phase 7: Metrics & Social Proof** — all M-series items addressed:
  - M1: Directive-fire detection ✅ (v30)
  - M2: Token savings → heuristic estimate ✅ (v32, real tracking deferred)
  - M3: Errors prevented counter ✅ (v31 + v32 verification)
  - M6: `auto-sop stats` CLI ✅ (v30, enhanced v31+v32)
  - M4/M5: Landing page proof + dashboard widget → deferred to Phase 8/9

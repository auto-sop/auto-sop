# V30: Directive-Fire Detection + `auto-sop stats` CLI

## Overview
Add real-time directive-fire detection and a local stats CLI verb. When a user submits a prompt that matches an active CLAUDE.md directive, auto-sop records a "fire" event — proof that the directive was relevant and potentially prevented a mistake. The `auto-sop stats` CLI verb surfaces per-project metrics: directive fires, top-firing directives, errors prevented estimate, and time savings.

This is Milestone M1 (directive-fire detection) + M6 (`auto-sop stats` CLI) from Phase 7 (Metrics & Social Proof).

## Architecture Decisions

### Directive-Fire Detection (M1)
- **Detection point**: The capture writer's `UserPromptSubmit` handler — this is the earliest point where we have the user's prompt text AND access to the project's state directory
- **Matching strategy**: Heuristic keyword matching (v30). Extract significant keywords (3+ chars, non-stopword) from each active directive's `rule_text`, then check if the user's prompt contains N+ of those keywords. This is fast, zero-cost (no LLM call), and good enough for v30. LLM-based matching is a future optimization.
- **Matching threshold**: A directive "fires" when the prompt matches >= 40% of the directive's extracted keywords (minimum 2 keyword matches). This avoids false positives from single common words while catching genuine relevance.
- **Fire storage**: `<project>/.auto-sop/state/directive-fires.jsonl` — append-only JSONL, one line per fire event. Compacted during learner ticks (keep last 90 days).
- **Performance constraint**: The shim/writer hot path MUST stay fast. Directive matching runs synchronously in the writer process (already a detached grandchild), NOT in the shim itself. Reading directive-history.json is a single `readFileSync` — acceptable since the writer already does file I/O.
- **No false-positive amplification**: If no directives exist yet (fresh install), skip matching entirely. If directive-history.json is missing or empty, skip.

### Stats CLI (M6)
- **Verb**: `auto-sop stats [--project <path>] [--json] [--since <date>]`
- **Data sources**: `directive-fires.jsonl` (fire events), `directive-history.json` (active directives), `recap.log` (tick history for time range)
- **Metrics displayed**:
  - Total directive fires (all time / since date)
  - Fires per directive (top 5 table)
  - Active directives count
  - Estimated errors prevented (fires count — conservative 1:1 mapping)
  - Estimated time saved (fires * 15 min default — configurable)
- **Local only**: No network calls, no telemetry, no cloud. Pure file reads.

### What This Plan Does NOT Include
- LLM-based semantic matching (future — too expensive for hot path)
- Cloud metrics aggregation (Phase 8 SaaS)
- Badge/shield generation from stats (v31/v32)
- Cross-project aggregate stats (future)

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Create directive-fire detector module
   Files: `src/capture/writer/directive-fire.ts`, `test/capture/writer/directive-fire.test.ts`
   Requirements:
   - Define `DirectiveFire` interface:
     ```typescript
     interface DirectiveFire {
       t: string;              // ISO timestamp
       directive_id: string;   // matches DirectiveHistoryEntry.id
       session_id: string;     // from hook event
       project_id: string;     // from handler context
       keyword_hits: number;   // how many keywords matched
       keyword_total: number;  // total keywords in directive
       match_ratio: number;    // keyword_hits / keyword_total
     }
     ```
   - Implement `extractKeywords(ruleText: string): string[]` — extracts significant words from a directive's rule_text:
     - Lowercase, split on whitespace and punctuation
     - Filter: length >= 3, not in stopword set (common English: "the", "and", "for", "with", "that", "this", "from", "have", "been", "will", "should", "must", "when", "into", "also", "each", "other", "than", "them", "then", "only", "more", "some", "such", "make", "like", "just", "over", "your", "after", "before", "between", "does", "about", "being", "very", "could", "would", "these", "those", "every", "using", "used", "use", "not", etc.)
     - Deduplicate
     - Return sorted array of unique keywords
   - Implement `matchDirective(prompt: string, keywords: string[]): { hits: number; total: number; ratio: number } | null`
     - Lowercase the prompt, check which keywords appear in it
     - Return null if fewer than 2 hits OR ratio < 0.4
     - Return match stats otherwise
   - Implement `detectDirectiveFires(prompt: string, directives: Array<{ id: string; rule_text: string }>, sessionId: string, projectId: string): DirectiveFire[]`
     - For each directive, extract keywords, run matchDirective
     - Return array of DirectiveFire objects for all matches
     - If directives array is empty, return [] immediately (fast path)
   - Implement `appendFires(stateDir: string, fires: DirectiveFire[]): void`
     - Append fires as JSONL to `directive-fires.jsonl` in stateDir
     - Create file if it doesn't exist (mode 0o600)
     - Best-effort — never throw (same pattern as capture writer)
   - Implement `readFires(stateDir: string, since?: string): DirectiveFire[]`
     - Read JSONL, parse each line, skip malformed
     - If `since` provided (ISO string), filter to fires after that date
     - Return sorted by timestamp ascending
   - Implement `compactFires(stateDir: string, maxAgeDays: number): number`
     - Read all fires, remove those older than maxAgeDays
     - Atomic rewrite (tmp + rename)
     - Return count of removed entries
   - Tests: keyword extraction (various rule texts), matching with threshold, fire detection end-to-end, append/read round-trip, compaction, empty/missing file handling, stopword filtering, edge cases (very short rule_text, prompt with no matches).
   Acceptance: All tests pass. Directive-fire detection correctly identifies when prompts relate to active directives.

2. ARCHITECT: Create stats aggregation module
   Files: `src/cli/stats/aggregator.ts`, `test/cli/stats/aggregator.test.ts`
   Requirements:
   - Define `ProjectStats` interface:
     ```typescript
     interface ProjectStats {
       project_path: string;
       project_slug: string;
       period: { since: string; until: string };
       total_fires: number;
       unique_directives_fired: number;
       active_directives: number;
       fires_by_directive: Array<{
         directive_id: string;
         rule_text_preview: string;  // first 80 chars of rule_text
         fire_count: number;
         last_fired: string;
       }>;
       estimated_errors_prevented: number;  // = total_fires
       estimated_minutes_saved: number;     // = total_fires * minutes_per_error
       ticks_in_period: number;
     }
     ```
   - Implement `aggregateStats(opts: { stateDir: string; projectRoot: string; projectSlug: string; since?: string; minutesPerError?: number }): ProjectStats`
     - Read fires from `directive-fires.jsonl` (filtered by `since`)
     - Read directive history from `directive-history.json` for active directive count and rule_text lookup
     - Group fires by directive_id, sort by count descending
     - Calculate estimated metrics
     - Default `minutesPerError` = 15
   - Tests: aggregation with sample fire data, empty fires, missing history, since filter, correct sorting.
   Acceptance: Aggregator correctly computes stats from fire data. All tests pass.

### Wave 2 (depends on Wave 1 — uses fire detector + aggregator)

3. ARCHITECT: Integrate fire detection into capture writer
   Files: `src/capture/writer/routes/main-thread-route.ts`, `src/capture/writer/routes/pre-start-hooks.ts`
   Requirements:
   - In `handleUserPromptSubmit` (main-thread-route.ts), AFTER writing the prompt.md and BEFORE `setCurrentTurn`:
     1. Load active directives from `directive-history.json` — use `loadHistory(projectRoot)` from `directive-history.ts`
     2. Filter to non-pruned entries with non-empty rule_text
     3. Call `detectDirectiveFires(event.prompt, directives, event.session_id, ctx.projectId)`
     4. If fires detected, call `appendFires(ctx.paths.projectStateDir, fires)`
   - Wrap the entire fire detection block in try/catch — MUST NEVER crash the writer or slow it down noticeably. If anything fails, silently continue.
   - Performance: `loadHistory` is a single `readFileSync` + JSON.parse. With <= 25 directives (the cap), keyword extraction + matching is microseconds. This is acceptable for the writer process.
   - Do NOT modify the shim (main-core.ts) — all work happens in the writer process which is already a detached grandchild.
   - Add a kill-switch env var `AUTO_SOP_DISABLE_FIRE_DETECTION=1` to skip fire detection (useful for benchmarking or if it causes issues).
   Acceptance: When a user submits a prompt that matches an active directive, a fire event is appended to `directive-fires.jsonl`. Writer performance is not noticeably affected.

4. ARCHITECT: Add fire compaction to learner tick
   Files: `src/learner/main.ts`
   Requirements:
   - At the END of the per-project learner tick (after all detection and directive writing), call `compactFires(stateDir, 90)` to remove fires older than 90 days
   - Log the compaction count in a debug-level log if > 0
   - Add `directive_fires_new` and `directive_fires_total` fields to `PerProjectRecap` in `recap-log.ts`:
     - `directive_fires_new`: count of fires since last tick (read fires, filter by timestamp > cursor.last_finalized_at)
     - `directive_fires_total`: total fire count in the store
   - Wrap in try/catch — fire compaction failure must never abort the learner tick
   Acceptance: Fire log is compacted during learner ticks. Recap log includes fire metrics.

5. ARCHITECT: Create `auto-sop stats` CLI verb
   Files: `src/cli/verbs/stats.ts`, `src/cli/verbs/index.ts`
   Requirements:
   - New CLI command: `auto-sop stats [--project <path>] [--json] [--since <date>] [--minutes-per-error <N>]`
   - Default `--project`: current working directory (same pattern as other verbs)
   - Human-readable output format:
     ```
     auto-sop stats for: my-project
     Period: 2026-03-22 to 2026-04-21 (30 days)

     Directive Fires:        42
     Unique Directives Hit:   7 / 12 active
     Est. Errors Prevented:  42
     Est. Time Saved:        10.5 hours

     Top Firing Directives:
       1. [18 fires] Always use parameterized queries for datab...
       2. [12 fires] Never commit .env files or hardcoded secre...
       3. [ 8 fires] Use async/await instead of raw Promise cha...
       4. [ 3 fires] Always add error handling for file operati...
       5. [ 1 fire ] Check null before accessing nested propert...

     No fires yet? That's normal for new installs.
     Directives start firing after the learner detects patterns.
     ```
   - `--json` outputs `ProjectStats` as JSON
   - `--since` filters fires to after the given date (ISO or YYYY-MM-DD). Default: 30 days ago
   - `--minutes-per-error` overrides the default 15 minutes per error estimate
   - If no fires exist, show a friendly message explaining that fires appear after directives are active
   - If project is not installed (no .auto-sop/state/), show error and suggest `auto-sop install`
   - Register the verb in `verbs/index.ts` alongside existing verbs
   Acceptance: `auto-sop stats` displays fire metrics. `--json` outputs structured data. All flags work correctly.

### Wave 3 (depends on Wave 2 — needs integration working)

6. ARCHITECT: Integration tests for fire detection pipeline
   Files: `test/capture/writer/directive-fire-integration.test.ts`, `test/cli/stats/stats-verb.test.ts`
   Requirements:
   - Integration test: simulate a UserPromptSubmit event with a prompt matching an active directive → verify fire event appears in `directive-fires.jsonl`
   - Integration test: simulate 10 fire events over 3 sessions → run `aggregateStats` → verify correct counts, grouping, and estimated metrics
   - Integration test: fire compaction removes events older than 90 days, keeps recent ones
   - CLI test: mock fire data → run stats verb → verify human-readable output format
   - CLI test: `--json` flag produces valid JSON matching ProjectStats schema
   - CLI test: `--since` correctly filters fire events
   - Edge cases: no fires (fresh install), single fire, all directives pruned, very long rule_text truncation in preview
   Acceptance: All integration tests pass. Full pipeline from hook event → fire detection → storage → stats display verified.

## Quality Gates (MANDATORY)
7. YODA: Code review — fire detector design, keyword matching heuristic quality, writer integration safety (no crashes), aggregator correctness, CLI output formatting
8. APEX: Security review — no user prompt content leaked into fire events (only directive_id + keyword stats, NOT the prompt text), fire file permissions (0o600), no injection path from directives to prompt matching, stopword list completeness
9. ANALYZER: Code improvement review — grade must be C or above

## Finalize
10. ARCHITECT: Commit with message: `feat(v30): Directive-fire detection + auto-sop stats CLI verb`

## Acceptance Criteria
- Directive-fire events are recorded in `<project>/.auto-sop/state/directive-fires.jsonl` when user prompts match active directives
- Fire detection uses heuristic keyword matching (fast, no LLM cost)
- Fire detection runs in the capture writer process, never crashes or noticeably slows it
- `AUTO_SOP_DISABLE_FIRE_DETECTION=1` env var disables fire detection
- Fire log is compacted (90-day retention) during learner ticks
- `PerProjectRecap` includes `directive_fires_new` and `directive_fires_total` fields
- `auto-sop stats` CLI verb displays per-project fire metrics
- `auto-sop stats --json` outputs machine-readable ProjectStats
- `auto-sop stats --since 2026-04-01` filters by date
- User prompt text is NEVER stored in fire events (privacy — only directive_id and match ratio)
- Writer performance is not noticeably affected (all matching is synchronous keyword checks)
- All existing tests pass (updated as needed)
- `npm run build` succeeds
- All quality gates approved (YODA + APEX + ANALYZER)

## Migration / Backward Compatibility
- No migration needed — if `directive-fires.jsonl` doesn't exist, stats shows "no fires yet" message
- Existing capture writer behavior unchanged — fire detection is additive
- Existing learner behavior unchanged — compaction is additive
- New recap log fields are optional (existing recap entries deserialize unchanged)
- Fire detection gracefully handles missing directive-history.json (skips detection)

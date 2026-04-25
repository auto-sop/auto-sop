# V31: Fire Quality + Categorization + Session Metrics

## Overview
Make directive fires — our most competitive metric — more accurate and meaningful. Three improvements:

1. **Smarter fire detection**: Replace the keyword heuristic (40% threshold) with a two-tier system: fast keyword pre-filter + LLM-based semantic confirmation. Eliminates false positives where keyword overlap is coincidental ("run test" matching a directive about test suites when the user is talking about a different kind of test).

2. **Fire categorization**: Tag each fire by type — `error-preventing`, `efficiency`, `best-practice` — derived from the directive's severity and rule_text content. This lets stats show "12 errors prevented, 8 efficiency gains, 22 best practices applied" instead of just "42 fires."

3. **Session metrics**: Track per-session duration, tool call count, and bash failure count. Compute before/after comparison using the earliest directive's `first_seen` as the split point. These stats will eventually feed into the cloud dashboard.

Also keeps the bash error prevention tracker (commands that used to fail but now succeed post-directive) — dev-army agents make mistakes too, and when they do, this captures it.

## Architecture Decisions

### Two-Tier Fire Detection
- **Tier 1 (hot path — in writer process)**: Keep the current keyword heuristic as a fast pre-filter. If keywords don't match, skip. This runs synchronously in the capture writer (detached grandchild) — MUST stay fast.
- **Tier 2 (cold path — in learner tick)**: For fires that passed Tier 1, run LLM-based semantic confirmation during the hourly learner tick. The LLM sees the directive rule_text + a sanitized summary of the prompt context (NOT the raw prompt — privacy) and answers: "Is this directive genuinely relevant to what the user was doing?" Yes/No + confidence score.
- **Why two tiers**: Keyword matching catches ~80% of real fires but produces false positives. LLM confirmation is accurate but too slow/expensive for the hot path. The combo gives us accuracy without latency.
- **Fire states**: `pending` (passed keyword filter, awaiting LLM confirmation) → `confirmed` (LLM says yes) or `rejected` (LLM says no). Stats only count `confirmed` fires.
- **Fallback**: If LLM confirmation fails (timeout, error), the fire stays `pending` and counts as confirmed after 24 hours (generous fallback — better to over-count than lose data).
- **Cost control**: LLM confirmation only runs during learner ticks, batches all pending fires in one prompt, and only processes fires from the current tick (not re-confirming old ones).

**WAIT — on reflection, this is over-engineered for v31.** The LLM confirmation adds complexity, cost, and a new state machine. The keyword heuristic is working (wrbeautiful got 8 fires, 5 unique directives, reasonable match ratios 41-84%). Let me simplify:

### Revised: Improved Keyword Matching (no LLM tier)
- **Better keyword extraction**: Extract 2-grams (bigrams) alongside unigrams from rule_text. "shopify theme" as a bigram is much more specific than "shopify" and "theme" separately.
- **Weighted matching**: Bigram matches count 2x. Rare words (appearing in ≤2 directives) count more than common words (appearing in many directives). This is TF-IDF-lite.
- **Adjustable threshold**: Lower ratio threshold from 0.4 → 0.3 but require minimum 3 keyword hits (was 2). Catches more real fires while reducing noise from 2-keyword coincidences.
- **All runs in the writer process** — no LLM, no state machine, fast.

### Fire Categorization
- **Derived from directive severity**: `error` severity → `error-preventing` category, `warning` → `efficiency`, `info` → `best-practice`
- **Stored as new field on DirectiveFire**: `category: 'error-preventing' | 'efficiency' | 'best-practice'`
- **No LLM needed**: The learner already assigns severity when creating directives. Category is a direct mapping.

### Session Metrics
- **Computed by learner tick** (not real-time): Group turns by `session_id`, aggregate duration/tool-calls/bash-outcomes per session, store in `session-metrics.jsonl`.
- **Before/after split**: Use earliest directive `first_seen` as the cutoff. Sessions before = baseline, sessions after = with-directives.
- **Stored locally**: Will feed into cloud dashboard in Phase 8. For now, `auto-sop stats` displays them.

### Error Prevention Tracking (kept, lightweight)
- Extract `fingerprintCommand` to shared utility
- Add `source_fingerprint` to directive proposals from bash-failure detector
- Track when previously-failing commands succeed post-directive
- This stays as-is from the original v31 plan but is NOT the headline metric

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Improve fire detection with bigrams + weighted matching
   Files: `src/capture/writer/directive-fire.ts`, `test/capture/writer/directive-fire.test.ts`
   Requirements:
   - Add `extractBigrams(ruleText: string): string[]` — extract consecutive word pairs (lowercased, filtered). Example: "Always pull user-controlled files before dev work" → ["always pull", "pull user", "user controlled", "controlled files", "files before", "before dev", "dev work"]
   - Filter bigrams: remove pairs where both words are stopwords, keep minimum combined length ≥ 7 chars
   - Update `DirectiveFire` interface — add new fields:
     ```typescript
     category: 'error-preventing' | 'efficiency' | 'best-practice';
     bigram_hits: number;    // how many bigrams matched
     bigram_total: number;   // total bigrams in directive
     ```
   - Update `matchDirective` to use combined scoring:
     - Unigram hit = 1 point
     - Bigram hit = 2 points (bigrams are more specific, worth more)
     - Score = (unigram_points + bigram_points) / (unigram_total + bigram_total * 2)
     - Threshold: score ≥ 0.3 AND total hits ≥ 3 (unigrams + bigrams combined)
   - Update `detectDirectiveFires` to accept directive severity and populate `category`:
     - `error` severity → `error-preventing`
     - `warning` severity → `efficiency`
     - `info` severity → `best-practice`
   - Update `DirectiveInput` interface to include `severity`
   - Update all callers (main-thread-route.ts) to pass severity from directive history
   - Tests: bigram extraction, weighted scoring, category assignment, backward compat (old fires without category still readable), edge cases (very short rule_text, all stopwords).
   Acceptance: Fire detection is more accurate with bigram matching. All fires have a category. Existing tests updated.

2. ARCHITECT: Create session metrics module
   Files: `src/learner/session-metrics.ts`, `test/learner/session-metrics.test.ts`
   Requirements:
   - Define `SessionSummary` interface:
     ```typescript
     interface SessionSummary {
       session_id: string;
       started_at: string;        // earliest turn started_at
       ended_at: string;          // latest turn finalized_at
       duration_ms: number;       // ended_at - started_at
       turn_count: number;
       tool_call_count: number;   // sum across turns
       files_changed_count: number;
       bash_failure_count: number; // from tool-calls.jsonl post events
     }
     ```
   - Define `BeforeAfterComparison` interface:
     ```typescript
     interface BeforeAfterComparison {
       cutoff: string;            // ISO timestamp used as split point
       before: { sessions: number; avg_duration_min: number; avg_tool_calls: number; avg_bash_failures: number };
       after: { sessions: number; avg_duration_min: number; avg_tool_calls: number; avg_bash_failures: number };
       improvement: {
         duration_pct: number;     // negative = improvement (shorter sessions)
         tool_calls_pct: number;   // negative = improvement (fewer calls needed)
         bash_failures_pct: number; // negative = improvement (fewer failures)
       };
     }
     ```
   - Implement `buildSessionSummaries(turns: TurnData[]): SessionSummary[]`
     - Group turns by session_id
     - For bash failures: match pre/post by tool_use_id, check `success === false` on post events where pre event has `tool === 'Bash'`
     - Sort sessions by started_at ascending
   - Implement `compareBeforeAfter(sessions: SessionSummary[], cutoff: string): BeforeAfterComparison | null`
     - Split sessions using cutoff timestamp
     - Return null if either bucket has < 2 sessions (not enough data)
     - Calculate averages and percentage change
   - Tests: session grouping from turn data, bash failure counting via pre/post join, before/after split, percentage calculation, edge cases (single session, all before, all after).
   Acceptance: Session metrics correctly computed from turn data. Before/after comparison works.

3. ARCHITECT: Extract shared command fingerprinting
   Files: `src/learner/command-fingerprint.ts`, `src/learner/detectors/repeated-bash-failure.ts`, `test/learner/command-fingerprint.test.ts`
   Requirements:
   - Extract `fingerprintCommand(command: string): string` from `repeated-bash-failure.ts` to shared module
   - Extract `isBashFailure(call: ToolCall): boolean` to same module
   - Update `repeated-bash-failure.ts` to import from shared module (no behavior change)
   - Tests: fingerprint generation, isBashFailure edge cases
   Acceptance: Existing tests pass unchanged. Fingerprint logic reusable.

### Wave 2 (depends on Wave 1)

4. ARCHITECT: Add source fingerprint to bash-failure directive proposals
   Files: `src/learner/directive-schema.ts`, `src/learner/detectors/repeated-bash-failure.ts`, `src/managed-section/directive-history.ts`
   Requirements:
   - Add optional `source_fingerprint?: string` to `evidence` object in `DirectiveProposal` Zod schema
   - In `repeated-bash-failure.ts`, populate `evidence.source_fingerprint` with the command fingerprint
   - Add optional `source_fingerprint?: string` to `DirectiveHistoryEntry`
   - Propagate `source_fingerprint` from proposal to history entry on first insert in `applyDirectiveHistory`
   - All fields optional — fully backward compatible
   Acceptance: New bash-failure directives include `source_fingerprint`. Existing directives unaffected.

5. ARCHITECT: Create error prevention tracker + integrate into learner
   Files: `src/learner/error-prevention.ts`, `src/learner/main.ts`, `src/learner/recap-log.ts`, `test/learner/error-prevention.test.ts`
   Requirements:
   - Define `PreventedError` interface:
     ```typescript
     interface PreventedError {
       t: string;
       directive_id: string;
       source_fingerprint: string;
       session_id: string;
       command_preview: string;   // first 80 chars (privacy)
     }
     ```
   - Implement `detectPreventedErrors(turns: TurnData[], fingerprints: DirectiveFingerprint[]): PreventedError[]`
     - For each Bash post-event with `success === true`, fingerprint the command via pre-event
     - Match against known failure fingerprints from directive history
     - Only count if: turn timestamp > directive first_seen AND session not in directive evidence sessions
   - Implement append/read/compact for `error-prevention.jsonl` (same pattern as directive-fires)
   - Integrate into learner tick: after rule detectors, detect prevented errors, append, compact (90 days)
   - Add recap fields: `errors_prevented_new`, `errors_prevented_total`
   - Only run when `turnData.length > 0`
   - Wrap in try/catch — never abort the tick
   Acceptance: Prevented errors tracked when bash commands that used to fail now succeed post-directive.

6. ARCHITECT: Integrate session metrics into learner + enhance stats
   Files: `src/learner/main.ts`, `src/cli/stats/aggregator.ts`, `src/cli/verbs/stats.ts`
   Requirements:
   - In learner tick (when `turnData.length > 0`): call `buildSessionSummaries(turnData)`, pass to stats aggregator
   - Extend `ProjectStats` with:
     ```typescript
     fires_by_category: { error_preventing: number; efficiency: number; best_practice: number };
     real_errors_prevented: number;          // from error-prevention.jsonl
     session_comparison: BeforeAfterComparison | null;
     ```
   - Update stats aggregator to:
     - Group fires by `category` field (fallback to 'best-practice' for old fires without category)
     - Read `error-prevention.jsonl` for real prevention count
     - Build session summaries from captures dir, compute before/after
   - Update CLI display:
     ```
     auto-sop stats for: my-project
     Period: 2026-03-25 to 2026-04-24 (30 days)

     Directive Fires:          42
       Error-preventing:       12
       Efficiency:              8
       Best practice:          22
     Errors Prevented (real):   3
     Est. Time Saved:          10.5 hours

     Top Firing Directives:
       1. [18 fires] ⛔ Always use parameterized queries for datab...
       2. [12 fires] ⚠️  Never commit .env files or hardcoded secre...
       3. [ 8 fires] ℹ️  Use async/await instead of raw Promise cha...

     Session Comparison (before/after first directive):
       Avg. bash failures:  2.1 → 0.4 per session (-81%)
       Avg. tool calls:    45 → 38 per session (-16%)
       Avg. duration:      12 → 9 min (-25%)
     ```
   - `--json` outputs all new fields
   - Handle gracefully: no fires yet, no prevention data, no session data, single category only
   Acceptance: Stats shows categorized fires, real error prevention, and session comparison.

### Wave 3 (depends on Wave 2)

7. ARCHITECT: Integration tests + update existing tests
   Files: `test/learner/error-prevention-integration.test.ts`, `test/capture/writer/directive-fire.test.ts`
   Requirements:
   - Fire detection test: bigram matching improves accuracy vs. unigram-only
   - Fire categorization test: error/warning/info severity maps to correct category
   - Error prevention end-to-end: bash failure → directive with fingerprint → same command succeeds → PreventedError recorded
   - Session metrics test: before/after comparison from real turn data
   - Stats integration test: aggregator produces correct categorized counts
   - Backward compat: old fires without `category` or `bigram_hits` fields still parse and count correctly
   - All existing tests updated for new DirectiveFire fields
   Acceptance: All tests pass. Full pipeline verified.

## Quality Gates (MANDATORY)
8. YODA: Code review — bigram extraction quality, weighted scoring fairness, category mapping, session metrics math, fingerprint extraction safety, backward compat
9. APEX: Security review — no prompt text in fire events (PRIV-02 maintained), no raw command output in prevention events, file permissions, no injection from bigrams
10. ANALYZER: Code improvement review — grade must be C or above

## Finalize
11. ARCHITECT: Commit with message: `feat(v31): Fire categorization + bigram matching + session metrics + error prevention tracking`

## Acceptance Criteria
- Directive fires include `category` field (`error-preventing` / `efficiency` / `best-practice`)
- Fire detection uses bigram + unigram weighted scoring (more accurate than keyword-only)
- `auto-sop stats` shows fires broken down by category
- Session metrics computed: duration, tool calls, bash failures per session
- Before/after comparison shows improvement since first directive
- Bash error prevention tracked via `source_fingerprint` on failure-originated directives
- `error-prevention.jsonl` stores real prevented errors
- All new fields are optional — backward compatible with existing data
- `npm run build` succeeds
- All tests pass
- All quality gates approved (YODA + APEX + ANALYZER)

## What This Plan Does NOT Include
- LLM-based fire confirmation (considered, deferred — keyword+bigram is good enough for now)
- Token/cost tracking (Claude Code doesn't expose usage in hooks)
- Cloud sync of stats (Phase 8 SaaS)
- Landing page copy generation (Phase 8 — stats gathered now, displayed later)
- Cross-project aggregated stats

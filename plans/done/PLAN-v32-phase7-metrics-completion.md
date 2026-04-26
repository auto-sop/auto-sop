# PLAN-v32: Phase 7 Metrics Completion — Token/Time Savings + Errors Prevented

## Overview
Complete Phase 7 (Metrics & Social Proof) by implementing M2 (token/time savings tracker) and M3 (errors prevented counter). v30 shipped directive-fire detection, v31 shipped fire categorization + bigram matching. This plan closes the phase with measurable outcome numbers for the landing page.

## Project
**auto-sop** (CLI repo)

## Architecture Decisions
- Token data comes from Claude Code's response metadata (tool call counts, model usage) captured in `meta.json`
- "Errors prevented" = directive fired + same bash pattern that originally caused the directive did NOT fail in this session
- Stats stored in `~/.auto-sop/state/metrics.json` (per-project rollup)
- `auto-sop stats` CLI verb already exists (v30) — extend it with new metrics
- No cloud dependency — pure local metrics. Cloud sync format prep for Phase 8.

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Token usage extractor
   Files: src/metrics/token-extractor.ts, test/metrics/token-extractor.test.ts
   Requirements: Parse meta.json from captures to extract token counts (input_tokens, output_tokens). Calculate per-session totals. Compare sessions before a directive existed vs after for the same project. Store deltas in metrics state file.
   Acceptance: Unit tests pass. Given captures with meta.json containing token data, extractor produces correct before/after comparison.

2. ARCHITECT: Error prevention tracker
   Files: src/metrics/error-prevention.ts, test/metrics/error-prevention.test.ts
   Requirements: For each directive that originated from a bash-failure detector (evidence type = "repeated_bash_failure"), track subsequent sessions where the same command pattern appeared but did NOT fail. Count as "error prevented". Use the directive's source_capture_ids to find the original failure pattern. Store cumulative count in metrics state.
   Acceptance: Unit tests pass. Given a directive from bash failure "npm test" + subsequent captures where "npm test" succeeded, counter increments.

3. ARCHITECT: Time savings calculator
   Files: src/metrics/time-savings.ts, test/metrics/time-savings.test.ts
   Requirements: Estimate time saved by comparing session durations (from meta.json timestamps) for similar task types before/after directives. Use capture duration (first tool call → last tool call) as proxy. Conservative formula: time_saved = avg_before - avg_after, only when avg_after < avg_before. Store per-directive attribution.
   Acceptance: Unit tests pass. Calculator produces conservative, non-negative savings estimates.

### Wave 2 (depends on Wave 1)

4. ARCHITECT: Metrics aggregator + state persistence
   Files: src/metrics/aggregator.ts, src/metrics/state.ts, test/metrics/aggregator.test.ts
   Requirements: Combine token extractor, error prevention, and time savings into a single metrics pipeline. Run after each learner tick. Persist to `~/.auto-sop/state/metrics/{project-hash}.json`. Include: total_tokens_saved, total_errors_prevented, total_time_saved_minutes, per_directive_attribution[], last_computed_at. Atomic file writes (temp + rename).
   Acceptance: Integration test: feed sample captures → run aggregator → verify state file has correct totals.

5. ARCHITECT: Extend `auto-sop stats` verb
   Files: src/cli/commands/stats.ts
   Requirements: Add new sections to stats output: "Tokens saved: X (Y% reduction)", "Errors prevented: N this month", "Time saved: ~Xh Ym". Show per-project breakdown. Add `--json` flag for machine-readable output. Keep backward compatibility with existing stats output.
   Acceptance: `auto-sop stats` shows new metrics. `--json` produces valid JSON with all fields.

### Wave 3 (depends on Wave 2)

6. ARCHITECT: Cloud sync format prep
   Files: src/metrics/sync-format.ts, test/metrics/sync-format.test.ts
   Requirements: Create a serialization function that converts local metrics state into the format the cloud API will expect (for future Phase 8 sync). Include: project_slug, period (month), token_savings, errors_prevented, time_saved_minutes, directive_count. No actual sync — just format prep. Export for future use.
   Acceptance: Format function produces valid JSON matching cloud API schema. Tests verify all fields present.

7. ARCHITECT: Integration test — full metrics pipeline
   Files: test/metrics/integration.test.ts
   Requirements: End-to-end test: create sample captures with varying token counts and bash failures → run learner to generate directives → create post-directive captures → run metrics aggregator → verify stats output shows correct savings. Use test fixtures, not real Claude sessions.
   Acceptance: Integration test passes. Metrics are conservative (never over-claim).

## Quality Gates (MANDATORY)
8. YODA: Code review — all metrics code
9. APEX: Security review — no PII in metrics state files
10. ANALYZER: Code improvement review — must pass C or above

## Finalize
11. ARCHITECT: Commit all changes with message "feat(v32): token/time savings tracker + errors prevented counter"

## Acceptance Criteria
- `auto-sop stats` shows token savings, errors prevented, and time saved
- Metrics are conservative — never inflate numbers
- All state files are atomic-write safe
- No cloud calls — pure local computation
- All tests pass (100%)
- All quality gates approved
- Phase 7 can be marked COMPLETE after this plan

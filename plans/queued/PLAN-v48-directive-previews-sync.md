# PLAN-v48: Directive Previews Sync

## Overview
Add `directive_previews` to the stats-sync payload so the dashboard can display
a human-readable preview (first ~10 words) of each directive alongside its ID
and hit count. No full-content sync needed — just enough context to identify
what each directive does.

## Architecture Decisions
- Piggyback on existing stats-sync (POST /api/v1/stats) — no new endpoint needed
- Preview = first 10 words of `rule_text`, stripped of markdown formatting
- Map shape: `{ "sop-b4": "Never add comments that describe WHAT a function...", ... }`
- Sent alongside existing `directive_ids` and `confirmed_fires_by_directive`
- Stored in `asop_stats_summary` in a new `directive_previews` JSONB column

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Extract directive previews during learner tick
   Files: `src/learner/main.ts`, `src/learner/directive-builder.ts`
   Requirements:
   - Add a function `extractDirectivePreviews(proposals): Record<string, string>`
   - For each proposal, key = `shortDirectiveId(p.id)`, value = first 10 words of `p.rule_text` (strip markdown bold/brackets, truncate with `...`)
   - Call this in main.ts where `directive_ids` is already built, populate a `directive_previews` field
   - Add to MetricsState so it persists between ticks
   Acceptance: `directive_previews` map built with correct IDs and truncated text

2. ARCHITECT: Add `directive_previews` to stats-sync payload
   Files: `src/license/stats-sync.ts`, `src/metrics/state.ts`
   Requirements:
   - Add `directive_previews?: Record<string, string>` to `ProjectStats` interface
   - Add `directive_previews?: Record<string, string>` to MetricsState interface
   - Include in the `projects` payload sent to `/api/v1/stats`
   Acceptance: Stats sync request body includes `directive_previews` when available

3. ARCHITECT: Add `directive_previews` to stats CLI display
   Files: `src/cli/verbs/stats.ts`, `src/cli/stats/aggregator.ts`
   Requirements:
   - When showing per-project stats, list directives with preview + hit count
   - Format: `  sop-b4 (3 hits): Never add comments that describe WHAT a...`
   - Only show if `directive_previews` exists in metrics state
   Acceptance: `auto-sop stats` shows directive previews with hit counts

### Wave 2 (depends on Wave 1)

4. ARCHITECT: Write tests for preview extraction and sync
   Files: `test/learner/directive-previews.test.ts`, `test/license/stats-sync.test.ts`
   Requirements:
   - Test `extractDirectivePreviews` with various rule_text lengths
   - Test that previews are included in stats-sync payload structure
   - Test truncation at 10 words with `...` suffix
   - Test markdown stripping (bold markers, bracket tags)
   Acceptance: All tests pass, covers edge cases (empty, very long, special chars)

## Quality Gates (MANDATORY)
5. YODA: Code review — all implemented code
6. APEX: Security review — scan for data leakage (previews are just first 10 words, not secrets)
7. ANALYZER: Code improvement review — grade must be C or above

## Finalize
8. ARCHITECT: Commit all changes

## Acceptance Criteria
- `extractDirectivePreviews()` produces correct ID→preview map
- Stats-sync payload includes `directive_previews` field
- `auto-sop stats` displays directive previews with hit counts
- Previews are max 10 words, markdown-stripped, with `...` truncation
- All tests pass (100%)
- All quality gates approved

## Cross-repo Note
**v48 on auto-sop-site** (separate plan) must:
1. Accept `directive_previews` in the stats API
2. Store in `asop_stats_summary` (new JSONB column)
3. Display on directives page: ID | preview | hit count

# PLAN-v46: Directive Transparency — Self-Reported Fires

## Overview
Add directive IDs to the managed section in CLAUDE.md and inject a transparency instruction telling Claude Code to mention which directive it followed when executing. The capture shim then parses Claude's output for self-report markers, creating a new deterministic metric class: `method: 'self_reported'`. This replaces heuristic keyword-matching fire detection with the LLM explicitly saying "I followed directive X."

## Why This Matters
Current directive fire detection (`src/capture/writer/directive-fire.ts`) uses bigram+unigram weighted keyword scoring — heuristic, not provable. Token savings are estimated from before/after session comparisons — also heuristic. By having Claude self-report directive usage, we get:
1. **Deterministic proof** a directive influenced behavior
2. **Per-directive attribution** — which directives are actually useful
3. **Countable signal** — not "did tool calls drop?" but "Claude said it followed rule X, 47 times"
4. **User visibility** — real-time feedback that the plugin is working

## Architecture Decisions
- **Directive IDs in managed section**: Each bullet gets a short ID tag like `[sop:llm-inc-7ced]` (truncated hash, human-readable). Claude sees this and can reference it.
- **Transparency instruction**: Added as the FIRST item in the managed section, before all directives. Keep it concise — every token here is repeated in every conversation.
- **Self-report format**: `[sop:applied:<id>]` — a structured marker Claude includes in its response. Short enough to not annoy users, parseable by the capture writer.
- **Capture-side detection**: The writer scans Claude's output text for `[sop:applied:*]` patterns and logs them as confirmed fires in a new field `self_reported_fires[]` in the turn meta.
- **Metrics integration**: Self-reported fires feed into a new `confirmed_fires` counter in sync-queue entries, separate from heuristic `fires_total`.
- **Backward compatible**: Old captures without self-reports still work. The heuristic fire detection remains as fallback. Self-reported fires are additive.

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

#### Task 1: ARCHITECT — Add directive IDs to managed section rendering
Files: `src/learner/directive-builder.ts` (modify)
Requirements:
- Modify `formatProposalBullet()` to include a short directive ID tag
- Format: `- **[severity]** rule_text [sop:ID]` where ID is the first 8 chars of the directive hash
  - Example: `- **[warning]** Always use Grep instead of bash grep [sop:llm-7ced]`
- The ID must be stable (derived from `proposal.id`) so it doesn't change between ticks
- Extract the short ID: `p.id.replace('llm-inc-', 'llm-').slice(0, 8)` or similar — keep it short
- Don't change the evidence line format — ID goes at the end of the rule_text line
- Update golden-file tests if they exist (the rendered output will change)
Acceptance: Each directive bullet in CLAUDE.md includes a `[sop:XXXX]` ID tag.

#### Task 2: ARCHITECT — Add transparency instruction to managed section
Files: `src/learner/directive-builder.ts` (modify)
Requirements:
- In `buildDirectiveBodyFromInput()`, add a transparency instruction block BEFORE the learnings section
- The instruction text (keep concise — this goes in every CLAUDE.md):
  ```
  **Transparency**: When you follow a directive from this section, briefly note which one.
  Format: `[sop:applied:<id>]` — e.g., `[sop:applied:llm-7ced]`. One tag per directive applied.
  Do not force-apply directives — only tag when a directive genuinely influenced your action.
  ```
- This is inside the managed section markers so it gets auto-updated
- Only render this block when there are active directives (proposals.length > 0)
- Total added tokens should be under 60 words
Acceptance: CLAUDE.md managed section includes transparency instruction. Claude Code starts self-reporting directive usage.

#### Task 3: ARCHITECT — Capture writer parses self-reported fires
Files: `src/capture/writer/directive-fire.ts` (modify), `src/capture/writer/main.ts` (modify if needed)
Requirements:
- Add new function `detectSelfReportedFires(output: string): string[]`
  - Regex: `/\[sop:applied:([a-zA-Z0-9_-]+)\]/g`
  - Returns array of directive IDs that Claude self-reported
  - Deduplicate within a single turn (same directive reported twice = 1 fire)
- In the turn meta.json, add new field: `self_reported_fires: string[]` (array of directive IDs)
- This runs in the writer (post-event), parsing Claude's text output
- Keep existing heuristic `directive_fires` detection — self-reports are a separate field
- If no `[sop:applied:*]` markers found, `self_reported_fires` is empty array (not omitted)
Acceptance: Turn meta.json includes `self_reported_fires` field with parsed directive IDs from Claude's output.

### Wave 2 (depends on Wave 1)

#### Task 4: ARCHITECT — Sync-queue integration for self-reported fires
Files: `src/learner/main.ts` (modify), `src/learner/sync-entry.ts` or equivalent (modify)
Requirements:
- When building sync-queue entries, count self-reported fires from turn data:
  ```typescript
  confirmed_fires_total: number;          // sum of unique self-reported fires across all turns
  confirmed_fires_by_directive: Record<string, number>;  // per-directive count
  ```
- Add these fields to the sync-queue entry schema
- Self-reported fires are separate from heuristic `fires_total` — both coexist
- In MetricsState, add optional `confirmed_fires_total` field
Acceptance: Sync-queue entries include `confirmed_fires_total` and per-directive breakdown.

#### Task 5: ARCHITECT — Send confirmed fires + directive IDs to cloud via stats sync
Files: `src/license/stats-sync.ts` (modify), `src/metrics/state.ts` (modify)
Requirements:
- Extend `ProjectStats` interface with new optional fields:
  ```typescript
  export interface ProjectStats {
    project_slug: string;
    total_tokens_saved: number;
    total_errors_prevented: number;
    total_time_saved_minutes: number;
    directive_count: number;
    // NEW: self-reported fire data for cloud
    confirmed_fires_total?: number;
    confirmed_fires_by_directive?: Record<string, number>;
    directive_ids?: string[];           // list of active directive short IDs (e.g. ["llm-7ced", "llm-41ed"])
    estimation_method?: string;         // "byte_counted" | "tool_call_heuristic" | "hybrid"
  }
  ```
- In `src/learner/main.ts` where `allProjectStats` is built (line ~1027-1041), populate the new fields from MetricsState and sync-queue data:
  - `confirmed_fires_total` from MetricsState
  - `confirmed_fires_by_directive` from the latest sync-queue entry
  - `directive_ids` from the active proposals list (short IDs matching what's rendered in CLAUDE.md)
  - `estimation_method` from MetricsState
- The server receives these as part of the existing encrypted `projects` array — no new endpoint needed
- Fields are optional so old CLI versions without them still work (server ignores missing fields)
Acceptance: Stats sync payload includes confirmed fires and directive IDs. Server receives them in `projects_data` JSONB.

#### Task 6: ARCHITECT — Stats CLI shows self-reported fires
Files: `src/cli/verbs/stats.ts` (modify)
Requirements:
- `auto-sop stats` output includes a new section for self-reported fires when available:
  ```
  Confirmed directive hits (self-reported by Claude):
    llm-7ced  Always use Grep instead of bash grep    12 hits
    llm-41ed  Run build after third-party integration   8 hits
    ...
  ```
- Show "No self-reported fires yet" when `confirmed_fires_total` is 0
- Keep existing heuristic fire display — label it clearly as "Heuristic fires" vs "Confirmed fires"
Acceptance: `auto-sop stats` shows self-reported fire counts per directive.

## Quality Gates (MANDATORY)
7. YODA: Code review — managed section rendering, regex safety, capture writer changes, stats sync payload
8. APEX: Security review — ensure self-report parsing can't be exploited (regex DoS, injection via crafted output), no sensitive data in directive IDs
9. ANALYZER: Code improvement review — must pass C or above

## Finalize
10. ARCHITECT: Commit with message "feat(v46): directive transparency — self-reported fires + cloud sync via [sop:applied:ID] markers"

## Acceptance Criteria
- Each directive in CLAUDE.md managed section has a `[sop:XXXX]` ID tag
- Transparency instruction tells Claude to use `[sop:applied:ID]` format
- Capture writer detects and logs self-reported fires in turn meta.json
- Sync-queue entries include `confirmed_fires_total` separate from heuristic fires
- Stats sync payload includes `confirmed_fires_total`, `confirmed_fires_by_directive`, `directive_ids`, and `estimation_method`
- Server receives new fields in `projects_data` JSONB (no server-side schema change needed — JSONB is flexible)
- `auto-sop stats` displays confirmed fire counts per directive
- Existing heuristic fire detection unchanged (backward compatible)
- Old captures without self-reports work fine (empty `self_reported_fires` array)
- Old CLI versions without new fields still sync fine (fields are optional)
- Golden-file tests updated for new managed section format
- All quality gates approved

## Cross-Repo Note (auto-sop-site)
The server (`/api/v1/stats`) stores `projects_data` as JSONB, so new fields arrive automatically without schema changes. However, to DISPLAY confirmed fires and directive IDs in the dashboard, auto-sop-site needs a follow-up plan (v47-site) to:
1. Update `getDashboardData()` to extract `confirmed_fires_by_directive` and `directive_ids` from `asop_stats_log.projects_data`
2. Add a "Directive Hits" section to the project detail page showing per-directive confirmed fire counts
3. Optionally show directive IDs in the stats charts
This is a site-side plan — does NOT block v46 CLI-side delivery.

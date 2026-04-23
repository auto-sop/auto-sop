# V29: Incremental Pattern Memory — LLM Learns Across Ticks

## Overview
Replace the current single-shot LLM analysis (which tries to find cross-session patterns in one call and fails on large turn sets) with an **incremental pattern memory** system. Each tick, the LLM analyzes only the NEW turns and extracts pattern candidates. Candidates accumulate in a persistent store (`pattern-candidates.jsonl`) across ticks. When a candidate gathers evidence from 3+ distinct sessions, it automatically graduates to a directive proposal.

This solves three real problems observed in production:
1. **Context overflow**: 60+ turns crash/timeout `claude -p` — now each tick only sends ~1-5 new turns
2. **Session diversity**: Sampling N turns from one dominant session sees no cross-session patterns — now candidates accumulate naturally across ticks
3. **Wasted LLM calls**: Full-history replays that find nothing because the 3-session threshold can't be met in one pass — now the threshold is checked incrementally in code

## Architecture Decisions
- **Pattern candidates are stored per-project** at `<project>/.auto-sop/state/pattern-candidates.jsonl` — one JSON object per line, append-only with periodic compaction
- **The LLM prompt changes**: instead of "find patterns across all turns", it becomes "extract candidates from these new turns + update existing candidates if they match"
- **Graduation is code-level**: when a candidate accumulates `session_ids.length >= 3`, the learner main loop converts it to a `DirectiveProposalType` and feeds it to the existing merge pipeline — no LLM involvement in the graduation decision
- **The existing 3-session Zod schema constraint stays**: graduated candidates already have 3+ sessions, so they pass validation naturally
- **Rule-based detectors are unchanged**: they already work incrementally and see all turns
- **Backward compatible**: if `pattern-candidates.jsonl` doesn't exist, the system starts fresh (no migration needed)
- **Remove `sampleTurnsAcrossSessions`**: the session-diverse sampling function added in the timeout fix becomes unnecessary — we no longer need to sample old turns at all

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Create pattern candidate store
   Files: `src/learner/pattern-store.ts`, `test/learner/pattern-store.test.ts`
   Requirements:
   - Define `PatternCandidate` interface:
     ```typescript
     interface PatternCandidate {
       id: string;                    // deterministic hash of pattern text
       pattern: string;               // short description of the detected pattern
       severity: 'info' | 'warning' | 'error';
       rule_text: string;             // the actionable directive text (10-500 chars)
       session_ids: string[];         // distinct sessions where evidence was found
       turn_ids: string[];            // specific turns as evidence
       occurrence_count: number;      // total times pattern was observed
       first_seen: string;            // ISO timestamp of earliest evidence
       last_seen: string;             // ISO timestamp of latest evidence
       graduated: boolean;            // true once promoted to directive
       graduated_at?: string;         // ISO timestamp of graduation
     }
     ```
   - Implement `readCandidates(stateDir: string): PatternCandidate[]` — reads `pattern-candidates.jsonl`, returns parsed array. Returns empty array if file doesn't exist. Skips malformed lines (best-effort).
   - Implement `writeCandidates(stateDir: string, candidates: PatternCandidate[]): void` — atomic write (temp + rename) of all candidates as JSONL. This is a full rewrite (compaction) not append, keeping the file clean.
   - Implement `mergeCandidateEvidence(existing: PatternCandidate[], incoming: PatternCandidate[]): PatternCandidate[]` — matches by `id`, merges `session_ids` (union), `turn_ids` (union), updates `occurrence_count`, `last_seen`. New candidates are appended the list.
   - Implement `graduateCandidates(candidates: PatternCandidate[]): { graduated: DirectiveProposalType[]; updated: PatternCandidate[] }` — finds candidates where `session_ids` has 3+ distinct values AND `graduated === false`, converts them to `DirectiveProposalType`, marks them `graduated: true` with timestamp. Returns both the directive proposals and the updated candidate list.
   - Implement `pruneStaleCandidates(candidates: PatternCandidate[], maxAgeDays: number): PatternCandidate[]` — removes non-graduated candidates whose `last_seen` is older than `maxAgeDays` (default 30). Prevents unbounded growth of stale candidates that never graduate.
   - Candidate `id` generation: use `generateProposalId('llm-inc', pattern)` from existing `directive-schema.ts` — this makes ids deterministic and dedup-friendly with the existing merge pipeline.
   - Tests: read/write round-trip, merge with overlapping session_ids, graduation threshold, prune stale candidates, malformed line handling, empty file handling.
   Acceptance: All tests pass. Store correctly persists, merges, graduates, and prunes candidates.

2. ARCHITECT: Create incremental LLM prompt builder
   Files: `src/learner/llm-prompt-incremental.ts`, `test/learner/llm-prompt-incremental.test.ts`
   Requirements:
   - New function `buildIncrementalPrompt(serializedTurns: string, projectName: string, turnCount: number, existingCandidates: PatternCandidate[]): string`
   - The prompt instructs the LLM to:
     1. Analyze ONLY the provided turns (not historical data)
     2. Extract new pattern candidates (mistakes, inefficiencies, best practice violations)
     3. Check if any existing candidates (provided as compact JSON) match patterns in these turns — if so, note the match
     4. Return a JSON response with `new_candidates` and `matched_existing` arrays
   - Output schema for the LLM response:
     ```json
     {
       "new_candidates": [
         {
           "pattern": "brief description",
           "severity": "info|warning|error",
           "rule_text": "actionable instruction 10-500 chars",
           "turn_ids": ["turns where seen"],
           "occurrence_count": 2
         }
       ],
       "matched_existing": [
         {
           "candidate_id": "existing candidate id that was matched",
           "turn_ids": ["new turns that showed this pattern"],
           "additional_occurrences": 1
         }
       ],
       "summary": "1-2 sentence analysis"
     }
     ```
   - Include the same security notice about untrusted capture content (from current `llm-prompt.ts`)
   - Include the same rule_text constraints (10-500 chars, no raw captured text, actionable instructions)
   - Keep existing candidates compact in the prompt — only send `id`, `pattern`, `severity`, `session_ids` count (NOT full turn_ids or rule_text) to minimize token usage
   - Safety cap: same 200K char limit as current prompt
   - Do NOT require `session_ids` in the LLM output for new candidates — the learner knows which session these turns belong to and will populate `session_ids` from `meta.json`
   - Tests: prompt generation with empty candidates, with existing candidates, security notice present, output under char limit.
   Acceptance: Prompt builder generates valid, compact prompts. Tests pass.

### Wave 2 (depends on Wave 1 — uses new store + prompt)

3. ARCHITECT: Create incremental LLM response parser
   Files: `src/learner/llm-response-incremental.ts`, `test/learner/llm-response-incremental.test.ts`
   Requirements:
   - New function `parseIncrementalResponse(stdout: string, sessionId: string, turnData: TurnData[]): { newCandidates: PatternCandidate[]; matchedExisting: Array<{ candidateId: string; turnIds: string[]; additionalOccurrences: number }> }`
   - Handles the two-layer JSON unwrapping (same as current `llm-mode.ts` logic for claude CLI wrapper)
   - Strips markdown fences if present (same as current)
   - For `new_candidates`: populates `session_ids` from the current `sessionId` (the LLM doesn't need to know session IDs — we fill them in), generates deterministic `id` via `generateProposalId`, sets `first_seen`/`last_seen` from turn timestamps, `graduated: false`
   - For `matched_existing`: validates `candidate_id` exists (skip if not found), returns structured match data
   - Validates `rule_text` length (10-500) and `severity` enum — drops invalid entries silently (same pattern as current Zod safeParse)
   - Never throws — returns empty results on any parse failure (same pattern as current `runLlmAnalysis`)
   - Tests: valid response parsing, malformed JSON handling, missing fields, markdown fence stripping, session_id auto-population, invalid candidate_id in matched_existing.
   Acceptance: Parser correctly transforms LLM output into PatternCandidates. All tests pass.

4. ARCHITECT: Integrate incremental pipeline into learner main loop
   Files: `src/learner/main.ts`, `src/learner/llm-mode.ts`
   Requirements:
   - In `main.ts`, replace the current LLM analysis block (around lines 520-532) with the incremental pipeline:
     1. Read existing candidates: `readCandidates(stateDir)`
     2. Prune stale candidates: `pruneStaleCandidates(candidates, 30)`
     3. Build incremental prompt: `buildIncrementalPrompt(serializedTurns, project.slug, turnData.length, candidates)`
     4. Spawn `claude -p` with the prompt (same execa call as current `runLlmAnalysis`, same timeout, same env guards)
     5. Parse response: `parseIncrementalResponse(stdout, currentSessionId, turnData)`
     6. Merge new evidence into candidates: `mergeCandidateEvidence(candidates, newCandidates)` + apply matched_existing updates
     7. Graduate candidates with 3+ sessions: `graduateCandidates(candidates)`
     8. Write updated candidates back: `writeCandidates(stateDir, updatedCandidates)`
     9. Feed graduated directives into the existing merge pipeline (replaces `llmResult.proposals`)
   - Determine `currentSessionId`: extract from `turnData` — if multiple sessions in the batch, use all unique session_ids. For each new candidate, populate session_ids with ALL sessions present in the current turn batch.
   - Remove `sampleTurnsAcrossSessions` function — no longer needed. Send ALL new turns (from cursor) to the LLM, capped at `MAX_TURNS_FOR_LLM` (keep the constant, still useful as a safety valve, but now it's capping NEW turns per tick, which is typically small).
   - Keep `runLlmAnalysis` in `llm-mode.ts` but refactor it to accept the incremental prompt instead of building its own. OR create a new `runIncrementalLlmAnalysis` function that shares the spawn logic but uses the new prompt/parser.
   - Update recap log fields: add `llm_candidates_new`, `llm_candidates_matched`, `llm_candidates_graduated`, `llm_candidates_total` to the per-project recap entry. Keep existing fields (`llm_directives_proposed` etc.) working — graduated candidates count as proposed.
   - Error handling: if `claude -p` fails (timeout, exit code, parse error), the tick still proceeds with rule-based detectors only (same fallback as current). Existing candidates are NOT lost — they persist in the file untouched.
   - The `--offline` flag should skip the LLM call but still run graduation check on existing candidates (a candidate may have accumulated enough evidence from prior ticks' rule-based detectors to graduate).
   Acceptance: Full learner tick with incremental LLM works end-to-end. Candidates persist across ticks. Graduation produces valid DirectiveProposalType objects. Existing recap fields still work. Fallback on LLM failure preserves candidates.

### Wave 3 (depends on Wave 2 — needs integration working)

5. ARCHITECT: Add `candidates` CLI verb for inspection
   Files: `src/cli/verbs/candidates.ts`, `src/cli/main.ts` (register verb)
   Requirements:
   - New CLI command: `auto-sop candidates [--project <path>]`
   - Human output: table showing pattern candidates with columns: id (truncated), pattern, severity, sessions (count), occurrences, first_seen, last_seen, status (active/graduated/stale)
   - JSON output (`--json`): full candidate objects
   - `--prune` flag: manually trigger stale candidate pruning (removes candidates older than 30 days)
   - `--clear` flag: clear all candidates (fresh start)
   - Register the verb in CLI main alongside existing verbs
   Acceptance: `auto-sop candidates` shows candidate table. `--json` outputs full data. `--prune` and `--clear` work.

6. ARCHITECT: Update tests for modified learner main loop
   Files: `test/learner/main.test.ts`, `test/learner/llm-mode.test.ts`
   Requirements:
   - Update existing learner main tests to account for the incremental pipeline
   - Add integration test: simulate 3 ticks with turns from 3 different sessions, each containing the same mistake pattern. Verify that after tick 3, a directive is graduated and appears in the merge output.
   - Add test: LLM failure on tick 2 doesn't lose candidates from tick 1
   - Add test: `--offline` mode still graduates candidates that crossed the threshold
   - Add test: stale candidate pruning removes 30+ day old non-graduated candidates
   - Update any mocks that reference the old `runLlmAnalysis` signature if it changed
   Acceptance: All existing tests pass (or are updated to match new behavior). New integration tests pass.

## Quality Gates (MANDATORY)
7. YODA: Code review — pattern store design, incremental prompt security, merge logic correctness, backward compatibility
8. APEX: Security review — untrusted capture content isolation in new prompt, candidate store file permissions, no injection path from candidates to CLAUDE.md
9. ANALYZER: Code improvement review — grade must be C or above

## Finalize
10. ARCHITECT: Commit with message: `feat(v29): Incremental pattern memory — LLM accumulates candidates across ticks`

## Acceptance Criteria
- Pattern candidates persist in `<project>/.auto-sop/state/pattern-candidates.jsonl`
- Each tick only sends NEW turns to the LLM (not full history)
- LLM prompt includes compact summary of existing candidates for matching
- Candidates accumulate evidence across ticks until 3+ session threshold is met
- Graduated candidates become directive proposals via existing merge pipeline
- `auto-sop candidates` CLI verb shows current candidate state
- Stale candidates (30+ days without new evidence) are automatically pruned
- LLM failure on any tick doesn't lose existing candidates
- Existing rule-based detectors continue working unchanged
- All existing tests pass (updated as needed)
- `npm run build` succeeds
- All quality gates approved (YODA + APEX + ANALYZER)

## Migration / Backward Compatibility
- No migration needed — if `pattern-candidates.jsonl` doesn't exist, the system starts from scratch
- Existing directives in CLAUDE.md are untouched
- The `sampleTurnsAcrossSessions` function is removed (was added as a workaround in the timeout fix)
- `MAX_TURNS_FOR_LLM` constant stays but now caps new turns per tick (safety valve), not historical sampling
- The old `buildAnalysisPrompt` in `llm-prompt.ts` can be kept for reference or removed — ARCHITECT's choice

## What This Plan Does NOT Include
- Candidate sharing across projects (future — cross-project detection in Phase 10)
- Web dashboard visualization of candidates (future — Phase 7 SaaS)
- Candidate confidence scoring or weighted graduation (future optimization)
- LLM model selection or fallback to different models (existing behavior unchanged)

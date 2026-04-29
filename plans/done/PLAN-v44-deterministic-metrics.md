# PLAN-v44: Deterministic Metrics — Real Token Counting

## Overview
Replace the `TOKENS_PER_CALL = 200` magic number with real byte-counted token estimation. We already capture full tool call input/output in turn data — just need to sum actual bytes and convert to tokens (1 token ≈ 4 chars, industry standard). This makes "Tokens Saved" deterministic from real data instead of a heuristic multiplier.

## Root Cause
Current pipeline: `avg_tool_calls_before × 200 - avg_tool_calls_after × 200 = tokens_saved`
- The `200` is a hardcoded guess
- Two tool calls with wildly different sizes (e.g., `Read` a 5KB file vs `Grep` returning 2 lines) are counted the same
- Result: ±50% error margin on "Tokens Saved"

## What We Already Have (no new capture needed)
- `PreToolLine.input`: full JSON of tool input (or `input_ref` + `bytes` if offloaded)
- `PostToolLine.output`: full JSON of tool response (or `output_ref` + `bytes` if offloaded)
- `TurnData.tool_calls[]`: loaded by `turn-loader.ts` with input/output intact
- `SessionSummary.tool_call_count`: already counted per session

## Architecture Decisions
- **Count real bytes per tool call** during session summary computation
- **Add `total_input_bytes` and `total_output_bytes` to `SessionSummary`**
- **Convert bytes → tokens** using `Math.ceil(bytes / 4)` (1 token ≈ 4 chars, conservative)
- **New `TokenEstimate.method: 'byte_counted'`** — distinct from legacy `tool_call_heuristic`
- **Keep the heuristic as fallback** for sessions that predate byte counting (old turn data without input/output)
- **Backward compatible**: old MetricsState files still valid, just less accurate

## Implementation Tasks

### Wave 1 (core metric change)

#### Task 1: ARCHITECT — Add byte counting to session summaries
Files: `src/learner/session-metrics.ts` (modify), `test/learner/session-metrics.test.ts` (modify)
Requirements:
- Add two fields to `SessionSummary`:
  ```typescript
  total_input_bytes: number;   // sum of JSON.stringify(input).length for all pre events
  total_output_bytes: number;  // sum of JSON.stringify(output).length or bytes for all post events
  ```
- In `buildSessionSummaries()`, for each tool call:
  - Pre event: `total_input_bytes += input ? JSON.stringify(input).length : 0`
  - Pre event with offloaded input: `total_input_bytes += bytes ?? 0` (from `input_ref` path)
  - Post event: `total_output_bytes += output ? JSON.stringify(output).length : 0`
  - Post event with offloaded output: `total_output_bytes += bytes ?? 0`
- Add new constant: `export const CHARS_PER_TOKEN = 4;`
- Update tests to verify byte counting with known input/output sizes
Acceptance: SessionSummary includes real byte counts. Existing tests still pass.

#### Task 2: ARCHITECT — New byte-based token estimation
Files: `src/learner/session-metrics.ts` (modify), `src/metrics/token-extractor.ts` (modify)
Requirements:
- Add new `TokenEstimate.method` value: `'byte_counted'`
- New function `estimateTokenSavingsByBytes(comparison: BeforeAfterComparison): TokenEstimate | null`:
  ```typescript
  // Uses real bytes instead of TOKENS_PER_CALL multiplier
  const beforeAvgTokens = Math.ceil(
    (comparison.before.avg_input_bytes + comparison.before.avg_output_bytes) / CHARS_PER_TOKEN
  );
  const afterAvgTokens = Math.ceil(
    (comparison.after.avg_input_bytes + comparison.after.avg_output_bytes) / CHARS_PER_TOKEN
  );
  ```
- Add `avg_input_bytes` and `avg_output_bytes` to `BucketStats` interface
- Update `computeBucketStats()` to compute average bytes from session summaries
- Update `estimateTokenSavings()` to prefer `byte_counted` when byte data is available, fall back to `tool_call_heuristic` when sessions have 0 bytes (old data)
- Tests: verify byte-counted estimation produces different (more accurate) results than heuristic
Acceptance: Token estimation uses real byte counts when available.

#### Task 3: ARCHITECT — Update MetricsState to use new estimation
Files: `src/learner/main.ts` (modify), `src/metrics/state.ts` (modify)
Requirements:
- In the MetricsState persist block (line ~965 area), use the new byte-counted token estimate when available
- Add `estimation_method: 'byte_counted' | 'tool_call_heuristic'` field to MetricsState (optional, for transparency)
- Ensure the stats sync payload still sends the same fields (total_tokens_saved etc.) — server doesn't need to know the method
- Log which method was used in recap for debugging
Acceptance: MetricsState files show `estimation_method: 'byte_counted'` for new syncs.

### Wave 2 (transparency)

#### Task 4: ARCHITECT — Mark heuristic vs deterministic in CLI stats output
Files: `src/cli/stats.ts` or equivalent stats display
Requirements:
- When displaying `auto-sop stats`, add a note next to each metric:
  - Tokens Saved: show value + "(measured)" or "(estimated)" based on method
  - Errors Prevented: always show "(correlation-based)"
  - Directive Fires: always show "(keyword match)"
- This builds user trust through honesty about measurement quality
Acceptance: `auto-sop stats` output clearly labels measurement method per metric.

## Quality Gates (MANDATORY)
5. YODA: Code review — verify byte counting logic, no double-counting
6. APEX: Security review — no raw input/output content leaks into metrics
7. ANALYZER: Code improvement review — must pass C or above

## Finalize
8. ARCHITECT: Commit with message "feat(v44): deterministic token counting — real bytes replace 200/call heuristic"

## Acceptance Criteria
- SessionSummary includes `total_input_bytes` and `total_output_bytes`
- Token estimation uses `byte_counted` method for sessions with byte data
- Falls back to `tool_call_heuristic` for old sessions (backward compat)
- MetricsState includes `estimation_method` field
- `auto-sop stats` labels each metric's measurement quality
- Stats sync payload unchanged (server receives same fields)
- All existing tests pass + new tests for byte counting
- All quality gates approved

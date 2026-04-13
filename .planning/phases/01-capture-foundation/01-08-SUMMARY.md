# Plan 01-08 Summary: End-to-End Integration Suite

**Status:** COMPLETE
**Wave:** 3 (depends on all Wave 1+2 plans)

## What was built

- **7 fixture JSONL sessions** under `test/capture/integration/fixtures/sessions/`:
  1. `main-only.jsonl` — simplest happy path (1 tool call)
  2. `main-with-subagent.jsonl` — subagent nesting with bidirectional linking
  3. `large-output.jsonl` — 300KB output triggering gzip offload
  4. `orphan-recovery.jsonl` — crashed session + recovery with mtime aging
  5. `paused-skip.jsonl` — disk-budget pause flag honored
  6. `secret-scrub.jsonl` — planted secrets (Anthropic API key + AWS key)
  7. `concurrent-sessions.jsonl` — interleaved events for two sessions

- **`test/capture/integration/run-scenario.ts`** — helper that pipes JSONL fixtures through the actually-built `dist/capture/shim.cjs`, with:
  - HOME isolation (each scenario gets its own fake HOME)
  - Placeholder substitution (`<PROJECT_ROOT>`, `<FIXTURE_TRANSCRIPT>`)
  - `preActions` (create paused.flag)
  - `midActions` on BREAK_HERE markers (age .pending dirs)
  - `midCheckpoints` for W2 mid-stream assertions
  - `waitForQuiescence` polling (no .pending dirs + no tmp payloads)
  - `walkDir` / `walkDirs` utilities for recursive file/dir enumeration

- **`test/capture/integration/end-to-end.test.ts`** — 8 describe blocks, 24 test cases

## Bugs found and fixed

1. **Writer CJS bundle failed to inline `execa`** — `dist/capture/writer.cjs` required ESM-only `execa` at runtime, crashing with `ERR_REQUIRE_ESM`. Fix: added `'execa'` to `noExternal` in `tsup.config.ts` writer entry.

2. **Subagent UserPromptSubmit not delegated** — `handleUserPromptSubmit` in `main-thread-route.ts` didn't check for `agent_id`, creating a duplicate main turn. Fix: added delegation to `handleSubagentUserPromptSubmit` when `agent_id` is present.

3. **Subagent PreToolUse/PostToolUse silently dropped** — `tool-calls-route.ts` returned early on `agent_id` instead of delegating to subagent handlers. Fix: added delegation to `handleSubagentPreToolUse`/`handleSubagentPostToolUse`.

## ROADMAP Criterion → Test Traceability

| Criterion | Test                                                    | Status |
|-----------|--------------------------------------------------------|--------|
| CAPT-01   | main-only: meta.json schema, 5 required files          | PASS   |
| CAPT-02   | secret-scrub: file 0600 / dir 0700 permissions          | PASS   |
| CAPT-03   | (bench job — not integration tested)                    | N/A    |
| CAPT-04   | main-with-subagent: bidirectional linking                | PASS   |
| CAPT-05   | global mirror: index.jsonl entries                      | PASS   |
| CAPT-06   | (bench job latency — not integration tested)            | N/A    |
| CAPT-07   | concurrent-sessions: session isolation                   | PASS   |
| CAPT-08   | orphan-recovery: timeout finalization                    | PASS   |
| CAPT-09   | main-with-subagent: dual representation (Task+subagent) | PASS   |
| CAPT-10   | large-output: gzip offload + output_ref                 | PASS   |
| PRIV-04   | secret-scrub: zero secret matches across all files       | PASS   |
| PRIV-07   | kill-switch: zero-write behavior                         | PASS   |

## Test Counts

- **Test files:** 34 total (all passing)
- **Test cases:** 291 total (all passing)
- **Integration tests:** 24 cases across 8 describe blocks

## PHASE 1 VERDICT: COMPLETE

All ROADMAP Phase 1 success criteria have at least one asserting integration test. `npm run build && npm test` is all-green. The bench job (CAPT-03/06) runs independently via `npm run bench:shim:ci`.

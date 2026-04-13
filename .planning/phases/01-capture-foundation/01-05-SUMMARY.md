# 01-05 Summary: Errors + Disk Budget

## Files Created/Modified

| File | Action | Purpose |
|------|--------|---------|
| `src/capture/writer/errors.ts` | **OVERWRITTEN** (replaced stub) | `logError()`, `initErrorWriter()`, `getErrorWriter()` — dual errors.jsonl writer with 10MB/.1 rotation |
| `src/capture/writer/disk-budget.ts` | **CREATED** | `isPaused()`, `computeUsedBytes()`, `enforceDiskBudget()` — 50% cap auto-pause via `paused.flag` |
| `src/capture/writer/routes/pre-start-hooks.ts` | **MODIFIED** | Registered disk-budget hook — checks pause on every event, runs full budget on UserPromptSubmit |
| `test/capture/writer/errors.test.ts` | **CREATED** | 10 tests covering logError, rotation, cross-path survival, initErrorWriter |
| `test/capture/writer/disk-budget.test.ts` | **CREATED** | 12 tests covering isPaused, computeUsedBytes, enforceDiskBudget thresholds |

## Error Kinds (`kind:` values for Phase 2 doctor/errors CLI)

| Kind | Emitted By | Description |
|------|-----------|-------------|
| `zod_parse_failed` | main.ts (01-03) | Hook payload failed Zod parse |
| `scrub_failed` | handlers (01-03) | Scrubber threw during content sanitization |
| `rename_failed` | turn-dir.ts (01-03) | Atomic .pending → final rename failed |
| `git_diff_failed` | files-changed.ts (01-03) | Git diff for files-changed.txt failed |
| `writer_uncaught` | main.ts (01-03) | Top-level catch in writer process |
| `paused_skipped` | pre-start-hooks.ts (01-05) | Writer invocation skipped due to paused.flag |

## Pause Semantics

- **paused.flag** is written when captures dir reaches 50% of cap (default 1GB of 2GB)
- Flag contains JSON: `{ at, used, cap, threshold }`
- Writer checks pause on EVERY event; logs `paused_skipped` once per invocation
- Non-UserPromptSubmit events abort silently when paused (no log spam)
- **Resume**: `paused.flag` must be cleared manually until Phase 2 ships `claude-sop resume`

## Design Decisions

- **No main.ts edits**: `initErrorWriter()` stores a module-level ref via `getErrorWriter()` — pre-start hook imports it directly
- **Single .1 backup**: simpler than ring-of-N, per CONTEXT.md discretion
- **No file locking**: errors are low-frequency single-line appends (safe under PIPE_BUF)
- **computeUsedBytes includes yarim-kalan/**: disk cares about total physical usage

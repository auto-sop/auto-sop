---
phase: 02-installer-scheduler-cli
plan: 08
status: complete
files_created:
  - src/cli/verbs/pause.ts
  - src/cli/verbs/resume.ts
  - src/cli/verbs/errors.ts
  - test/cli/verbs/pause-resume.test.ts
  - test/cli/verbs/errors.test.ts
files_modified:
  - src/cli/verbs/index.ts
tests_added: 17
tests_total: 491
---

# Plan 02-08 Summary: pause / resume / errors verbs

## What was built

Three CLI verbs registered via the barrel pattern in `src/cli/verbs/index.ts`:

### pause verb (`src/cli/verbs/pause.ts`)
- Creates `<project>/.claude-sop/paused.flag` with `{ paused_at: <timestamp> }` content
- Idempotent: re-running overwrites flag without error
- Creates `.claude-sop/` directory if missing
- Supports `--json` and `--project` flags

### resume verb (`src/cli/verbs/resume.ts`)
- Removes `paused.flag`; no-op if already absent
- `--json` mode shows `removed: true/false`
- Supports `--project` flag

### errors verb (`src/cli/verbs/errors.ts`)
- Tails `<project>/.claude-sop/errors.jsonl`
- `--tail N` (default 20) limits to last N entries
- `--since <duration>` filters by timestamp (supports ms/s/m/h/d units)
- Skips malformed JSON lines silently
- Missing file treated as empty (no errors)
- Supports `--json` mode

## Barrel registration
- 3 import lines + 3 register lines added to `src/cli/verbs/index.ts`
- Both `@@VERBS_IMPORTS@@` and `@@VERBS_REGISTER@@` sentinels retained
- `src/cli/main.ts` untouched (frozen)

## Verification
- tsc --noEmit: clean
- 17 new tests across 2 test files, all passing
- Full suite: 491 tests, 63 files, all green

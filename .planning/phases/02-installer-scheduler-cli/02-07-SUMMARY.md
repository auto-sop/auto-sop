---
phase: 02-installer-scheduler-cli
plan: "07"
status: complete
---

# 02-07 Summary: status + doctor verbs

## What was built

### src/status/collector.ts
- `collectStatus(opts)` returns a stable `StatusReport` covering all I3 fields:
  - project id/slug/path
  - hook wiring state (present/absent/stale)
  - scheduler state (pass-through from backend)
  - last learner run (null in Phase 2, placeholder for Phase 3)
  - pending capture count
  - directive count (from CLAUDE.md managed section)
  - license state (via Phase 0 trial module)
  - last-24h error count (from errors.jsonl)
  - disk usage (recursive walk of captures dir)
  - paused flag
- All missing files/dirs produce safe defaults (0 / null / false), never errors.

### src/cli/verbs/status.ts
- `registerStatusVerb` registers `status` command on Commander program.
- Human output: colorized table via picocolors with all I3 fields.
- JSON output: `{ ok: true, verb: 'status', ...report }` via `--json` global flag.

### src/cli/verbs/doctor.ts
- `registerDoctorVerb` registers `doctor` command.
- Runs 9 health checks: installed, hooks wired, scheduler registered, managed section, license configured, license not expired, disk usage, not paused, scrubber rules loadable.
- Throws `PreconditionError` (exit 3) if any check fails.
- JSON mode: `{ ok: boolean, verb: 'doctor', checks: Check[] }`.

### src/cli/verbs/index.ts (barrel)
- Added TWO import lines at `@@VERBS_IMPORTS@@` sentinel.
- Added TWO register calls at `@@VERBS_REGISTER@@` sentinel.
- Sentinels retained.

## Tests added
- `test/status/collector.test.ts` — 11 tests: fresh defaults, fully installed, stale hooks, paused flag, directive count, errors.jsonl mixed timestamps, disk usage, expired license, scheduler passthrough, no scheduler, pending captures.
- `test/cli/verbs/status.test.ts` — 4 tests: human labels, JSON schema, stale display, not-installed display.
- `test/cli/verbs/doctor.test.ts` — 8 tests: all-pass exit 0, fail exit 3, JSON ok:false, JSON ok:true, paused fail, expired license fail, scrubber check, multiple failures.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 474 tests pass, 0 fail.
- `src/cli/main.ts` — untouched (frozen).
- Sentinels retained in barrel.

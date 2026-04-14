---
phase: 02-installer-scheduler-cli
plan: 01
status: complete
---

# Plan 02-01 Summary: Deps + Atomic Write + CLI Skeleton

## What was done

### Task 1: Dependencies, Atomic Write, Exit Codes
- Installed `picocolors@^1.1.1`, `jsonc-parser@^3.3.1`, `semver@^7.6.3` + `@types/semver` devDep
- Created `src/atomic/write.ts` — `writeFileAtomic(path, content)` using same-directory tmp + fsync + rename (EXDEV-safe)
- Created `src/atomic/index.ts` — barrel re-export
- Created `src/cli/exit-codes.ts` — `ExitCode` const enum: SUCCESS=0, GENERIC_FAILURE=1, MISUSE=2, PRECONDITION_FAILED=3
- Created `src/cli/errors.ts` — `PreconditionError` class with optional `hint`
- Created `test/atomic/write.test.ts` — 6 tests: write+read, parent creation, overwrite, concurrency, 1 MiB round-trip, file mode 0o600

### Task 2: CLI Skeleton
- Created `src/cli/prompt.ts` — `promptLicense()` using `node:readline/promises`, `classifyLicense()` (dev vs user)
- Created `src/cli/output/human.ts` — `renderTable()`, `warn()`, `error()` using picocolors
- Created `src/cli/output/json.ts` — `emit()`, `emitError()` stable JSON emitters
- Created `src/cli/verbs/index.ts` — barrel with `@@VERBS_IMPORTS@@` and `@@VERBS_REGISTER@@` sentinels
- Created `src/cli/main.ts` — Commander root with `--json` flag, `exitOverride()`, exit code mapper. **FROZEN after this plan.**
- Updated `src/cli.ts` — wired to `runCli()` from `src/cli/main.ts`
- Created `test/cli/prompt.test.ts` — 5 tests: default key, trim, exact input, classifyLicense
- Created `test/cli/main.test.ts` — 4 tests: --version, --help, unknown verb → exit 2, --json + unknown verb → JSON error

## Key design decisions
- `readPkgVersion()` handles both ESM (`import.meta.url`) and CJS (`__dirname`) for tsup dual build
- No `flock` anywhere — all locking deferred to proper-lockfile in Node (per spec)
- Wave 2 plans add verbs by inserting ONE import line + ONE register call at sentinel comments

## Verification
- `npm run typecheck` — clean
- `npm test` — 306 tests passing (37 test files)
- `npm run build` — produces `dist/cli.cjs`
- `node dist/cli.cjs --version` → prints `0.0.0`, exits 0
- `node dist/cli.cjs --help` → prints help, exits 0
- `node dist/cli.cjs nosuchverb` → exits 2 (MISUSE)
- Sentinels `@@VERBS_IMPORTS@@` and `@@VERBS_REGISTER@@` present in verbs barrel
- `FROZEN after plan 02-01` header present in main.ts

---
phase: 02-installer-scheduler-cli
plan: 05
status: complete
---

# 02-05 Summary: Install Verb + Plugin Bundle Copier

## What was built

### Source files
- **`src/installer/plugin-bundle.ts`** — `copyPluginBundle(src, dst)`: validates source is a directory, destructive rm + recursive `fs.cp`.
- **`src/installer/orchestrator.ts`** — `runInstall(opts)`: 9-step orchestrator composing all Wave 1 libraries. Steps: (0) lock via proper-lockfile, (1) preflight platform/Node check, (2) version compare with downgrade refusal, (3) license prompt/classify + recordLicenseOnInstall, (4) copyPluginBundle, (5) mergeGlobalMarketplace, (6) mergeProjectHooks, (7) writeTickScript + scheduler backend.install, (8) ensureManagedSection + ensureGitignore, (9) writeInstalledVersion LAST.
- **`src/cli/verbs/install.ts`** — `registerInstallVerb(program)`: Commander verb wiring `--license`, `--project` flags → `runInstall()` → human/JSON output.
- **`src/cli/verbs/index.ts`** — Added ONE import + ONE register call at sentinel markers (preserved).

### Test files
- **`test/installer/plugin-bundle.test.ts`** — 4 tests: recursive copy, destructive replace, missing src, file-not-dir.
- **`test/installer/orchestrator.test.ts`** — 9 tests: fresh install, re-install same version, upgrade, downgrade refused, lock contention, partial install recovery, --license flag path, prompt path, cron backend.
- **`test/cli/verbs/install.test.ts`** — 4 tests: --license passthrough, --json output, PreconditionError → exit 3, human output.

## Verification
- `npm run typecheck` — clean (0 errors)
- `npm test` — 451 tests passing across 58 files
- `src/cli/main.ts` — NOT modified (FROZEN)
- `src/cli/verbs/index.ts` — both `@@VERBS_IMPORTS@@` and `@@VERBS_REGISTER@@` sentinels retained
- `registerInstallVerb` appears exactly twice in barrel (import + call)
- Build succeeds

## Key design decisions
- `InstallOptions.getMachineId` test hook added to avoid real machine-id calls in tests
- Lock uses `proper-lockfile` with `retries: 0` and `stale: 5min` — instant fail on contention
- All optional props use `T | undefined` for `exactOptionalPropertyTypes` compat
- version.txt written LAST ensures partial installs are re-runnable (verdict = 'fresh')

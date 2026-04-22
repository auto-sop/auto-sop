# V24: Windows Hardening + CI Fix Sprint

## Overview
Second of three Windows versions. v23 built the foundation (platform abstraction, Task Scheduler backend, tick script). v24 hardens the remaining platform-specific code AND fixes all CI failures introduced by v22-v23. There are 4 categories of CI failures that must be resolved:

1. **Lint errors** — v23 left unused vars/imports in multiple files
2. **`windows-refusal-check` CI job** — expects CLI to reject win32, but v23 correctly removed that block. Job is stale.
3. **Flaky e2e tests** — CAPT-04/CAPT-09 race condition on Ubuntu (subagent dir not finalized)
4. **Ubuntu platform tests** — statusline tests expect `[sop:on]` but get `[sop:off]`, doctor test expects `scheduler effective` error but gets different failures

v25 will add the Windows CI matrix runner.

## Architecture Decisions
- **chmod migration strategy**: The 62 `mode: 0o600`/`0o700` options in `writeFileSync`/`mkdirSync` are harmless on Windows (Node.js ignores them). Only the 9 explicit `chmodSync()`/`fs.chmod()` calls need migration — those will throw on Windows.
- **Migration approach**: Import `getPlatform()` and use `getPlatform().chmodSync()` instead of raw `chmodSync`. This uses the existing win32 adapter's no-op.
- **Flaky test root cause**: CAPT-04 and CAPT-09 already have `{ retry: 2 }` from v21, but still fail in CI. The real issue is a race condition in subagent capture finalization — the `beforeAll` setup completes before all capture dirs are fully written. Fix: add a polling wait for expected capture dir count before assertions run.
- **windows-refusal-check**: v23 correctly made CLI accept win32. The CI job that asserts rejection is now wrong — either remove it or flip it to assert acceptance.
- **Dev Army capture suppression**: The shim's `isCaptureDisabled()` doesn't detect army sessions. All 8 army agents fire PreToolUse + PostToolUse hooks, spawning ~1,600 Node.js processes per plan execution. Fix: check `DEV_ARMY_PROJECT_NAME` env var (already set by `army-start` in every pane) in the kill-switch. Shim exits instantly, zero I/O, no army-start changes needed. Manual Claude Code sessions remain unaffected.

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Migrate all chmodSync/fs.chmod calls to platform adapter
   Files: `src/cli/verbs/revert.ts`, `src/managed-section/editor.ts`, `src/managed-section/hash-store.ts`, `src/managed-section/directive-history.ts`, `src/scheduler/tick-wrapper.ts`
   Requirements:
   - In each file, replace raw `chmodSync(path, mode)` with `getPlatform().chmodSync(path, mode)`:
     - `src/cli/verbs/revert.ts:209` — `chmodSync(claudeMdPath, 0o644)` → platform adapter
     - `src/managed-section/editor.ts:357` — `chmodSync(claudeMdPath, 0o644)` → platform adapter
     - `src/managed-section/hash-store.ts:163` — `chmodSync(path, 0o600)` → platform adapter
     - `src/managed-section/directive-history.ts:328` — `chmodSync(path, 0o600)` → platform adapter
     - `src/scheduler/tick-wrapper.ts:86` — `await fs.chmod(path, 0o755)` → `await getPlatform().chmod(path, 0o755)`
   - Remove the `import { chmodSync } from 'node:fs'` where it's ONLY used for chmod (check if other fs functions are also imported from same line)
   - Add `import { getPlatform } from '../platform/index.js'` (adjust relative path per file)
   - The `editor.ts:359` already has a `process.platform !== 'win32'` guard — verify it's still correct after migration
   - Run `npm run typecheck` to verify no type errors
   - Run `npm test` to verify no regressions on macOS
   Acceptance: Zero raw `chmodSync` or `fs.chmod` calls remain outside `src/platform/`. All use `getPlatform()`. TypeScript compiles. Tests pass.

2. ARCHITECT: Fix flaky end-to-end CAPT-04/CAPT-09 tests
   Files: `test/capture/integration/end-to-end.test.ts`
   Requirements:
   - The `beforeAll` hook (around line 210-220) runs the capture simulation and then immediately proceeds to assertions. On slow CI runners, the subagent capture directory may not be fully finalized yet.
   - Add a polling wait after the capture run completes, before the assertion tests:
     ```typescript
     // Wait for expected number of finalized turn dirs (main + subagent = 2)
     const waitForDirs = async (captureDir: string, expected: number, timeoutMs = 10_000) => {
       const start = Date.now();
       while (Date.now() - start < timeoutMs) {
         const dirs = listFinalizedTurnDirs(captureDir);
         if (dirs.length >= expected) return dirs;
         await new Promise(r => setTimeout(r, 200));
       }
       return listFinalizedTurnDirs(captureDir);
     };
     ```
   - Call `waitForDirs(run.captureDir, 2)` in the `beforeAll` or in a shared setup step
   - Remove `{ retry: 2 }` from CAPT-04 (line 227) and CAPT-09 (line 244) — the root cause is fixed, retries are a band-aid
   - Run the test 5 times consecutively to verify stability:
     ```bash
     for i in {1..5}; do npx vitest run test/capture/integration/end-to-end.test.ts; done
     ```
   - All 5 runs must pass
   Acceptance: CAPT-04 and CAPT-09 pass 5/5 consecutive runs. No `{ retry: N }` on these tests. Polling wait handles slow finalization.

3. ARCHITECT: Add Windows-specific NTFS permission helper (advisory, no enforcement yet)
   Files: `src/platform/win32.ts`, `src/platform/types.ts`
   Requirements:
   - Add an optional method to the `PlatformAdapter` interface:
     ```typescript
     /** Set restrictive file permissions (POSIX chmod on Unix, icacls on Windows) */
     restrictFileAccess?(filePath: string): Promise<void>;
     ```
   - In `win32.ts`, implement `restrictFileAccess` using `icacls`:
     ```typescript
     async restrictFileAccess(filePath: string): Promise<void> {
       // icacls <file> /inheritance:r /grant:r "%USERNAME%:F"
       // Removes inherited permissions, grants full control only to current user
       const user = this.currentUser();
       await execa('icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:F`]);
     }
     ```
   - In `darwin.ts` and `linux.ts`, implement as a simple chmod 0o600:
     ```typescript
     async restrictFileAccess(filePath: string): Promise<void> {
       await fs.chmod(filePath, 0o600);
     }
     ```
   - This method is NOT called anywhere yet — it's prep for v25 when we add Windows CI and can test it. For now, just add the interface + implementations + unit tests.
   - Add unit tests that mock `execa` for the Windows path
   Acceptance: `restrictFileAccess` method exists on all 3 adapters. Unit tests pass (mocked). No production code calls it yet.

4. ARCHITECT: Fix lint errors from v23 (unused vars/imports)
   Files: Multiple (run `npm run lint` to get full list)
   Requirements:
   - Run `npm run lint` and fix ALL errors. Known issues from v23:
     - `newPlist` assigned but never used
     - `renderTable` defined but never used
     - `unlinkSync`, `statSync`, `dirname`, `basename` imported but unused
     - `released` assigned but never used
     - `existsSync` imported but unused
     - `BEGIN_MARKER`, `AmbiguousMarkersError` imported but unused
   - Remove unused imports/variables. Do NOT add `// eslint-disable` comments.
   - Run `npm run lint` again to verify zero errors.
   Acceptance: `npm run lint` passes with zero errors.

5. ARCHITECT: Fix/update `windows-refusal-check` CI job
   Files: `.github/workflows/ci.yml`
   Requirements:
   - The `windows-refusal-check` job asserts that `CLAUDE_SOP_FAKE_PLATFORM=win32 node dist/cli.cjs` exits non-zero. But v23 correctly removed the win32 platform block — CLI now accepts win32.
   - Option A (preferred): Flip the check to assert CLI ACCEPTS win32:
     ```yaml
     - name: CLI entry must accept win32
       run: |
         CLAUDE_SOP_FAKE_PLATFORM=win32 node dist/cli.cjs --version
         echo "OK: CLI entry accepted win32"
     ```
   - Option B: Remove the `windows-refusal-check` job entirely (it's no longer needed).
   - Also update the matrix comment from `# windows-latest explicitly excluded — INST-08` to:
     ```yaml
     # windows-latest: Phase 6 v25 — platform abstraction ready (v23), chmod migrated (v24), CI runner next
     ```
   - Do NOT add `windows-latest` to the matrix yet — that's v25.
   Acceptance: CI job passes. Comment updated.

6. ARCHITECT: Fix Ubuntu platform-specific test failures
   Files: `test/cli/verbs/statusline.test.ts`, `test/cli/verbs/doctor.test.ts`
   Requirements:
   - **Statusline tests** (lines ~526 and ~614): Tests expect `[sop:on]` and `parsed.on === true` but get `[sop:off]` and `false` on Ubuntu. Root cause: statusline checks for scheduler/hooks which behave differently on Ubuntu (no launchd).
     - Run the failing tests locally with verbose output to determine exact root cause
     - Fix: either make assertions platform-aware (skip scheduler-dependent checks on Linux) or mock the scheduler status
   - **Doctor test** (line ~339): Test expects output to contain `scheduler effective` but gets `precondition failed: 3 check(s) failed: installed, hooks wired, license configured`. Root cause: on Ubuntu, doctor check order/output is different.
     - Fix: make assertion match the actual Ubuntu output, or make the test platform-aware
   - Run full test suite on macOS to verify no regressions
   Acceptance: Tests pass on both macOS and Ubuntu CI runners. No `skipIf(platform)` unless truly platform-impossible.

### Wave 2 (depends on Wave 1)

7. ARCHITECT: Integration verification — simulated Windows flow with chmod migration
   Files: `test/installer/windows-install.test.ts`
   Requirements:
   - Extend the existing Windows install integration test (created in v23) to verify:
     1. `getPlatform().chmodSync()` is a no-op on win32 (already tested)
     2. `ManagedSectionEditor` can write CLAUDE.md on simulated win32 (mock platform, verify no chmod throw)
     3. `directive-history` can write history file on simulated win32 (mock platform, verify no chmod throw)
     4. `revert` verb doesn't crash on simulated win32 (mock platform)
   - These tests mock `process.platform` — they run on macOS
   - Run full test suite to verify zero regressions
   Acceptance: All 4 new integration checks pass. Full `npm test` green.

## Quality Gates (MANDATORY)
8. YODA: Code review — chmod migration, lint fixes, CI job update, flaky test fix, NTFS helper, Ubuntu test fixes
9. APEX: Security review — permission model (are files still protected on macOS/Linux after migration?), icacls command injection prevention
10. ANALYZER: Code improvement review — grade must be C or above

## Finalize
11. ARCHITECT: Commit with message: `feat(v24): Windows chmod migration + CI fix sprint + NTFS permission helper`

## Acceptance Criteria
- Zero raw `chmodSync`/`fs.chmod` calls outside `src/platform/` — all go through `getPlatform()`
- CAPT-04 and CAPT-09 e2e tests pass 5/5 consecutive runs without `{ retry }`
- `npm run lint` passes with zero errors
- `windows-refusal-check` CI job updated to assert acceptance (not rejection)
- Ubuntu statusline and doctor tests pass
- `restrictFileAccess()` method on all 3 platform adapters (not yet called in production)
- CI comment updated for Windows runner readiness
- Windows install integration test covers chmod migration paths
- `npm run typecheck` passes
- `npm test` passes on macOS
- All CI jobs green (lint, typecheck, test on all matrix entries)
- All quality gates approved

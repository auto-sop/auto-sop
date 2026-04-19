# V23: Native Windows Foundation — Platform Abstraction + Task Scheduler

## Overview
First of three Windows versions (v23-v25). This version lifts the `win32` platform block, abstracts platform-specific code behind interfaces, implements the Windows Task Scheduler backend, and fixes all build/install blockers. After v23, `npx auto-sop install` works on Windows for the first time — captures fire, scheduler runs, doctor passes.

v24 will handle NTFS permissions (ACL), `.cmd` shim hardening, and edge cases.
v25 will add Windows CI matrix and cross-platform test coverage.

## Architecture Decisions
- **Platform abstraction pattern**: Create a `src/platform/` module with `PlatformAdapter` interface. Each platform (darwin, linux, win32) implements it. Scheduler, permissions, and env-var resolution go through this adapter — no more scattered `process.platform` checks.
- **Task Scheduler**: Use `schtasks.exe` (built-in, no admin required for per-user tasks). Schedule hourly via `/SC HOURLY`. No PowerShell dependency.
- **Tick script**: Windows gets a `.cmd` batch file instead of POSIX shell. The tick-wrapper generates platform-appropriate scripts.
- **chmod**: Wrap all `fs.chmod()` calls in a platform-aware helper that no-ops on Windows. Keep `mode:` options in writeFile/mkdir (Node.js ignores them on Windows — harmless).
- **postbuild**: Make `chmod +x` conditional on non-Windows. Use `node -e` instead of bare `chmod` for portability.
- **env vars**: `process.env.USER` → fallback to `process.env.USERNAME` on Windows.

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Create platform abstraction layer
   Files: `src/platform/index.ts` (NEW), `src/platform/types.ts` (NEW), `src/platform/darwin.ts` (NEW), `src/platform/linux.ts` (NEW), `src/platform/win32.ts` (NEW)
   Requirements:
   - Create `src/platform/types.ts` with the `PlatformAdapter` interface:
     ```typescript
     export interface PlatformAdapter {
       readonly name: 'darwin' | 'linux' | 'win32';
       
       // Scheduler
       schedulerBackendName(): string;  // 'launchd' | 'systemd' | 'cron' | 'task-scheduler'
       
       // Environment
       currentUser(): string;  // USER or USERNAME
       
       // File permissions
       chmod(filePath: string, mode: number): Promise<void>;  // no-op on Windows
       chmodSync(filePath: string, mode: number): void;        // no-op on Windows
       
       // Tick script
       tickScriptExtension(): string;  // '.sh' | '.cmd'
     }
     ```
   - Create `src/platform/darwin.ts` implementing the interface (delegates to existing behavior)
   - Create `src/platform/linux.ts` implementing the interface
   - Create `src/platform/win32.ts` implementing the interface:
     - `chmod`/`chmodSync` → no-op (log debug message)
     - `currentUser()` → `process.env.USERNAME ?? process.env.USER ?? 'unknown'`
     - `tickScriptExtension()` → `'.cmd'`
   - Create `src/platform/index.ts` that exports `getPlatform(): PlatformAdapter` based on `process.platform`
   - Add unit tests in `test/platform/platform.test.ts` for all three adapters
   Acceptance: `import { getPlatform } from './platform'` works. All three adapters pass unit tests. No `process.platform` checks needed in consuming code.

2. ARCHITECT: Remove win32 platform block + fix build scripts
   Files: `src/platform-check.ts`, `package.json`
   Requirements:
   - In `src/platform-check.ts`: Remove the `win32` rejection (lines 5-8). Keep the file but only reject truly unsupported platforms (e.g., `freebsd`, `sunos`). Or simply delete the file if ALL platforms use the adapter pattern.
   - Search for ALL imports of `platform-check.ts` and update/remove them accordingly.
   - In `package.json` `postbuild` script (line 64): Replace `chmod +x ...` with a cross-platform alternative:
     ```json
     "postbuild": "mkdir -p dist/plugin && cp -R plugin/. dist/plugin/ && cp dist/capture/writer.cjs dist/plugin/writer.cjs && node -e \"if(process.platform!=='win32'){const fs=require('fs');['dist/plugin/shim.cjs','dist/plugin/learner.cjs','dist/capture/shim.cjs'].forEach(f=>fs.chmodSync(f,0o755))}\""
     ```
     Or better: create a `scripts/postbuild.js` cross-platform script and call that.
   - In `package.json` `version:auto-bump` script: Guard the `bash` call:
     ```json
     "version:auto-bump": "node -e \"if(process.platform!=='win32')require('child_process').execSync('bash scripts/bump-version.sh',{stdio:'inherit'})\""
     ```
   - Run `npm run build` to verify the build still works on macOS.
   Acceptance: `platform-check.ts` no longer rejects `win32`. `npm run build` passes. `postbuild` script is cross-platform.

3. ARCHITECT: Implement Windows Task Scheduler backend
   Files: `src/scheduler/windows-task-scheduler.ts` (NEW), `src/scheduler/index.ts`, `src/scheduler/detect.ts`
   Requirements:
   - Create `src/scheduler/windows-task-scheduler.ts` implementing the same `SchedulerBackend` interface as launchd/systemd:
     ```typescript
     // Task name: "auto-sop-learner"
     // Schedule: hourly
     // Command: node <learnerPath> --tick
     // Uses schtasks.exe (no admin needed for current-user tasks)
     
     export const windowsTaskScheduler: SchedulerBackend = {
       async install(opts): Promise<void> {
         // schtasks /Create /TN "auto-sop-learner" /SC HOURLY /TR "node <path>" /F
       },
       async uninstall(): Promise<void> {
         // schtasks /Delete /TN "auto-sop-learner" /F
       },
       async isInstalled(): Promise<boolean> {
         // schtasks /Query /TN "auto-sop-learner" → check exit code
       },
       async status(): Promise<SchedulerStatus> {
         // schtasks /Query /TN "auto-sop-learner" /FO CSV /V → parse
       },
     };
     ```
   - Update `src/scheduler/index.ts` `pickBackend()` to handle `win32`:
     ```typescript
     if (platform === 'win32') return windowsTaskScheduler;
     ```
   - Update `src/scheduler/detect.ts` to handle `win32` (no detection needed — always use Task Scheduler)
   - The tick script for Windows is handled in task 4 (separate task).
   - Add unit tests in `test/scheduler/windows-task-scheduler.test.ts`:
     - Mock `execa` calls to `schtasks`
     - Test install, uninstall, isInstalled, status parsing
     - Tests must run on macOS too (they mock schtasks, not call it)
   Acceptance: `windowsTaskScheduler` implements full `SchedulerBackend` interface. Unit tests pass (mocked). `pickBackend('win32')` returns the Windows backend.

4. ARCHITECT: Cross-platform tick script generation
   Files: `src/scheduler/tick-wrapper.ts`
   Requirements:
   - Refactor `writeTickScript()` to detect platform and generate appropriate script:
     - **macOS/Linux**: Keep existing POSIX shell script (no changes to current behavior)
     - **Windows**: Generate a `.cmd` batch file:
       ```cmd
       @echo off
       setlocal
       set PATH=%USERPROFILE%\.auto-sop\node_modules\.bin;%PATH%
       set AUTO_SOP_DATA_DIR=%USERPROFILE%\.auto-sop
       node "%~dp0learner.cjs" --tick 2>>"%AUTO_SOP_DATA_DIR%\learner.log"
       ```
   - The function should return the generated script path (with correct extension)
   - On Windows, skip `fs.chmod()` call (use the platform adapter from task 1, or guard with `process.platform !== 'win32'`)
   - Add tests for both POSIX and CMD script generation (test content, not execution)
   Acceptance: `writeTickScript()` generates `.sh` on macOS/Linux, `.cmd` on Windows. Both scripts reference correct paths. No `chmod` call on Windows. Tests pass.

### Wave 2 (depends on Wave 1)

5. ARCHITECT: Fix all scattered platform-specific code
   Files: Multiple (see list below)
   Requirements:
   - **`process.env.USER` fallback** — fix in these files:
     - `src/installer/orchestrator.ts:180` → `process.env.USER ?? process.env.USERNAME ?? 'unknown'`
     - `src/status/collector.ts:65` → same pattern
   - **`fs.chmodSync` calls that will throw on Windows** — fix in:
     - `src/cli/verbs/revert.ts:199,209` → wrap in try/catch or use platform adapter
     - `src/scheduler/tick-wrapper.ts:53` → already fixed in task 4
   - **`process.getuid()` calls** — already have `?.()` fallbacks, verify they work:
     - `src/scheduler/macos-launchd.ts:23-26` → only runs on macOS (guarded by backend selection)
     - `src/cli/verbs/doctor.ts:142` → only runs in macOS branch (guarded)
     - `src/cli/verbs/migrate.ts:88` → only runs in macOS branch (guarded)
   - **Doctor verb Windows support**:
     - `src/cli/verbs/doctor.ts:126` → add Windows Task Scheduler check branch:
       ```typescript
       if (process.platform === 'win32') {
         // Query schtasks for auto-sop-learner task
       } else if (process.platform === 'darwin') {
         // Existing launchctl check
       } else {
         // Existing systemctl check
       }
       ```
   - **Migrate verb**: Add `win32` early-return (no migration needed on Windows — fresh install):
     - `src/cli/verbs/migrate.ts` → `if (process.platform === 'win32') return { migrated: false, reason: 'not-needed' }`
   - Run full test suite to verify no regressions on macOS.
   Acceptance: `grep -r "process.env.USER" src/` shows all instances have Windows fallback. `chmodSync` calls are guarded. Doctor handles win32. Tests pass on macOS.

6. ARCHITECT: Integration test — simulated Windows install flow
   Files: `test/installer/windows-install.test.ts` (NEW)
   Requirements:
   - Create an integration test that mocks `process.platform` as `win32` and runs through the install orchestrator:
     1. Verify `pickBackend('win32')` returns `windowsTaskScheduler`
     2. Verify `writeTickScript()` generates `.cmd` content
     3. Verify `getPlatform().chmod()` is a no-op
     4. Verify `getPlatform().currentUser()` returns value from `USERNAME`
     5. Verify doctor verb doesn't crash on `win32`
   - These tests run on macOS (mocking platform) — real Windows CI is v25
   - Use vitest's `vi.mock` to mock platform-specific modules
   Acceptance: All 5 integration checks pass. No actual `schtasks` calls made. Tests run clean on macOS.

## Quality Gates (MANDATORY)
7. YODA: Code review — platform abstraction design, Task Scheduler implementation, all scattered fixes
8. APEX: Security review — Windows Task Scheduler privilege model, batch script injection prevention, permission handling
9. ANALYZER: Code improvement review — grade must be C or above

## Finalize
10. ARCHITECT: Commit with message: `feat(v23): Native Windows foundation — platform abstraction + Task Scheduler + build fixes`

## Acceptance Criteria
- `src/platform-check.ts` no longer rejects `win32`
- `PlatformAdapter` interface with darwin/linux/win32 implementations
- Windows Task Scheduler backend (`schtasks.exe`) fully implemented with mocked tests
- Tick script generates `.cmd` on Windows, `.sh` on macOS/Linux
- `npm run build` works (postbuild is cross-platform)
- All `process.env.USER` usages have `USERNAME` fallback
- All `fs.chmod`/`fs.chmodSync` calls guarded for Windows
- Doctor verb handles `win32` platform
- Integration test simulates Windows install flow (mocked)
- All existing tests still pass on macOS (zero regressions)
- All quality gates approved

# V25: Windows CI Matrix + Cross-Platform Test Hardening

## Overview
Final version in the Phase 6 (Native Windows) trilogy. v23 built the platform abstraction + Task Scheduler backend. v24 migrated chmod calls to the platform adapter and added the NTFS permission helper. v25 adds `windows-latest` to the CI matrix, fixes all tests that will fail on Windows (POSIX permission assertions, bash shebang checks, platform-gated scheduler tests), and validates the full pipeline on a real Windows runner.

## Architecture Decisions

### Test Strategy on Windows
The codebase has **~25 tests that assert POSIX file permissions** (`stat.mode & 0o777 === 0o600`). On NTFS, `stat.mode` returns `0o666` for files and `0o777` for directories regardless of actual ACLs. These tests must be **platform-guarded** — skip the mode assertion on win32, not the entire test. The test should still verify the file *was written correctly*; only the POSIX mode check is meaningless on NTFS.

### What Must Be Skipped on Windows Entirely
1. **Launchd smoke test** (`smoke.test.ts:1891`) — already `skipIf(process.platform !== 'darwin')` ✅
2. **`release-check.sh`** — bash script, won't run on Windows. Not in the test matrix (CI-only check on ubuntu-latest) ✅
3. **`npm run extract-rules`** — uses `tsx` which works cross-platform ✅

### Build Script
`postbuild.js` already has a `platform() !== 'win32'` guard for chmod calls ✅. The `npm run build` pipeline (extract-rules → tsup → postbuild) should work on Windows natively since `tsup` and `tsx` are cross-platform.

### What Must Work on Windows
- `npm install --ignore-scripts` → installs deps
- `npm run build` → tsup compiles, postbuild copies plugin
- `npm test` → vitest runs all non-skipped tests
- Task Scheduler tests (already mocked with `vi.mock('execa')`)
- Platform adapter tests for win32
- ManagedSectionEditor, directive history, revert (all use `getPlatform()` now)

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Add `windows-latest` to CI matrix
   Files: `.github/workflows/ci.yml`
   Requirements:
   - Add `windows-latest` to the `os` matrix in the `test` job:
     ```yaml
     os: [ubuntu-latest, macos-latest, windows-latest]
     ```
   - Update the comment from `# windows-latest: Phase 6 v25 — ...` to `# Phase 6 complete: windows-latest added in v25`
   - Keep the node version matrix as-is: `['18.17', '20', '22']`
   - This means the matrix grows from 6 jobs (2 OS × 3 Node) to 9 jobs (3 OS × 3 Node)
   - The `windows-acceptance-check` job (ubuntu-based, uses `CLAUDE_SOP_FAKE_PLATFORM=win32`) can stay — it validates the CLI entry point logic independent of actual Windows. Add a comment: `# Validates CLI entry with faked platform — complements real windows-latest in matrix`
   - On Windows runners, the `npm run build` step uses `cmd` by default. The `extract-rules` script uses `tsx` (cross-platform) → tsup → `node scripts/postbuild.js` — all should work. If `npm run build` fails due to shell differences, add `shell: bash` to the build step on Windows (GitHub Actions supports bash on Windows)
   - Run `npm run lint` and `npm run typecheck` to verify no issues
   Acceptance: CI config has `windows-latest` in the test matrix. Comment updated. CI YAML is valid.

2. ARCHITECT: Guard POSIX permission assertions for Windows compatibility
   Files: `test/atomic/write.test.ts`, `test/capture/writer/turn-dir.test.ts`, `test/capture/writer/tool-calls.test.ts`, `test/capture/writer/global-mirror.test.ts`, `test/capture/writer/stop-finalization.test.ts`, `test/capture/writer/errors.test.ts`, `test/installer/orchestrator.test.ts`, `test/managed-section/hash-store.test.ts`
   Requirements:
   - Create a shared test helper constant at `test/setup/platform.ts`:
     ```typescript
     export const isWindows = process.platform === 'win32';
     ```
   - In every test that asserts `stat.mode & 0o777`, wrap ONLY the mode assertion (not the full test) in a platform guard:
     ```typescript
     // Example: before
     expect(stat.mode & 0o777).toBe(0o600);
     
     // Example: after
     if (!isWindows) {
       expect(stat.mode & 0o777).toBe(0o600);
     }
     ```
   - Affected tests (search for `stat.mode & 0o` and `stat.mode &` in test files):
     - `test/atomic/write.test.ts:71` — file mode 0o600
     - `test/capture/writer/turn-dir.test.ts:69-70` — dir mode 0o700
     - `test/capture/writer/turn-dir.test.ts:175-176` — file mode 0o600
     - `test/capture/writer/turn-dir.test.ts:280` — file mode 0o600
     - `test/capture/writer/tool-calls.test.ts:43` — file mode 0o600
     - `test/capture/writer/global-mirror.test.ts:97-98` — file mode 0o600
     - `test/capture/writer/global-mirror.test.ts:103-104` — dir mode 0o700
     - `test/capture/writer/stop-finalization.test.ts:215` — dir mode 0o700
     - `test/capture/writer/stop-finalization.test.ts:219` — file mode 0o600
     - `test/capture/writer/stop-finalization.test.ts:223` — file mode 0o600
     - `test/capture/writer/errors.test.ts:54-55` — file mode 0o600
     - `test/capture/writer/errors.test.ts:65-66` — dir mode 0o700
     - `test/installer/orchestrator.test.ts:130` — tick.sh mode 0o755
     - `test/managed-section/hash-store.test.ts:62-67` — already has `if (process.platform === 'win32') return;` — verify it's correct, keep it
     - `test/managed-section/directive-history.test.ts:120` and `:752` — already have platform guards, verify correct
   - Do NOT skip entire tests — only skip the specific `stat.mode` assertion line. The test should still verify file content/existence on Windows.
   - Run full test suite to verify no regressions on macOS
   Acceptance: All permission assertion tests pass on macOS (unchanged behavior). On Windows, POSIX mode checks are skipped but file operations are still verified.

3. ARCHITECT: Fix bash-specific test assertions for Windows
   Files: `test/scheduler/tick-wrapper.test.ts`, `test/integration/phase2-e2e.test.ts`, `test/installer/uninstall-orchestrator.test.ts`
   Requirements:
   - `test/scheduler/tick-wrapper.test.ts:20` — asserts `starts with #!/bin/sh`. On Windows, the tick script is `.cmd` format (no shebang). This test likely only renders the POSIX script. Check if there's already a Windows variant or if the test needs a platform gate:
     - If the test calls `renderTickScript()` (POSIX), guard with `skipIf(isWindows)` or add a parallel test for `renderTickScriptCmd()` (Windows)
     - If there's already a Windows tick script test, leave it
   - `test/integration/phase2-e2e.test.ts:223` — asserts `content.split('\n')[0] === '#!/bin/sh'`. This is a POSIX-only assertion. Guard with `if (!isWindows)`.
   - `test/installer/uninstall-orchestrator.test.ts:134` — writes `#!/bin/sh\nexec node` as test fixture. This should work on Windows (it's just writing a string to a file). But verify the test doesn't try to EXECUTE the script — if it does, it will fail on Windows.
   - `test/scheduler/macos-launchd.test.ts` — already mocks execa, should work on Windows as all calls are mocked. Verify.
   - Check the `scheduler/dispatch.test.ts` and `scheduler/detect.test.ts` for any platform assumptions.
   - Run full test suite to verify no regressions
   Acceptance: All scheduler/integration tests pass on both macOS/Linux and will pass on Windows. Shell-specific assertions are properly guarded.

4. ARCHITECT: Platform-gate launchd/systemd-specific doctor and status tests
   Files: `test/cli/verbs/doctor.test.ts`, `test/cli/verbs/statusline.test.ts`, `test/cli/verbs/status.test.ts`
   Requirements:
   - `test/cli/verbs/doctor.test.ts:267-276` — already has `isMacOS` guard and `skipIf(!isMacOS)`. Check if there are OTHER doctor tests that will fail on Windows (e.g., tests expecting launchd/systemd output when neither is available).
   - `test/cli/verbs/statusline.test.ts` — Check if statusline tests make platform assumptions. The statusline reads scheduler status which differs per OS. On Windows, it should read Task Scheduler status via the win32 adapter. Tests may need mocking adjustments.
   - `test/cli/verbs/status.test.ts` — Similar: status collector may query platform-specific scheduler. Verify mocking covers Windows.
   - For any test that calls real platform binaries (`launchctl`, `systemctl`, `schtasks`), ensure they are properly mocked or platform-gated.
   - Run full test suite to verify no regressions
   Acceptance: Doctor, statusline, and status tests either mock platform-specific calls or are properly gated. No test calls real `launchctl`/`systemctl`/`schtasks` without mocking.

5. ARCHITECT: Add Windows-specific smoke test (end-to-end on real runner)
   Files: `test/smoke.test.ts` (new describe block), `vitest.smoke.config.ts`
   Requirements:
   - Add a new `describe.skipIf(process.platform !== 'win32')` block at the end of `smoke.test.ts`:
     ```typescript
     describe.skipIf(process.platform !== 'win32')(
       'smoke: Windows Task Scheduler (win32 only)',
       () => {
         // Test 1: Build succeeds on Windows
         // npm run build already ran (CI step), so just verify dist/ exists
         it('dist/cli.cjs exists after build', () => {
           expect(existsSync('dist/cli.cjs')).toBe(true);
         });

         // Test 2: CLI --version works on Windows
         it('cli --version exits 0', async () => {
           const { exitCode, stdout } = await execa('node', ['dist/cli.cjs', '--version']);
           expect(exitCode).toBe(0);
           expect(stdout).toMatch(/\d+\.\d+\.\d+/);
         });

         // Test 3: CLI status runs without crash
         it('cli status exits 0 (no project installed)', async () => {
           const result = await execa('node', ['dist/cli.cjs', '--json', 'status'], {
             reject: false,
             cwd: tmpdir(), // no project dir
           });
           // Status may return non-zero if no project, but must not crash
           expect(result.stderr).not.toContain('Cannot find module');
           expect(result.stderr).not.toContain('SyntaxError');
         });

         // Test 4: Platform adapter returns task-scheduler on win32
         it('getPlatform() returns win32 adapter', () => {
           const adapter = getPlatform();
           expect(adapter.name).toBe('win32');
           expect(adapter.schedulerBackendName()).toBe('task-scheduler');
         });
       },
     );
     ```
   - These smoke tests ONLY run on the `windows-latest` CI runner (skip on darwin/linux).
   - Import any needed modules at the top of the file (check existing imports).
   - NOTE: Do NOT test actual `schtasks` installation in CI — that would pollute the runner's Task Scheduler. The unit tests already cover schtasks via mocks.
   Acceptance: Windows smoke tests exist, skip on macOS/Linux, cover CLI startup + platform adapter on real Windows.

### Wave 2 (depends on Wave 1)

6. ARCHITECT: Verify full test suite green on simulated Windows conditions
   Files: (no new files — validation task)
   Requirements:
   - Run the full test suite locally: `npm test`
   - Verify zero failures, zero skipped tests that shouldn't be skipped
   - Run `npm run lint` — verify zero errors
   - Run `npm run typecheck` — verify zero errors
   - Count the number of platform-guarded assertions (grep for `isWindows` in test files) and document in commit message
   - Verify the CI YAML is valid: `npx yaml-lint .github/workflows/ci.yml` or manual review
   - Review that no test file imports `isWindows` but never uses it (unused import = lint error)
   Acceptance: `npm test`, `npm run lint`, `npm run typecheck` all pass. No regressions.

## Quality Gates (MANDATORY)
7. YODA: Code review — CI matrix expansion, platform guards in tests, Windows smoke tests. Focus: are guards too aggressive (skipping too much)? Are there tests that SHOULD be guarded but aren't?
8. APEX: Security review — verify that skipping POSIX permission checks on Windows doesn't silently weaken security. The `restrictFileAccess()` (NTFS ACLs via icacls) should be the actual enforcement on Windows — confirm it's wired up in capture/write paths or document as v26 follow-up.
9. ANALYZER: Code improvement review — grade must be C or above

## Finalize
10. ARCHITECT: Commit with message: `feat(v25): Windows CI matrix + cross-platform test hardening`

## Acceptance Criteria
- `windows-latest` appears in CI matrix alongside `ubuntu-latest` and `macos-latest`
- CI produces 9 test jobs (3 OS × 3 Node versions) — all green
- ~25 POSIX permission assertions are platform-guarded (not skipped entirely — only the mode check)
- Bash-specific test assertions are guarded for Windows
- Doctor/statusline/status tests handle Windows scheduler correctly
- Windows smoke test block validates CLI startup + platform adapter on real win32
- Zero new `eslint-disable` comments
- `npm test` passes on macOS (local verification)
- `npm run lint` and `npm run typecheck` pass
- All quality gates approved
- Phase 6 roadmap status: COMPLETE after v25

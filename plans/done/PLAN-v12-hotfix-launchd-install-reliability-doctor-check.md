# PLAN-v12 — Hotfix: Launchd Install Reliability + Scheduler Doctor Check

## Overview

v11 shipped clean and Phase 4-light is live end-to-end through manual `claude-sop recap --run`. Real-world dogfood in `~/Developer/wrbeautiful-shopify-theme` revealed that **`claude-sop install` writes the launchd plist but never actually causes launchd to schedule any fires**. Evidence collected at 13:11 Turkey time today against the 12:03:56 install:

```
launchctl print gui/501/com.claude-sop.learner:
  state            = not running
  runs             = 0                          ← never fired since load
  last exit code   = (never exited)
  run interval     = 3600 seconds               ← interval itself is correct
  path             = ~/Library/LaunchAgents/com.claude-sop.learner.plist
```

**recap.log has 73 lines** — every single one of them was produced by manual `claude-sop recap --run` invocations during polling. Zero lines came from launchd. SCHED-04 from Phase 2 (`"runs even with no Claude Code session active, survives reboot"`) is provably false for every user running claude-sop right now.

**Good news:** `launchctl kickstart -k gui/$UID/com.claude-sop.learner` fires the tick instantly and the full pipeline (shim → writer → cursor → recap → CLAUDE.md → exit 0) runs cleanly. So the plumbing is fine. The bug is isolated to **install-time scheduler bootstrap**: writing the plist file to `~/Library/LaunchAgents/` is not enough on modern macOS — you have to explicitly `bootstrap` (or `load -w`) the service so launchd starts counting intervals and actually fires. We are not doing that step, or we are doing it incorrectly.

Layered on top: **the `doctor` command cannot detect this silent broken state** — it reports `scheduler registered ok — launchd` because the plist file exists, but a file existing is not the same as launchd actually scheduling fires. Users get a green doctor with a broken scheduler. We need a new check that reads `launchctl print` and asserts real effectiveness.

v12 is a small, surgical fix: (a) make macOS install robustly bootstrap+warmup the service, (b) switch to a more reliable schedule primitive, (c) add a doctor check that surfaces silent broken state, (d) regression test all three.

## Architecture Decisions

### Fix A — Modern bootstrap API + explicit warmup kickstart

`src/scheduler/macos-launchd.ts` (or equivalent — ARCHITECT greps for the actual module) currently writes the plist and probably calls `launchctl load` or nothing at all. The fix is a complete lifecycle using the modern `launchctl` API documented in `man launchctl` and `launchd.plist(5)`:

```bash
# 1. Tear down any stale prior version (no-op if absent)
launchctl bootout "gui/$UID/com.claude-sop.learner" 2>/dev/null || true

# 2. Write the plist file atomically (tmp + rename)
atomic_write ~/Library/LaunchAgents/com.claude-sop.learner.plist

# 3. Bootstrap the new version into the user GUI domain
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.claude-sop.learner.plist

# 4. Enable (lifts any "disabled" state left over from previous session)
launchctl enable "gui/$UID/com.claude-sop.learner"

# 5. Warmup fire — PROVES the service works right now, not in 1 hour
launchctl kickstart -k "gui/$UID/com.claude-sop.learner"
```

Rationale:
- **`bootout` + `bootstrap`** are the modern (macOS 10.10+) API. They replace the legacy `unload`/`load` which have been deprecated in behavior (still work but with known quirks around reload timing).
- **`enable`** is critical because if a prior version crashed repeatedly, launchd might have marked the service as disabled, and a fresh `bootstrap` alone won't re-enable it.
- **`kickstart -k`** at install time is the **single most important part of this fix**: it guarantees at least one successful fire immediately after install. The user sees `runs = 1` right away, which the doctor check (Fix C) can assert, and the scheduler moves into the normal "interval counting" state from a known-good post-fire baseline.
- **Legacy fallback:** on macOS versions where `bootstrap` is unavailable (pre-10.10), fall back to `launchctl load -w`. ARCHITECT detects the macOS version at runtime via `sw_vers -productVersion` and picks the right path. Given the engine requirement `node ≥18.17` and that Phase 0 already refuses Windows, we can assume macOS 10.13+ in practice. Legacy path is a safety net, not the main branch.
- **Uninstall path** gets the same modernization: use `bootout` instead of `unload`. Uninstall is already idempotent per INST-06; we just modernize the teardown verb.

### Fix B — Switch from `StartInterval` to `StartCalendarInterval`

Current plist:
```xml
<key>StartInterval</key>
<integer>3600</integer>
```

Replace with:
```xml
<key>StartCalendarInterval</key>
<dict>
  <key>Minute</key>
  <integer>0</integer>
</dict>
```

**Why:**
- **Predictable mental model.** "Fires at the top of every hour" is something a user can understand and verify by looking at a clock. "Fires every 3600 seconds from when launchd decided to start counting" is opaque and, as v12's bug proves, prone to never starting the counter at all.
- **Sleep/wake robust.** Per Apple docs and widespread launchd folklore, `StartCalendarInterval` survives lid-close / wake-from-sleep cycles better than `StartInterval`: on wake, launchd checks if a matching calendar boundary was missed and fires a catchup if so. `StartInterval`'s behavior in the same scenario is implementation-defined and has changed between macOS versions.
- **Deterministic regression test.** We can test "fires within 60 seconds of any top-of-hour boundary" rather than "fires at launchd's discretion at some point after 3600 seconds since internal load time".
- **Cost:** the user loses the ability to specify arbitrary sub-hour intervals. For a plugin that learns from yesterday's captures, hourly granularity is clearly sufficient. The config key `CLAUDE_SOP_TICK_INTERVAL_SECONDS` (if it exists anywhere) should be either removed or explicitly documented as "ignored on macOS; fires at :00 top of hour".

On Linux, systemd timers already support `OnCalendar=hourly` semantically equivalently. That's a separate file and a separate plan if we ever fix it there, but the macOS fix is self-contained.

### Fix C — Doctor: `scheduler effective` check

Add a new doctor check (or rewrite the existing `scheduler registered` check into a stronger `scheduler effective` check). The new logic parses the output of:

```bash
launchctl print gui/$UID/com.claude-sop.learner
```

and inspects three fields:
- `state` — should be `running` or `not running` (both are OK; crashed/throttled is NOT OK)
- `runs` — integer count of total fires since load
- `last exit code` — `0`, `(never exited)`, or nonzero

Verdict logic:
- If `launchctl print` returns an error (service not loaded) → **fail: `scheduler not loaded`** (caller ran uninstall, or install never succeeded).
- If `runs == 0` AND install time > 90 minutes ago (read from `~/.claude-sop/version.txt` mtime or install timestamp) → **fail: `scheduler never fired in N minutes (expected fires at top of hour)`**. This is the silent-broken-state surface.
- If `runs == 0` AND install time < 90 minutes ago → **ok with detail: `fresh install, next fire at HH:00`**. Avoids false alarms right after install.
- If `runs >= 1` AND `last exit code == 0` → **ok: `runs=N, last exit 0`**.
- If `runs >= 1` AND `last exit code != 0` → **fail: `last fire exited with code X`**. Different failure mode worth surfacing.

**Important implementation note:** the check must NOT shell out via a raw `bash -c`. It must use a safe spawn (e.g. `execa`) with a strict arg list, parse the output deterministically, and fail-closed (any unparseable output → return `fail: parse error` rather than green). This matches the style of existing doctor checks in `src/doctor/checks.ts` (or wherever).

### Fix D — Regression tests

Three layers:

1. **Unit test** for the new install bootstrap sequence, mocking `execa` calls to `launchctl`. Assert the exact command sequence: `bootout → write plist → bootstrap → enable → kickstart`. Assert bootout errors are swallowed (idempotent fresh install case).

2. **Unit test** for the doctor check: mock `launchctl print` output with the actual format we captured in the bug report, assert the verdict for each of the five logic branches.

3. **Integration smoke test** (macOS only): in `test/smoke.test.ts`, add a test `(r) launchd install results in runs >= 1 within 2 seconds` that:
   - Copies the plugin bundle into a tmp path
   - Runs `claude-sop install` against a tmp project
   - Waits 2 seconds (for the warmup kickstart to complete)
   - Runs `launchctl print gui/$UID/com.claude-sop.learner` and parses output
   - Asserts `runs >= 1`
   - Asserts `last exit code == 0`
   - Then runs `claude-sop uninstall` and asserts the service is unloaded (`launchctl print` returns error)

   This test is `describe.skipIf(process.platform !== 'darwin')` so it runs only on macOS and skips cleanly on Linux CI. It's the first real end-to-end launchd test we'll have.

### Fix E — STATE.md sync

v10 and v11 landed but STATE.md still claims `Phase 1 COMPLETE, next phase 2 executing`. This is unrelated to the launchd bug but it's a cheap housekeeping item that belongs in a hotfix sprint. ARCHITECT updates STATE.md to reflect current reality:
- Phase 0, 1, 2, 3, 4-light shipped (with v12 pending to close Phase 2 properly)
- Current plan: v12 hotfix
- Next after v12: recall gate (v13) OR backlog / detector work
- Accumulated context: v11 statusline parser, v10 ManagedSectionEditor, v9 observable learner

## Phase 0: Advisory

None. Pure local bash/plist work, no HubSpot, no AWS, no UI surface.

## Implementation Tasks

### Wave 1 — single ARCHITECT, sequential

1. **ARCHITECT: Rewrite macOS install scheduler step with bootstrap + warmup**

   Files (MODIFIED):
   - `src/scheduler/macos-launchd.ts` (or wherever the install-side launchd code actually lives — ARCHITECT greps for `com.claude-sop.learner` or `LaunchAgents` in `src/` to find the real file)
   - Possibly `src/installer/steps/scheduler.ts` or `src/installer/orchestrator.ts` if the bootstrap step lives higher up

   Required code shape (pseudocode — real types/helpers match existing style):

   ```ts
   // Replace whatever currently writes the plist and calls launchctl
   async function installLaunchAgent(opts: InstallOptions): Promise<void> {
     const label = 'com.claude-sop.learner';
     const uid = opts.uid ?? process.getuid?.() ?? 501;
     const domainTarget = `gui/${uid}`;
     const serviceTarget = `${domainTarget}/${label}`;
     const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

     // 1. Bootout any prior version (ignore errors — idempotent fresh install)
     await execa('launchctl', ['bootout', serviceTarget], { reject: false });

     // 2. Atomic write plist
     const plistXml = renderPlist(opts);  // uses StartCalendarInterval now (Fix B)
     await atomicWrite(plistPath, plistXml, { mode: 0o644 });

     // 3. Bootstrap the new version
     const bootstrapResult = await execa('launchctl', ['bootstrap', domainTarget, plistPath], { reject: false });
     if (bootstrapResult.exitCode !== 0) {
       // Fallback to legacy load -w for ancient macOS
       await execa('launchctl', ['load', '-w', plistPath], { reject: false });
     }

     // 4. Enable (lifts disabled state from prior crash loops)
     await execa('launchctl', ['enable', serviceTarget], { reject: false });

     // 5. Warmup kickstart — prove the service can fire RIGHT NOW
     //    This is the single most important line in the whole fix. Without it,
     //    the user discovers the bug 1 hour after install (if ever), not 2 seconds.
     await execa('launchctl', ['kickstart', '-k', serviceTarget], { reject: false });
   }

   async function uninstallLaunchAgent(opts: InstallOptions): Promise<void> {
     const label = 'com.claude-sop.learner';
     const uid = opts.uid ?? process.getuid?.() ?? 501;
     const serviceTarget = `gui/${uid}/${label}`;
     const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

     // bootout is the modern counterpart to bootstrap; `unload` is legacy
     await execa('launchctl', ['bootout', serviceTarget], { reject: false });
     await fs.promises.rm(plistPath, { force: true });
   }
   ```

   Requirements:
   - All `launchctl` invocations go through `execa` or the project's existing subprocess helper. No raw `child_process.exec` with shell interpolation.
   - Every step has `reject: false` so no single failure aborts the install (every step is idempotent at launchd level).
   - Atomic plist write (tmp + fsync + rename) preserves the existing atomicity guarantee.
   - The plist XML renderer uses `StartCalendarInterval` (see Fix B below) — NOT `StartInterval`.
   - The new code honors the existing `--project` / `--project-home` flags and does not regress any prior install behavior.
   - After `installLaunchAgent` returns, `launchctl print gui/$UID/com.claude-sop.learner` MUST show `runs >= 1` within 2 seconds. If not, the install should fail loudly in the install output with a clear `scheduler warmup failed — see errors.log` message, NOT silently succeed.

   Acceptance:
   - Unit test with mocked `execa`: asserts the exact 5-step sequence happens in the right order; asserts `reject: false` on every call; asserts `bootout` failure doesn't abort install; asserts `bootstrap` failure triggers `load -w` fallback.
   - Manual: on the dogfood machine, `claude-sop uninstall && claude-sop install && launchctl print gui/$UID/com.claude-sop.learner | grep -E 'runs|last exit'` shows `runs = 1` (or higher) and `last exit code = 0`.

2. **ARCHITECT: Switch plist to `StartCalendarInterval { Minute: 0 }`**

   Files (MODIFIED):
   - The plist template renderer (same module as Fix A, or a separate template file under `src/scheduler/plist-template.ts` — ARCHITECT finds the current template)

   Current:
   ```xml
   <key>StartInterval</key>
   <integer>3600</integer>
   ```

   New:
   ```xml
   <key>StartCalendarInterval</key>
   <dict>
     <key>Minute</key>
     <integer>0</integer>
   </dict>
   ```

   Also remove the `RunAtLoad` key if it's present and set to `<false/>` — with `StartCalendarInterval`, the load-time fire behavior is implied and RunAtLoad becomes irrelevant. Keep it out of the plist entirely. The warmup fire comes from `launchctl kickstart` in Fix A, not from RunAtLoad.

   Requirements:
   - Fires at the top of every hour (:00:00).
   - Plist validates as valid XML plist (`plutil -lint com.claude-sop.learner.plist`).
   - No other plist keys change (Label, ProgramArguments, StandardOutPath, StandardErrorPath, EnvironmentVariables, ProcessType remain).
   - If the project's config anywhere stores a tick-interval-in-seconds number, that field is now documented as macOS-ignored (or removed entirely).

   Acceptance:
   - `plutil -lint ~/Library/LaunchAgents/com.claude-sop.learner.plist` exits 0 after install.
   - Unit test: renderPlist() output contains `<key>StartCalendarInterval</key>` and `<key>Minute</key>` `<integer>0</integer>` and does NOT contain `<key>StartInterval</key>`.

3. **ARCHITECT: New doctor check — `scheduler effective`**

   Files (MODIFIED):
   - The doctor checks module (grep for existing `scheduler registered` check — likely `src/doctor/checks/scheduler.ts` or similar)

   Replace the existing `scheduler registered` check with `scheduler effective`. The new check logic:

   ```ts
   async function schedulerEffective(ctx: DoctorContext): Promise<CheckResult> {
     const label = 'com.claude-sop.learner';
     const uid = process.getuid?.() ?? 501;
     const serviceTarget = `gui/${uid}/${label}`;

     // 1. launchctl print
     const result = await execa('launchctl', ['print', serviceTarget], { reject: false });
     if (result.exitCode !== 0) {
       return { status: 'fail', detail: `service not loaded (${serviceTarget})` };
     }

     // 2. Parse runs and last exit code from stdout
     const runsMatch = result.stdout.match(/^\s*runs\s*=\s*(\d+)/m);
     const lastExitMatch = result.stdout.match(/^\s*last exit code\s*=\s*(.+)$/m);
     if (!runsMatch || !lastExitMatch) {
       return { status: 'fail', detail: 'cannot parse launchctl print output' };
     }

     const runs = parseInt(runsMatch[1], 10);
     const lastExit = lastExitMatch[1].trim();

     // 3. Read install age from version.txt mtime
     const versionFile = path.join(homedir(), '.claude-sop', 'version.txt');
     const installAgeMs = Date.now() - (await fs.promises.stat(versionFile)).mtimeMs;
     const installAgeMin = Math.floor(installAgeMs / 60000);

     // 4. Verdict logic
     if (runs === 0 && installAgeMin > 90) {
       return {
         status: 'fail',
         detail: `never fired in ${installAgeMin}min (expected hourly fires)`,
       };
     }
     if (runs === 0 && installAgeMin <= 90) {
       return {
         status: 'ok',
         detail: `fresh install (${installAgeMin}min ago); next fire at top of hour`,
       };
     }
     if (runs >= 1 && lastExit === '0') {
       return { status: 'ok', detail: `runs=${runs}, last exit 0` };
     }
     if (runs >= 1 && lastExit !== '0' && lastExit !== '(never exited)') {
       return { status: 'fail', detail: `runs=${runs}, last exit ${lastExit}` };
     }
     return { status: 'ok', detail: `runs=${runs}, last exit ${lastExit}` };
   }
   ```

   Requirements:
   - Uses `execa` with explicit args (no shell).
   - Fail-closed: any unparseable launchctl output returns `fail: parse error`.
   - 90-minute grace window avoids false alarms right after install.
   - Detail strings are concise and actionable (the user should know what to do from reading the string).
   - Check runs in the existing doctor pipeline, adds 1 to the total check count (was 9 in v11).

   Acceptance:
   - Unit test with mocked `launchctl print` output covering:
     - Service not loaded → fail
     - Unparseable output → fail
     - runs=0, install 10min ago → ok (fresh install)
     - runs=0, install 120min ago → fail (never fired)
     - runs=5, last exit 0 → ok
     - runs=3, last exit 127 → fail (non-zero exit)
     - runs=0 with `(never exited)` — handled correctly based on install age
   - Manual: on the dogfood machine, run `claude-sop doctor` right now (before v12 fix is applied globally); the current v11 doctor shows 9/9 ok but `launchctl print` shows runs=0 — after the v12 install the new doctor surfaces the real state.

4. **ARCHITECT: Bootout + warmup applied to uninstall path**

   Files (MODIFIED):
   - The uninstall scheduler step (paired with Fix A's file)

   Current uninstall probably calls `launchctl unload`. Replace with `launchctl bootout gui/$UID/com.claude-sop.learner` and handle non-zero exit as idempotent no-op (service already gone).

   Requirements:
   - Uninstall remains idempotent (second uninstall doesn't error).
   - After uninstall, `launchctl print gui/$UID/com.claude-sop.learner` returns non-zero (service unloaded).
   - The plist file at `~/Library/LaunchAgents/com.claude-sop.learner.plist` is removed.

   Acceptance:
   - Unit test: mocked bootout called with correct target; rm called on plist path.
   - Integration: `claude-sop install && claude-sop uninstall && launchctl print gui/$UID/com.claude-sop.learner; echo $?` prints non-zero.

### Wave 2 — tests (depends on Wave 1)

5. **ARCHITECT: Unit tests for install/uninstall + doctor check**

   Files (MODIFIED):
   - `test/scheduler/macos-launchd.test.ts` — grow from the existing 7 tests to cover the new bootstrap/enable/kickstart sequence, the bootout modernization, and the bootstrap-fails-load-w-fallback path
   - `test/cli/verbs/doctor.test.ts` — add 6 new test cases for the new `scheduler effective` check covering all verdict branches

   Requirements:
   - Use `vi.mock('execa')` or the project's existing subprocess mock pattern.
   - Every mocked `launchctl` call must be asserted by name and arg list.
   - No real launchctl spawns in unit tests (integration test in task 6 handles that).
   - Tests pass on both macOS and Linux CI (mocked tests are OS-agnostic).

   Acceptance:
   - `npm run test` passes with the new test count (existing total + ~10 new).
   - Mocked tests clearly document which launchctl verbs get which arguments.

6. **ARCHITECT: Integration smoke test — real launchctl against tmp install**

   Files (MODIFIED):
   - `test/smoke.test.ts` — add one new test in a new group `smoke: launchd install reliability (macOS only)`:

   ```ts
   describe.skipIf(process.platform !== 'darwin')('smoke: launchd install reliability (macOS only)', () => {
     it('(r) install bootstraps launchd AND warmup fire produces runs >= 1 within 2s', async () => {
       const tmpHome = await mkdtemp(join(tmpdir(), 'claude-sop-launchd-'));
       // Set HOME to tmp so the install goes to a clean slate
       // IMPORTANT: launchctl operates on the REAL user's gui/$UID domain, so
       // the service label must be unique to avoid colliding with the real install.
       // Override the label via a test hook (env var CLAUDE_SOP_LABEL_OVERRIDE or similar)
       // OR run the install with a parametrized label.
       // …
       // After install, wait up to 3 seconds, then:
       const printResult = await execa('launchctl', ['print', `gui/${process.getuid()}/${TEST_LABEL}`], { reject: false });
       expect(printResult.exitCode).toBe(0);
       const runsMatch = printResult.stdout.match(/^\s*runs\s*=\s*(\d+)/m);
       expect(runsMatch).toBeTruthy();
       expect(parseInt(runsMatch[1], 10)).toBeGreaterThanOrEqual(1);
       // Cleanup: uninstall the test service
       await execa('launchctl', ['bootout', `gui/${process.getuid()}/${TEST_LABEL}`], { reject: false });
     }, 15000);
   });
   ```

   **Critical consideration:** the test must NOT touch the real `com.claude-sop.learner` service — that would nuke the user's actual install mid-test. The test uses a unique label like `com.claude-sop.learner.test-${pid}` and the install code path must accept a `--label` override (env var or option) for test isolation. If that override doesn't exist yet, ADD IT as part of this task, minimal surface: read `process.env.CLAUDE_SOP_LABEL` at install time and default to `com.claude-sop.learner`.

   Requirements:
   - Test is `skipIf(platform !== 'darwin')` so Linux CI skips cleanly.
   - Test uses a unique label so it cannot collide with the user's real install.
   - Test cleans up the bootstrapped test service in afterAll (bootout + rm plist).
   - Test assertion is `runs >= 1` within 2 seconds — not "runs == 1" (warmup + a racing natural fire could bump it to 2).
   - Test uses real `launchctl` spawns, not mocks — this is the whole point.

   Acceptance:
   - On macOS: test passes, creates + tears down a uniquely-labeled test service.
   - On Linux CI: test is skipped with a clear message.
   - Reverting Fix A's warmup kickstart line makes this test fail with `expected runs >= 1 but got 0`.

### Wave 3 — housekeeping (independent, can run parallel to Waves 1-2)

7. **ARCHITECT: Update STATE.md to reflect real project state**

   Files (MODIFIED):
   - `.planning/STATE.md`

   Replace the stale "Phase 1 COMPLETE, next phase 2 executing" block with current reality:
   - Phase 0 shipped (v1)
   - Phase 1 shipped (v2 + hotfixes v4-v8 touched related artifacts)
   - Phase 2 mostly shipped (v3, v4-v8 hotfixes, **v12 closes SCHED-04 gap**)
   - Phase 3 MVP shipped (v9 — observable learner, no detectors yet)
   - Phase 4-light shipped (v10 — ManagedSectionEditor + sample directive + statusline + test cleanup; v11 — statusline parser hotfix)
   - v12 in flight — launchd install reliability + doctor check
   - Next up after v12: recall gate (v13) or backlog cleanup (TBD)

   Accumulated Context updates:
   - v11's statusline parser lesson (fourth test-false-positive class bug)
   - v10's dispatch-task.sh stderr fix (dev-army infrastructure hotfix, not claude-sop itself)
   - dogfood validation completed with real army run in wrbeautiful-shopify-theme
   - known issue now fixed: launchd natural fire (v12)

   Requirements:
   - Use the existing STATE.md format (headers, bullets).
   - Do not rewrite history — additive updates only, preserve the Key Decisions list.
   - Bump "Sessions" count.

   Acceptance:
   - `git diff .planning/STATE.md` shows only the expected updates.
   - No content outside the listed sections is touched.

## Quality Gates (MANDATORY)

8. **YODA: Code review** — focus on:
   - Install sequence correctness: exact launchctl command order, no accidental `exit 1` cascades
   - Fail-open on bootout (idempotent install), fail-closed on doctor check (catch silent broken state)
   - Test fixtures for doctor use real launchctl output format (not simplified mocks) — following the v11 lesson that "simplified fixtures lie"
   - Warmup kickstart is present and verified (this is the single most important line)
   - `StartCalendarInterval` plist renders valid XML (plutil -lint green)
   **100% approval required.**

9. **APEX: Security review** —
   - `execa` calls to `launchctl`: argument lists are fully escaped, no shell interpolation, no tainted user input in command args
   - Label override env var: if Fix A adds `CLAUDE_SOP_LABEL` env support for test isolation, verify it CANNOT be used to hijack a different user's service (defense: must start with `com.claude-sop.learner` prefix, reject otherwise)
   - Plist file write: atomic rename preserves correct permissions (0644 for plist, NOT executable)
   - Doctor check parses launchctl output with regex: verify no ReDoS risk on crafted input (the regex is simple and anchored; low risk but worth noting)
   - Integration test: test service label uniqueness prevents cross-test-run collision even on parallel CI runs
   **Must pass P0/P1.**

10. **ANALYZER: Code improvement review** — grade the install helper rewrite, the doctor check, and the new tests. **Must be C or above.** Flag any duplicated launchctl argument construction that should be extracted to a helper.

(No PRISM — no UI surface.)

## Finalize

11. **ARCHITECT: Commit** with message:
    ```
    fix(phase2): launchd install reliability — bootstrap + warmup + doctor effective check
    ```

## Acceptance Criteria (POC-level validation, v12)

After this plan lands AND the user runs the refresh sequence, ALL of these hold:

- `npm run test` and `npm run test:smoke` both green; test count up by ~10 unit + 1 smoke
- `plutil -lint ~/Library/LaunchAgents/com.claude-sop.learner.plist` exits 0 after install
- After `claude-sop uninstall && claude-sop install`:
  - `launchctl print gui/$UID/com.claude-sop.learner | grep runs` shows `runs = 1` (or higher) within 2 seconds
  - `launchctl print gui/$UID/com.claude-sop.learner | grep 'last exit'` shows `last exit code = 0`
  - `~/.claude-sop/logs/recap.log` has grown by 2 lines (1 per-project + 1 summary) from the warmup fire
  - `~/Developer/wrbeautiful-shopify-theme/CLAUDE.md` has a fresh `Last updated` timestamp matching the warmup fire time
  - `claude-sop doctor` shows `scheduler effective  ok — runs=1, last exit 0` (new check, new detail format)
- At the next top-of-hour boundary (wait or manipulate system clock in a test context):
  - `launchctl print ... | grep runs` shows a higher number than right after install
  - A new recap.log entry appears that was NOT triggered by a manual `claude-sop recap --run`
  - The new entry's `tick_id` matches the clock hour pattern (`ck-HH00` or `ck-HHmm` for the fire time)
- `claude-sop doctor` before v12 install would show `scheduler registered ok` (misleading) — after v12 install it shows `scheduler effective ok` with actual runs count (actionable).

## Post-plan steps for the user

```bash
# 1. Build + test
cd ~/Developer/claude-sop
git log --oneline -3
npm run build
npm run test            # unit + integration + new launchd tests
npm run test:smoke      # smoke + new (r) macOS-only launchd reliability test

# 2. Refresh global
npm pack
npm i -g ./claude-sop-0.0.0.tgz

# 3. Clean install into dogfood — THE critical test
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop uninstall
claude-sop install
# Right after install, BEFORE touching anything:
sleep 2
launchctl print gui/$UID/com.claude-sop.learner | grep -E 'runs|last exit|state'
# expect: runs = 1, last exit code = 0, state = not running OR running

# 4. Doctor — new effective check
claude-sop doctor
# expect: scheduler effective  ok — runs=1, last exit 0 (or similar)
# expect: all 10 checks ok

# 5. Check warmup wrote to recap.log
tail -4 ~/.claude-sop/logs/recap.log | jq -c '{t, tick:.tick_id, turns:.turns_new, dir:.directive_written}'
# expect: 2 new lines from the warmup fire

# 6. Check CLAUDE.md got updated from warmup
grep 'Last updated' ~/Developer/wrbeautiful-shopify-theme/CLAUDE.md
# expect: recent timestamp matching install time

# 7. Top-of-hour natural fire test (patience required — wait for next :00)
# Current time: date +%H:%M
# Wait until HH:00 (or HH+1:00) passes
# After that time boundary:
launchctl print gui/$UID/com.claude-sop.learner | grep -E 'runs|last exit'
# expect: runs = 2 (or higher), last exit code = 0
tail -4 ~/.claude-sop/logs/recap.log | jq -c '{t, tick:.tick_id}'
# expect: a new tick_id matching the :00 hour, NOT a manual poll pattern

# 8. If step 7 fails (natural fire didn't happen at :00), v12 didn't fully fix.
#    Capture evidence: `launchctl print ... > /tmp/v12-failure.txt`
#    Share that output.
```

## Out of Scope (explicit non-goals)

- Linux systemd path: `src/scheduler/linux-systemd.ts` keeps its current behavior. A similar hardening plan for systemd (with `OnCalendar=hourly` and `Persistent=true`) can be v13 or v14 if we dogfood on Linux. Not in v12.
- Sub-hour intervals (every 15 min, every 5 min): `StartCalendarInterval` with `Minute: 0` is strictly hourly. If someone wants sub-hour, they can use `claude-sop recap --run` manually or we add a separate "aggressive mode" config in a later phase.
- Changing the learner logic itself: `src/learner/main.ts` and friends are untouched. This plan is 100% install + scheduler + doctor.
- Removing the manual `claude-sop recap --run` CLI verb: it stays — useful for dogfood and for users who want instant ticks.
- `CLAUDE_SOP_LEARNER_MODE=llm` opt-in path: untouched.
- CLAUDE.md managed section format, recall gate, detectors: all later phases.
- UI / statusline changes: untouched (v11 fixed the last issue there).

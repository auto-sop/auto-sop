# PLAN-v7 — Hotfix: Plugin Bundle Missing writer.cjs + End-to-End Smoke Test

## Overview

v6 unblocked `/plugin` and stopped shim.cjs from crashing the shell. Real-turn dogfood in `~/Developer/wrbeautiful-shopify-theme` now surfaces a **silent P0**: the capture pipeline runs the shim successfully but writes zero turn files. `~/.claude-sop/captures/` is never created. `~/.claude-sop/tmp/` has 6 orphaned payload JSON files.

**Root cause:** the plugin bundle is missing `writer.cjs`.

Execution trace per hook fire:
1. Claude Code invokes `~/.claude-sop/marketplace/claude-sop/shim.cjs` ✅ (shebang fix from v6 works)
2. Shim reads stdin, writes payload to `~/.claude-sop/tmp/<nanoid>.json` ✅ (proof: 6 orphaned files currently in `~/.claude-sop/tmp/`)
3. Shim calls `spawn(process.execPath, [path.join(__dirname, "writer.cjs"), payloadFile], { detached: true, stdio: "ignore" })` to hand off
4. `writer.cjs` does not exist at `__dirname` (`~/.claude-sop/marketplace/claude-sop/`) → spawn silently fails (no stderr, no throw)
5. Shim exits 0 (fail-open, correct Phase 1 policy)
6. Claude Code sees a happy hook; no user-visible symptom
7. `~/.claude-sop/captures/` never created, `status` shows `pending 0 / last tick never`

**Why v6 missed it:** postbuild does `cp -R plugin/. dist/plugin/` — that stages static `plugin/` source files. `writer.cjs` is a tsup build output at `dist/capture/writer.cjs` with no stage step copying it into `dist/plugin/`. The installer copies `dist/plugin/*` verbatim to `~/.claude-sop/marketplace/claude-sop/`, so the writer never makes it into the installed bundle. v6's smoke test ran `sh -c shim.cjs < /dev/null` and asserted exit 0 — which it does regardless of whether the writer is present, because the shim is fail-open on spawn failure.

**The fix is trivial** (one line in postbuild). **The regression guard is the important part**: v7 must add an end-to-end smoke test that actually asserts a `turn.json` materializes on disk after the shim processes a synthetic hook payload. Without this, the entire fail-open shim design means future bundle-layout regressions will slip through without any test signal.

## Architecture Decisions

- **Writer is staged into the plugin bundle via postbuild copy, not a new tsup entry.** The existing `capture/writer` tsup entry already produces `dist/capture/writer.cjs` (140 KB, includes proper-lockfile, nanoid, etc.). Cleanest fix: extend the `postbuild` script to `cp dist/capture/writer.cjs dist/plugin/writer.cjs`. No duplicate tsup entry (which would double build time for no benefit), no symlinks (which break on `npm pack`), no source changes to shim.cjs. The shim's `path.join(__dirname, "writer.cjs")` resolution stays untouched.
- **writer.cjs does NOT need a shebang.** Unlike shim/learner, writer.cjs is invoked via `spawn(process.execPath, [writerPath, ...])` — explicit `node` invocation, never shell mode. No shebang, no `chmod +x` required. Keep it as-is; only relocate the file.
- **End-to-end smoke test is the real deliverable.** The test spawns `dist/plugin/shim.cjs` in shell mode with a synthetic UserPromptSubmit payload on stdin, then **polls** for a `turn.json` to appear in a temporary `$HOME`-overridden captures directory, with a strict timeout (5s). If no turn.json appears within the window, the test fails with a message listing what's in `<tmpHome>/.claude-sop/tmp/` and `<tmpHome>/.claude-sop/captures/` so failures are diagnosable at a glance.
- **Test isolation via `$HOME` override.** The writer resolves captures under `os.homedir()`. Setting `HOME=<tmpdir>` in the child env redirects writes to a tempdir the test controls and cleans up after itself. No pollution of the real `~/.claude-sop/`, no flakiness from pre-existing state.
- **Stranded payloads in `~/.claude-sop/tmp/` are cleaned up manually post-install, not by the plan.** They're pre-v7 state, not test output. The user will `rm` them in the post-plan steps. The writer's own janitor logic (Phase 3 scope per roadmap) will handle this in general, but for POC validation we just sweep once.
- **No Phase 1 or Phase 2 source changes.** This is a packaging bug (missing cp) + a test gap (missing e2e). Zero behavior change to the shim, the writer, the installer, the scheduler, or the CLI.

## Phase 0: Advisory

None.

## Implementation Tasks

### Wave 1 — one ARCHITECT, sequential

1. **ARCHITECT: Stage writer.cjs into the plugin bundle (BLOCKER)**

   Files (MODIFIED):
   - `package.json` — extend the `postbuild` script.

   Current:
   ```
   "postbuild": "mkdir -p dist/plugin && cp -R plugin/. dist/plugin/ && chmod +x dist/plugin/shim.cjs dist/plugin/learner.cjs dist/capture/shim.cjs"
   ```

   New:
   ```
   "postbuild": "mkdir -p dist/plugin && cp -R plugin/. dist/plugin/ && cp dist/capture/writer.cjs dist/plugin/writer.cjs && chmod +x dist/plugin/shim.cjs dist/plugin/learner.cjs dist/capture/shim.cjs"
   ```

   Verify via `npm pack` that the tarball's `files` list includes `dist/plugin/writer.cjs`.

   Requirements:
   - After `npm run build`: `dist/plugin/writer.cjs` exists, is byte-identical to `dist/capture/writer.cjs`.
   - `npm pack`'s tarball contents include `dist/plugin/writer.cjs`.
   - `writer.cjs` does NOT get a shebang or exec bit (it's only ever invoked via `spawn(node, [path, ...])`).
   - `plugin/writer.cjs` is NOT added to the source `plugin/` directory. The staging is build-time only. `plugin/` source tree remains: `.claude-plugin/`, `hooks/`.

   Acceptance:
   - `test -f dist/plugin/writer.cjs`
   - `cmp dist/plugin/writer.cjs dist/capture/writer.cjs` exits 0 (byte-identical)
   - `head -c 2 dist/plugin/writer.cjs` is NOT `#!` (no accidental shebang from some other tool)
   - `npm pack --dry-run 2>&1 | grep 'dist/plugin/writer.cjs'` finds the file
   - After `claude-sop install` into a fresh project: `test -f ~/.claude-sop/marketplace/claude-sop/writer.cjs`

2. **ARCHITECT: End-to-end smoke test (regression guard — the real deliverable)**

   Files (MODIFIED):
   - `test/smoke.test.ts` — add a new test group `smoke: end-to-end capture pipeline`.

   Test behavior:
   - Create a temporary directory `tmpHome` via `fs.mkdtemp(os.tmpdir() + '/claude-sop-e2e-')`.
   - Spawn `dist/plugin/shim.cjs` via `execa('sh', ['-c', absolutePathToShim])` with:
     - `cwd`: any directory (doesn't matter — shim uses `os.homedir()` via `HOME`)
     - `env`: `{ ...process.env, HOME: tmpHome }`
     - `input`: a synthetic UserPromptSubmit hook JSON payload. Minimum shape:
       ```json
       {
         "session_id": "e2e-test-session",
         "project": { "path": "/tmp/e2e-fake-project" },
         "event_type": "UserPromptSubmit",
         "payload": { "prompt": "e2e smoke test prompt" }
       }
       ```
       (Match whatever shape Phase 1's writer actually parses — if the real shape differs, grep `src/capture/writer/` for the parser and mirror it.)
   - After `execa` resolves (shim exits 0), **poll** for up to 5 seconds (250ms intervals) for the existence of any `turn.json` file under `${tmpHome}/.claude-sop/captures/**`.
   - On timeout, fail the test with a diagnostic message listing:
     - Contents of `${tmpHome}/.claude-sop/tmp/` (payload files stuck with no reader → proves the writer didn't run)
     - Contents of `${tmpHome}/.claude-sop/captures/` (empty or partial directory tree → proves finalization didn't happen)
     - Contents of `${tmpHome}/.claude-sop/logs/errors.log` if present
   - On success, assert:
     - Exactly one `turn.json` exists
     - JSON parses cleanly
     - Has at least one event with `type === 'UserPromptSubmit'`
     - No `.pending` sibling file (turn was properly finalized)
     - Shim's own stderr was empty
   - Clean up `tmpHome` via `fs.rm` in an `afterAll` hook regardless of pass/fail.

   Additional polling-based finalization test:
   - Because the writer is detached and uses a 30s finalization timeout per Phase 1 research, the test should also verify the `.pending` rename happens within the 5s window. If it doesn't, that's a separate Phase 1 finalization bug and the test should fail with a clear "payload written to tmp but writer never produced turn.json within 5s" message — NOT hang for 30s.

   Requirements:
   - Test runs against built artifacts in `dist/` after `npm run build` (the `test:smoke` script already handles this).
   - Test is self-contained: no dependency on `~/.claude-sop/` state, no need for an installed `claude-sop` binary, no launchd.
   - Test is deterministic: passes on a fresh clone, passes repeatedly, doesn't flake.
   - Test is fast: under 7 seconds total (5s poll window + setup/teardown).
   - Test MUST fail if `dist/plugin/writer.cjs` is missing (regression guard for task 1). Verify by temporarily deleting that file and rerunning — the test must fail with a diagnostic that points at missing writer or stranded tmp payload, NOT a generic timeout.

   Acceptance:
   - `npm run test:smoke` exits 0, total test count is 13+
   - Deleting `dist/plugin/writer.cjs` and rerunning causes the e2e test to fail within 5.5s with a message mentioning "writer" or "tmp payload" or similar diagnostic hint
   - Running `git stash` on task 1's postbuild line, rebuilding, and running the smoke test fails the e2e assertion
   - `tmpHome` is cleaned up after the test — `ls /tmp | grep claude-sop-e2e` shows no stale dirs after `npm run test:smoke`

3. **ARCHITECT: Sanity check — shim stdin-drain test stays in Node mode, not e2e mode**

   The existing v5 test `shim exits 0 (fail-open) with synthetic UserPromptSubmit on stdin` in `test/smoke.test.ts` runs the shim in shell mode (v6 update) and asserts exit 0. That test is still valid — it guards the fail-open contract. Do NOT modify or delete it. The new e2e test in task 2 is a separate assertion that the pipeline actually produces output.

   Requirements:
   - No changes to existing assertions.
   - Test count strictly grows (12 → 13+), never shrinks.

## Quality Gates (MANDATORY)

4. **YODA: Code review** — postbuild one-liner (trivial) + e2e smoke test (substantial). Focus on:
   - Is the polling interval + timeout sane? (5s total, 250ms step)
   - Does cleanup happen on both success AND failure paths? (`afterAll`, not `afterEach`; `finally` inside the test body if needed)
   - Is the synthetic payload shape future-proof, or will it break when Phase 3 changes the writer's schema?
   - Does the test leak tmpdirs on CI?
   **100% approval required.**

5. **APEX: Security review** — the e2e test sets `HOME=<tmpdir>` in the child. Confirm:
   - No possibility of the test writing outside `tmpHome` even if the writer has a path traversal bug
   - `fs.mkdtemp` uses the system tempdir with proper permissions (700)
   - The synthetic payload does NOT contain real secrets (even dummy ones that could trigger secretlint false positives in logs)
   **Must pass P0/P1.**

6. **ANALYZER: Code improvement review** — grade postbuild + e2e test. **Must be C or above.**

(No PRISM: no UI.)

## Finalize

7. **ARCHITECT: Commit** with message:
   ```
   fix(phase2): stage writer.cjs into plugin bundle + end-to-end capture smoke
   ```

## Acceptance Criteria (POC-level validation, round 3)

After this plan lands AND the user runs the post-plan refresh sequence below, ALL of these must hold:

- `npm run build && npm run test:smoke` exits 0, test count ≥ 13
- `dist/plugin/` contains: `.claude-plugin/` `hooks/` `learner.cjs` `shim.cjs` `writer.cjs` (5 entries)
- After `claude-sop install` into `~/Developer/wrbeautiful-shopify-theme`:
  - `~/.claude-sop/marketplace/claude-sop/writer.cjs` exists and is byte-identical to `dist/plugin/writer.cjs`
  - Running one real prompt in Claude Code produces at least one `~/.claude-sop/captures/<project-slug>/<turn-id>/turn.json` with `events.length ≥ 2` including `UserPromptSubmit` and `Stop`
  - `~/.claude-sop/tmp/` is empty (or only contains files <1s old mid-flight) — no stranded payloads
  - `claude-sop status` shows `pending captures` non-negative and `last tick` with a recent timestamp
  - `~/.claude-sop/logs/errors.log` is empty
- `/plugin` in Claude Code still shows no errors (v6 regression guard)

## Post-plan steps for the user

```bash
# 1. Uninstall broken v6 state from dogfood project
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop uninstall     # default keeps data; do NOT use --purge

# 2. Rebuild + test + repack + reinstall global
cd ~/Developer/claude-sop
npm run build
npm run test:smoke       # must pass, count ≥ 13
npm pack
npm i -g ./claude-sop-0.0.0.tgz

# 3. Sweep stranded state (pre-v7 leftovers)
launchctl bootout "gui/$UID/com.claude-sop.learner" 2>/dev/null || true
rm -rf ~/.claude-sop/marketplace/claude-sop
rm -f  ~/.claude-sop/tmp/*.json
: > ~/.claude-sop/logs/errors.log
rm -f  ~/.claude-sop/logs/ticks.log

# 4. Fresh install + confirm writer.cjs is in the bundle now
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop install
ls ~/.claude-sop/marketplace/claude-sop/
# expect: .claude-plugin  hooks  learner.cjs  shim.cjs  writer.cjs
test -f ~/.claude-sop/marketplace/claude-sop/writer.cjs && echo "WRITER OK"

claude-sop doctor        # still 9/9 ok

# 5. Real turn through Claude Code
claude
# inside: issue "list top-level files in this repo"; /exit

# 6. Verify end-to-end pipeline worked
find ~/.claude-sop/captures -name 'turn.json'
find ~/.claude-sop/captures -name '*.pending'    # must be empty
TURN=$(find ~/.claude-sop/captures -name 'turn.json' | head -1)
jq '{events: (.events|length), types: (.events|map(.type)|unique)}' "$TURN"
ls ~/.claude-sop/tmp/          # expect: empty
cat ~/.claude-sop/logs/errors.log   # expect: empty
claude-sop status              # expect: pending ≥ 0, last tick non-"never"
```

**Success = step 6 shows a real `turn.json` with events, empty tmp, empty errors.** That is POC validation.

## Out of Scope

- Phase 3 real learner, recall gate, directives.
- Writer tmp-file janitor (Phase 3 scope).
- Any change to shim.cjs, writer.cjs, or installer source. v7 is packaging only.
- Refactoring the postbuild script into a Node helper. One-line cp is fine for now.
- Investigating whether the writer's 30s finalization timeout is too long for production (separate concern).

# PLAN-v15 — Bug Fix Sprint (B1-B8)

## Overview

v14 ships LLM-driven directive generation. Before moving to editor hardening (v16), we clean the codebase. 8 known bugs accumulated during v1-v14 dogfood — each small, each independent, all fixable in one sprint.

**No new features.** Pure quality-of-life fixes. After v15: zero known bugs, clean test suite, no cosmetic warnings.

## Bugs to fix

### B1 — Installer writes legacy `<!-- claude-sop:begin -->` markers

**Problem:** `claude-sop install` appends `<!-- claude-sop:begin --><!-- claude-sop:end -->` (Phase 2 era) to CLAUDE.md. But v10's ManagedSectionEditor writes `<!-- claude-sop:managed-section:begin v1 -->` separately. Result: two empty blocks side by side in CLAUDE.md.

**Fix:** Remove the legacy marker write from the installer's managed-section step. The learner (v10+) owns CLAUDE.md writing via ManagedSectionEditor — the installer should NOT touch CLAUDE.md's content beyond what ManagedSectionEditor handles.

**Files:** `src/installer/steps/managed-section.ts` or wherever the installer writes the old markers. Also update `test/installer/managed-section.test.ts` and `test/integration/phase2-e2e.test.ts` (the `INST-05` test that asserts old markers exist).

### B2 — Smoke test flaky perf (500ms limit)

**Problem:** `shim runs via sh -c without syntax errors` test has a 500ms timeout. On loaded machines it occasionally hits 503-507ms → false fail.

**Fix:** Increase timeout from 500ms to 1000ms. The test guards against shell parse errors, not perf — the timing assertion is overly strict.

**Files:** `test/smoke.test.ts` — find the `expect(elapsed).toBeLessThan(500)` line, change to 1000.

### B3 — `import.meta` tsup CJS warning

**Problem:** Every `npm run build` prints a warning about `import.meta.url` not being available in CJS format, from `src/cli/verbs/install.ts:20`.

**Fix:** Use `__dirname` with ESM fallback:
```ts
const here = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
```

**Files:** `src/cli/verbs/install.ts` line 20.

### B4 — Directive `updated` every minute even with no new data

**Problem:** `directive: updated` verdict fires every tick because the `Last updated: <timestamp>` in the directive body uses wall-clock time rounded to the minute. Different minute = different body bytes = `updated` instead of `unchanged`.

**Fix:** Replace wall-clock timestamp with `newest_turn_finalized_at` from the scan result. If no new turns, the timestamp stays the same → body identical → `unchanged`. Format: `_Data as of: {newest_finalized_at}_` instead of `_Last updated: {now}_`.

**Files:** `src/learner/directive-builder.ts` — change the timestamp source. Update `test/learner/directive-builder.test.ts` accordingly.

### B5 — Statusline doesn't read Claude Code stdin JSON

**Problem:** Claude Code's statusline pipes workspace JSON on stdin. Our `claude-sop statusline` verb ignores stdin and uses `process.cwd()`. In army panes where cwd = `~/.claude/dev-army/scripts/`, statusline returns `[sop:off]` even though the project has hooks.

**Fix:** If stdin has data (non-TTY), read it, parse as JSON, extract `workspace.current_dir`, use that as the project root instead of cwd. Fall back to cwd if stdin is empty/unparseable.

```ts
function getProjectRoot(opts: { project?: string }): string {
  if (opts.project) return path.resolve(opts.project);

  // Claude Code pipes workspace JSON on stdin for statusline commands
  if (!process.stdin.isTTY) {
    try {
      const input = readFileSync('/dev/stdin', 'utf8');
      const parsed = JSON.parse(input);
      if (parsed?.workspace?.current_dir) {
        return path.resolve(parsed.workspace.current_dir);
      }
    } catch { /* fall through to cwd */ }
  }

  return process.cwd();
}
```

**Files:** `src/cli/verbs/statusline.ts` — add stdin reading. Update `test/cli/verbs/statusline.test.ts` with a test that mocks stdin with JSON containing `workspace.current_dir`.

**Important:** This must be FAST (stdin read is synchronous, single `readFileSync`). Keep the <50ms target.

### B6 — dev-army cwd attribution

**Problem:** dev-army agent panes have cwd = `~/.claude/dev-army/scripts/`. When capture hooks fire, the `cwd` in the hook payload is the scripts dir, not the target project. Captures go to the wrong project's `.claude-sop/captures/`.

**Fix:** This is a **dev-army infrastructure fix**, not a claude-sop code fix. Modify `~/.claude/dev-army/scripts/agent-poll.sh` to set `DEV_ARMY_TARGET_PROJECT` env var from the project_home file. Then modify `src/capture/shim/main.ts` (or the writer's path resolution) to check `DEV_ARMY_TARGET_PROJECT` before falling back to `cwd`.

Actually, simpler: in `agent-poll.sh`, `cd "$PROJECT_HOME"` before spawning `claude`. This changes the cwd of the agent's claude session to the actual project dir. Then all hook payloads naturally have the right cwd.

**Files:**
- `~/.claude/dev-army/scripts/agent-poll.sh` — change `cd $SCRIPT_DIR && ./agent-poll.sh` to `cd "$PROJECT_HOME" && "$SCRIPT_DIR/agent-poll.sh"`. OR inside agent-poll.sh, `cd "$PROJECT_HOME"` before the `claude` spawn.
- No claude-sop source code changes needed if we fix the cwd at agent-poll level.

### B7 — `CLAUDE_SOP_LEARNER` env var confusing naming

**Problem:** `CLAUDE_SOP_LEARNER=1` means "I am the learner process, suppress capture" (recursion guard for the shim). But the name suggests "enable learning." This caused the v5 stub polarity bug.

**Fix:** Rename to `CLAUDE_SOP_CAPTURE_SUPPRESS=1`. Update all references:
- `src/capture/kill-switch.ts` — check new var name
- `src/learner/main.ts` — set new var name when spawning sub-processes
- `tick.sh` template — set new var name
- `plugin/hooks/hooks.json` — (if env var is referenced there)
- Plist template — update env var name
- Tests that reference the old name

**Backward compat:** Keep reading the OLD var name for one version (check both `CLAUDE_SOP_CAPTURE_SUPPRESS` and `CLAUDE_SOP_LEARNER`), log a deprecation warning if old name is used.

### B8 — `waitForQuiescence` 10s timeout flaky

**Problem:** `test/capture/integration/end-to-end.test.ts > main-with-subagent` times out at 10s on loaded machines. The subagent scenario needs more time when 3 army sessions are running.

**Fix:** Increase timeout from 10000ms to 30000ms in `test/capture/integration/run-scenario.ts`.

**Files:** `test/capture/integration/run-scenario.ts` — find `timeoutMs` default or the 10000 literal, change to 30000.

## Implementation Tasks

### Wave 1 — Quick fixes (independent, can be done in any order)

1. **ARCHITECT: B2 + B3 + B8 — trivial one-liners**

   - B2: `test/smoke.test.ts` — change 500 to 1000
   - B3: `src/cli/verbs/install.ts:20` — `__dirname` fallback
   - B8: `test/capture/integration/run-scenario.ts` — 10000 to 30000

   3 files, 3 lines each. Run `npm run build && npm run test` after.

2. **ARCHITECT: B1 — Remove legacy managed-section markers from installer**

   - Find and remove the code that writes `<!-- claude-sop:begin --><!-- claude-sop:end -->` in the installer
   - Update `test/installer/managed-section.test.ts` — remove assertions that expect old markers
   - Update `test/integration/phase2-e2e.test.ts` — the `INST-05` test needs to either be removed or changed to assert NO old markers
   - Verify `claude-sop install` no longer adds old markers to CLAUDE.md

3. **ARCHITECT: B4 — Directive timestamp uses turn data, not wall-clock**

   - `src/learner/directive-builder.ts` — change timestamp source from `nowIso` to `scan.newestTurnFinalizedAt` (or similar field from ScanResult)
   - If no turns exist (fresh install), use a static string like "no data yet" instead of a timestamp
   - Update tests: `test/learner/directive-builder.test.ts` — idempotency test now expects `unchanged` on consecutive calls with same scan data
   - Verify: two consecutive `claude-sop recap --run` with no new turns → second one shows `directive: unchanged`

### Wave 2 — Medium fixes

4. **ARCHITECT: B5 — Statusline stdin JSON support**

   - `src/cli/verbs/statusline.ts` — add `getProjectRoot()` helper that reads stdin when non-TTY
   - Keep it synchronous and fast (<50ms)
   - Add unit tests: stdin with valid workspace JSON → uses current_dir; stdin empty → falls back to cwd; stdin malformed → falls back to cwd
   - Test the Claude Code statusline integration path: mock stdin with `{"workspace":{"current_dir":"/path/to/project"}}`

5. **ARCHITECT: B6 — agent-poll.sh cwd fix**

   - `~/.claude/dev-army/scripts/agent-poll.sh` — before spawning `claude`, `cd "$PROJECT_HOME"` so the agent session's cwd is the real project
   - This is an INFRASTRUCTURE file, not a source code file — no npm build needed
   - Verify by restarting an army and checking the pane's cwd: `tmux display -t <pane> -p '#{pane_current_path}'`

6. **ARCHITECT: B7 — Rename CLAUDE_SOP_LEARNER env var**

   - New name: `CLAUDE_SOP_CAPTURE_SUPPRESS`
   - `src/capture/kill-switch.ts` — check new var (AND old var for backward compat, log deprecation)
   - `src/learner/main.ts` — set new var when spawning claude -p
   - `src/scheduler/plist-template.ts` (or wherever tick.sh template lives) — use new var name
   - `plugin/hooks/hooks.json` — if env var referenced (probably not — hooks don't set env)
   - Update all tests that reference `CLAUDE_SOP_LEARNER`
   - Grep for ALL occurrences: `grep -rn 'CLAUDE_SOP_LEARNER' src/ test/` and update each

### Wave 3 — Verification

7. **ARCHITECT: Full test run + smoke verification**

   - `npm run build` — verify ZERO warnings (B3 fixed import.meta warning should be gone)
   - `npm run test` — all passing, including fixed B8 timeout
   - `npm run test:smoke` — all passing, including relaxed B2 perf limit
   - Manual: `claude-sop install` in a test project → verify NO old `<!-- claude-sop:begin -->` markers in CLAUDE.md (B1)
   - Manual: two consecutive `claude-sop recap --run` with no new data → second shows `directive: unchanged` (B4)

## Quality Gates (MANDATORY)

8. **YODA: Code review** — focus on:
   - B1: installer doesn't leave orphan markers, uninstall still cleans up correctly
   - B5: stdin read is synchronous and fast, no blocking on TTY
   - B7: backward compat (old env var still works with deprecation warning)
   - No regressions in existing functionality
   **100% approval required.**

9. **APEX: Security review** —
   - B5: stdin parsing — can a malicious stdin JSON cause path traversal? (Defense: `path.resolve` + the existing `detectHooks` checks the resolved path's `.claude/settings.json`)
   - B7: env var rename — does the old var still suppress capture correctly during transition?
   **Must pass P0/P1.**

10. **ANALYZER: Code improvement review** — grade all 8 fixes. **Must be C or above.**

## Finalize

11. **ARCHITECT: Commit** with message:
    ```
    fix: bug fix sprint — 8 known issues (B1-B8) cleaned
    ```

## Acceptance Criteria

After v15:
- `npm run build` → **zero warnings** (B3 gone)
- `npm run test` → **all pass** (B8 fixed timeout)
- `npm run test:smoke` → **all pass** (B2 relaxed limit)
- `claude-sop install` → NO old `<!-- claude-sop:begin -->` in CLAUDE.md (B1)
- Two `claude-sop recap --run` back-to-back → second is `directive: unchanged` (B4)
- `claude-sop statusline` in army pane → reads stdin JSON → `[sop:on]` (B5)
- Agent pane cwd = project home, not scripts/ (B6)
- `CLAUDE_SOP_CAPTURE_SUPPRESS=1` works, old `CLAUDE_SOP_LEARNER=1` still works with deprecation (B7)
- Zero known bugs remaining

## Post-plan steps

```bash
cd ~/Developer/claude-sop
npm run build              # zero warnings?
npm run test               # all pass?
npm run test:smoke         # all pass?

npm pack && npm i -g ./claude-sop-*.tgz

# B1 test
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop uninstall && claude-sop install
grep 'claude-sop:begin' CLAUDE.md && echo "B1 FAIL — old markers" || echo "B1 OK"

# B4 test
claude-sop recap --run
claude-sop recap --run
# second should say directive: unchanged

# B5 test (army pane'de)
# army-start → commander pane statusline should show [sop:on]

# B7 test
CLAUDE_SOP_CAPTURE_SUPPRESS=1 node dist/plugin/shim.cjs < /dev/null
echo $?   # should be 0 (capture suppressed)
```

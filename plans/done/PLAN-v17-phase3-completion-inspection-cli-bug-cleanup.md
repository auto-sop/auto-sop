# PLAN-v17 — Phase 3 Completion + Inspection CLI + Bug Cleanup

## Overview

Rich sprint plan covering 10 items across three themes:

1. **Phase 3 completion** — the last intelligence items (I6, I7, I8) + a new finding from v16 dogfood (I9: directive loss on uninstall)
2. **Phase 5 start** — inspection CLI verbs (C1, C2) so users can browse captures without `find`/`jq` commands
3. **Bug cleanup** — 4 small bugs surfaced during v16 validation (B9-B12)

After v17:
- Phase 3 at **100%** (LEARN-01..08 all satisfied)
- Phase 5 at **50%** (inspection verbs done, packaging hardening remains for v18)
- Zero known bugs again

## What v17 ships

| # | Item | Category | Scope |
|---|---|---|---|
| **I6** | 600s hard kill on learner | Phase 3 — LEARN-08 | Small |
| **I7** | `claude-sop learn-now --dry-run` verb | Phase 3 — LEARN-07 | Small |
| **I8** | LLM skip when `turns_new == 0` | Phase 3 — cost optimization | Small |
| **I9** | Directive preservation across uninstall/install | Phase 3 — UX fix from v16 dogfood | Medium |
| **C1** | `claude-sop recent [--since 1h]` verb | Phase 5 — CLI-02 | Medium |
| **C2** | `claude-sop show <id>` verb | Phase 5 — CLI-03 | Medium |
| **B9** | Revert verb registration in top-level help | Bug | Tiny (1 line) |
| **B10** | Remove unused `execFileSync` import | Bug | Tiny (1 line) |
| **B11** | Fix statusline test `dist/cli.cjs` lookup races | Bug | Small |
| **B12** | Bump `large-output` integration test timeout | Bug | Small |

## Architecture Decisions

### I6 — Learner hard-kill at 600s

**Problem:** LLM calls take 5-30s normally but can hang on malformed responses or network issues. Currently the learner has a 120s timeout on the `claude -p` spawn only. If something else hangs (file locks, I/O, infinite loop in a detector), the learner can run forever, overlap with the next hourly tick, and pile up processes.

**Fix:** Wrap the entire `main()` function in a hard-timeout using `AbortController` + `setTimeout(600_000)`. On trigger:
- Log `learner_hard_timeout` to errors.log
- Write a partial recap summary (`hard_timeout: true`)
- `process.exit(0)` (fail-open policy)
- Any pending cursor locks are released via existing `finally` blocks

**Files:** `src/learner/main.ts` — wrap top-level `main()` in AbortController pattern.

### I7 — `claude-sop learn-now` verb

**Problem:** v9 shipped `claude-sop recap --run` which invokes the learner. But "recap" is a misleading name — the user thinks "show me recent history" not "run learner now." Phase 3 roadmap item LEARN-07 requires a `learn-now` verb with `--dry-run` support.

**Fix:** New verb `claude-sop learn-now`:
- Same underlying spawn as `recap --run` (runs learner as child process)
- `--dry-run` flag sets `CLAUDE_SOP_LEARNER_DRY_RUN=1` in child env (matches existing recap --run --dry-run)
- `--offline` flag sets `CLAUDE_SOP_LEARNER_MODE=offline`
- Prints per-project table after completion (same format as recap)
- `--json` for machine-readable output

This is essentially an alias for `recap --run` but with the right verb name. Keep `recap --run` working for backward compat, mark it as "legacy — use learn-now" in help text.

**Files:** `src/cli/verbs/learn-now.ts` (new) — 95% shared code with `recap.ts` runLearner logic. Extract into `src/cli/shared/learner-spawn.ts`.

### I8 — Skip LLM call when `turns_new == 0`

**Problem:** Every hourly tick currently runs `claude -p` even if no new turns exist. Wastes ~10-30 seconds of Claude Max subscription time (free but slow), re-analyzes the same 30 turns hoping LLM produces different output (it rarely does because directives are deterministic given stable input).

**Fix:** In learner main.ts, before calling `runLlmAnalysis`:
```ts
if (scan.turns_new === 0 && !forceLlm) {
  // No new data — skip expensive LLM analysis
  recapLine.llm_mode = true;
  recapLine.llm_skipped = 'no_new_turns';
  recapLine.llm_duration_ms = 0;
  llmResult = { proposals: [], durationMs: 0, error: 'skipped_no_new_turns', summary: '', turnsAnalyzed: 0, patternsBelowThreshold: 0 };
} else {
  llmResult = await runLlmAnalysis(...);
}
```

`forceLlm` is `true` when user passes `--force-llm` to learn-now (manual override for testing). Default launchd tick respects the skip.

**Result:** A project with no activity for a day → 24 natural ticks, 24 recap lines, **zero LLM calls**. Directive-builder still runs with cached rule-based proposals + reuses last LLM proposals from directive-history.

**Files:** `src/learner/main.ts` — add skip logic. `src/cli/verbs/learn-now.ts` — add `--force-llm` flag.

### I9 — Directive preservation across uninstall → install (NEW from v16 dogfood)

**Problem:** Observed in v16 validation. Flow:
1. User has 6 active directives in CLAUDE.md (from v14's LLM analysis).
2. User runs `claude-sop uninstall` → `strip-managed-section` step removes markers + content → directives gone from CLAUDE.md.
3. User runs `claude-sop install` → fresh managed section (no content).
4. User runs `claude-sop recap --run` → LLM analyzes 92 captured turns → sees Claude already followed old directives in past turns → concludes "no new patterns" → writes "No recurring patterns detected yet."

**Result:** 6 valuable directives lost. LLM re-analysis heuristic ("directive X already appears in captures as followed behavior") creates a false-negative.

**Fix (option A chosen):**
- `claude-sop uninstall` does NOT delete `<project>/.claude-sop/state/directive-history.json`. It only strips CLAUDE.md markers. The history file persists.
- `claude-sop install` checks for existing `directive-history.json`. If found AND has active directives (not pruned by TTL):
  - Log: `Found N active directives from previous install. Restoring to CLAUDE.md.`
  - Write them directly to the new managed section (skipping LLM call)
  - Set recap's next-run flag: `just_restored: true` → skips next LLM analysis to avoid duplicate proposals
- Uninstall flow also backs up current CLAUDE.md's managed section CONTENT to `directive-history.json` if not already there (defensive — covers case where directive-history was manually deleted).
- New CLI option: `claude-sop install --no-restore` to force a clean slate (testing scenario).

**Files:**
- `src/installer/orchestrator.ts` — add directive restore step
- `src/installer/steps/uninstall-managed-section.ts` (or wherever strip happens) — ensure directive-history.json is PRESERVED, not deleted
- `src/cli/verbs/install.ts` — add `--no-restore` flag
- `src/managed-section/directive-history.ts` — add `loadActiveDirectives()` helper

### C1 — `claude-sop recent [--since 1h]` verb

**Problem:** User wants to see "what Claude did in the last hour" without grep/find/jq incantations. Roadmap requirement CLI-02.

**Fix:** New verb:
```
claude-sop recent                    # last 1 hour (default)
claude-sop recent --since 30m
claude-sop recent --since 2h
claude-sop recent --since 1d
claude-sop recent --project <path>   # default: cwd
claude-sop recent --json
```

Output (human table):
```
Recent turns (last 1h):

  time      agent        session_id  turn_id       tool_calls  files  status
  ────────  ───────────  ──────────  ────────────  ──────────  ─────  ──────
  14:32:15  commander    a7914106    wx2vjpM3b0Pl          1      0  ok
  14:30:22  architect-…  c7069a36    am9aO38gADwG         14      3  ok
  14:28:55  yoda         0d65f2d4    -KKBEdkBurJp          6      0  approved
  ...
```

Reads `<project>/.claude-sop/captures/` directly, filters by `finalized_at` within time window. No cursor involved (independent from learner). Fast — just metadata reads.

**Files:** `src/cli/verbs/recent.ts` (new). Uses existing `turn-scanner.ts` with time filter.

### C2 — `claude-sop show <id>` verb

**Problem:** User sees an interesting turn_id in `recent` output and wants to inspect it in full. Roadmap requirement CLI-03.

**Fix:** New verb:
```
claude-sop show <turn-id>           # full turn content
claude-sop show <session-id>        # all turns in session (compact)
claude-sop show <turn-id> --raw     # no formatting, raw files
claude-sop show <turn-id> --files   # just list files changed
claude-sop show <turn-id> --tools   # just tool-calls summary
claude-sop show <turn-id> --json    # machine-readable
```

Output (human, turn_id mode):
```
Turn: wx2vjpM3b0Pl
Session: a7914106-8d5d-4a95-bfcb-6dc9f3d83821
Agent: commander
Started: 2026-04-14T19:15:50.332Z
Finalized: 2026-04-14T19:15:52.147Z (2s)
Files changed: 0
Tool calls: 1

━━━ PROMPT ━━━
plan: [REDACTED]/PLAN.md
project home: [REDACTED]/

━━━ RESPONSE ━━━
I'll dispatch this plan to ARCHITECT.
...

━━━ TOOL CALLS ━━━
1. Bash (2s, success)
   $ ./dispatch-task.sh architect ...
   → task-abc123 dispatched
```

Ambiguity: turn_id (12 chars) vs session_id (UUID format, 36 chars) auto-detected by length.

**Files:** `src/cli/verbs/show.ts` (new). Reads turn directory's files directly.

### B9 — Revert verb in top-level help

**Problem:** `claude-sop revert --help` works (verb is registered somewhere), but `claude-sop --help` doesn't list it.

**Fix:** Find the commander.command(...) registration call for revert in `src/cli.ts` — probably missing or placed after a return. Add or unhide it.

**Files:** `src/cli.ts` — 1 line (ensure `registerRevertVerb(program)` is called in the verb registration block).

### B10 — Remove unused `execFileSync` import

**Problem:** Build warning:
```
"execFileSync" is imported from external module "child_process" but never used in "dist/plugin/learner.cjs".
```

**Fix:** Find `import { ... execFileSync ... } from 'node:child_process'` in a file reachable from learner main.ts, remove the unused name.

**Files:** Probably `src/learner/main.ts` or `src/learner/llm-mode.ts` — grep for the import, remove.

### B11 — Statusline test `dist/cli.cjs` race

**Problem:** 2 tests in `test/cli/verbs/statusline.test.ts` spawn `node $CLI_PATH statusline ...` with `CLI_PATH = dist/cli.cjs`. When run in the FULL `npm run test` suite, `dist/cli.cjs` goes missing mid-test due to vitest parallelism + some other test triggering a rebuild.

**Fix:** Copy `dist/cli.cjs` to a tmpdir at test-group `beforeAll`, spawn from the tmpdir path. Same pattern as smoke tests (v8's isolated bundle).

```ts
beforeAll(async () => {
  tmpDir = await mkdtemp(...);
  await copyFile(resolve(ROOT, 'dist/cli.cjs'), join(tmpDir, 'cli.cjs'));
  CLI = join(tmpDir, 'cli.cjs');
});
```

**Files:** `test/cli/verbs/statusline.test.ts` — wrap affected tests in isolation block.

### B12 — `large-output` integration test timeout

**Problem:** `test/capture/integration/end-to-end.test.ts > large-output` times out at 50s (was 10s pre-v15, bumped to 50s, still not enough on loaded machines). Dependent tests get skipped.

**Fix:** Further relax to 120s. These are integration tests that depend on filesystem + subprocess timing. CPU-bound assertions are elsewhere.

Alternative fix: make the test more reliable by using `fs.watch` instead of polling, but that's risky refactor. Just bump timeout for now.

**Files:** `test/capture/integration/run-scenario.ts` — find `timeoutMs` default or the 50000 literal, bump to 120000.

## Implementation Tasks

### Wave 1 — Phase 3 completion (independent, parallel-safe)

1. **ARCHITECT: I6 — Learner hard-timeout at 600s**
   - Wrap `main()` in AbortController
   - On timeout: log + write partial summary + exit 0
   - Unit test: mock a slow detector that sleeps 700s, verify timeout fires at 600s, exit code 0

2. **ARCHITECT: I8 — Skip LLM when turns_new == 0**
   - Conditional in learner main.ts before `runLlmAnalysis`
   - `--force-llm` flag override (for learn-now verb)
   - New recap field: `llm_skipped: 'no_new_turns'` | null
   - Unit tests: idle case (skip), new-turn case (run), --force-llm case (run despite no new)

3. **ARCHITECT: I9 — Directive preservation across uninstall/install**
   - Uninstall: preserve `directive-history.json` (defensive backup if missing)
   - Install: check history, restore active directives to CLAUDE.md
   - `--no-restore` flag for clean slate
   - New recap flag `just_restored: true` for the first tick after restore → skips LLM analysis
   - Integration test: install → directives written → uninstall → install → directives restored

### Wave 2 — New CLI verbs (depends on Wave 1)

4. **ARCHITECT: I7 — `learn-now` verb**
   - New `src/cli/verbs/learn-now.ts`
   - Extract shared spawn logic from `recap.ts` → `src/cli/shared/learner-spawn.ts`
   - `--dry-run`, `--offline`, `--force-llm`, `--json`, `--limit` flags
   - `recap --run` becomes a deprecation alias (still works, logs "use learn-now")
   - Unit tests + `--help` output verification

5. **ARCHITECT: C1 — `recent` verb**
   - `src/cli/verbs/recent.ts`
   - `--since` parses duration strings (1h, 30m, 2d)
   - Human table + `--json`
   - Uses existing turn-scanner with time filter
   - Unit tests with fixture captures at various ages

6. **ARCHITECT: C2 — `show` verb**
   - `src/cli/verbs/show.ts`
   - Auto-detect turn_id vs session_id by format/length
   - `--raw`, `--files`, `--tools`, `--json` flags
   - Handles turn-not-found gracefully (exit 2)
   - Unit tests with fixture turns

### Wave 3 — Bug cleanup (independent, parallel-safe)

7. **ARCHITECT: B9 + B10 — Trivial fixes**
   - B9: ensure `registerRevertVerb(program)` is called in `src/cli.ts`. Verify top-level `--help` includes `revert`.
   - B10: remove unused `execFileSync` import from whatever learner file imports it.
   - Build must produce ZERO warnings afterwards.

8. **ARCHITECT: B11 + B12 — Test infra fixes**
   - B11: isolate `dist/cli.cjs` per test in statusline.test.ts (copy to tmpdir, spawn from there)
   - B12: bump `large-output` test timeout from 50s to 120s in run-scenario.ts

### Wave 4 — Quality gates

9. **YODA: Code review** —
   - I6: any code path where 600s timeout could cascade into corrupting the cursor lock?
   - I8: skip logic doesn't accidentally also skip rule-based detectors (only LLM should skip)
   - I9: uninstall preservation doesn't leak directive content to other projects
   - C1/C2: path traversal defense on user input (session-id, turn-id)
   - B11: test isolation actually works (reverting fix causes test to fail)
   **100% approval required.**

10. **APEX: Security review** —
    - `show` verb: if user passes `../etc/passwd` as turn-id, does path resolution escape captures dir? (Defense: validate turn_id matches `[a-zA-Z0-9_-]+` regex before path.join)
    - `recent` verb: no path traversal concerns (only reads captureDir)
    - I9 directive restore: captures stay in correct project, no cross-project leak
    - I6 hard-timeout: no way to skip the timeout via env var or flag (security: must be unconditional)
    **Must pass P0/P1.**

11. **ANALYZER: Code improvement review** — **Must be C or above.**

## Finalize

12. **ARCHITECT: Commit** with message:
    ```
    feat(phase3+5): hard-timeout, learn-now verb, LLM skip, directive preservation, recent/show CLI, bug cleanup
    ```

## Acceptance Criteria

After v17:
- `npm run test` → 0 failures (B11 + B12 fixed)
- `npm run build` → 0 warnings (B10 fixed)
- `claude-sop --help` lists `revert` (B9 fixed)
- `claude-sop learn-now --dry-run` works (I7)
- `claude-sop recent` shows last hour of turns (C1)
- `claude-sop show <turn-id>` shows full turn (C2)
- Hourly tick with no new turns → 0 LLM calls, `llm_skipped: 'no_new_turns'` in recap (I8)
- Uninstall + reinstall → old directives restored (I9)
- Learner hung at 700s → hard-killed at 600s (I6)
- Phase 3: **100%** (LEARN-01..08 all satisfied)
- Phase 5: **50%** (C1+C2 done, P1-P6 remain for v18)

## Post-plan steps for the user

```bash
cd ~/Developer/claude-sop
git log --oneline -3
npm run build          # 0 warnings now
npm run test           # 0 failures now
npm run test:smoke

npm pack && npm i -g ./claude-sop-*.tgz

# I9 directive preservation test
cd ~/Developer/wrbeautiful-shopify-theme
# Assume 6 active directives exist in CLAUDE.md
claude-sop uninstall
test -f .claude-sop/state/directive-history.json && echo "✅ history preserved"
claude-sop install
tail -30 CLAUDE.md
# Expect: 6 directives restored (not "No recurring patterns detected yet")

# I7 learn-now
claude-sop learn-now --dry-run
claude-sop learn-now                    # alias for recap --run
claude-sop learn-now --offline          # rule-based only
claude-sop learn-now --force-llm        # force LLM even if no new turns

# C1 recent
claude-sop recent                       # last 1h
claude-sop recent --since 24h           # last day
claude-sop recent --json | jq

# C2 show
claude-sop recent --json | jq -r '.turns[0].turn_id' | xargs claude-sop show

# B9 revert visible in help
claude-sop --help | grep revert

# I8 LLM skip test
# Idle state (no new turns)
claude-sop learn-now
tail -2 ~/.claude-sop/logs/recap.log | jq '.llm_skipped'
# Expect: "no_new_turns"
```

## Out of Scope for v17

- Phase 5 packaging (P1-P6) → v18
- Phase 6 SaaS → v19+
- Phase 7 smart directive targeting → v24+
- LLM prompt refinement (if directive quality issues surface during dogfood) → future plan
- Web UI for `show` (browser rendering of turn content) → v19+ dashboard
- Cross-project `recent` (all projects at once) → future enhancement

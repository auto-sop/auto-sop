# Phase 1: Capture Foundation — Commander Execution Plan

## Overview

Ships the Claude Code hook shim binary + detached writer that together take raw stdin from hook events (UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop) and produce scrubbed, atomically-visible turn directories on disk. Uses Phase 0 libraries (PathResolver, Config, Scrubber, zero-network test harness) that are already shipped. Does NOT wire hooks into `settings.json` (Phase 2), does NOT run a learner (Phase 3), does NOT touch CLAUDE.md (Phase 4).

## Architecture Decisions (from CONTEXT.md + RESEARCH.md)

- **Double-fork detached writer.** Shim writes raw stdin to `~/.claude-sop/tmp/<nanoid>.json` (0600), spawns writer via `spawn({detached:true, stdio:'ignore'}).unref()`, exits 0. Shim has zero Phase 0 imports — hot path stays trivial.
- **CRITICAL: A1 reframe.** Node cold-start is ~30ms; `<10ms` target is unreachable. Enforce **A3 CI gate**: p50<20ms, p95<35ms, p99<50ms (all under CAPT-06's 50ms hard gate). Plan 01-02 ships the bench harness with **pre-authorized Go shim escape hatch** if the gate fails.
- **main.ts frozen after 01-03.** Wave 2 plans use a `routes/index.ts` thin-barrel pattern — each plan adds ONE re-export line. No main.ts collisions.
- **Turn dir lifecycle:** `<ts>-<agent>-<filehash>.pending/` created on UserPromptSubmit, renamed (dropped `.pending`) atomically on Stop/SubagentStop. 30s timeout fallback + 30min quarantine to `yarim-kalan/` for orphans.
- **tool-calls.jsonl** = separate `pre`/`post` lines joined on `tool_use_id` (stable Pre→Post per research). Single-writer-per-turn means no lockfile needed for turn-local files.
- **Large outputs** (>256KB) stream to `large-outputs/<tool_use_id>.txt.gz`, JSONL carries pointer.
- **Subagent linking:** bidirectional `parent_turn_id` + `children_turn_ids`, dual representation (flat in parent tool-calls AND own turn dir).
- **Errors:** project + global `errors.jsonl` with 10MB→.1 rotation. 50% disk auto-pause via `paused.flag`.
- **Global mirror:** JSONL index only (`~/.claude/sop/<hash12>/index.jsonl`), NOT full copy. Auto-migrate on `PathResolver.detectMove()`.
- **dev-army namespace (F4):** when project path is under `~/.claude/dev-army/`, global mirror namespace becomes `~/.claude/sop/dev-army/<agent-name>/`.
- **Kill-switch (D3):** `CLAUDE_SOP_LEARNER=1` → shim exits immediately, writer exits immediately. Defense in depth.
- **Zero new npm deps** — everything already in package.json from Phase 0.

## Implementation Tasks

### Wave 1 — Foundations (parallel)

**1. ARCHITECT: Plan 01-01 — Types, schemas, kill-switch, paths**
Ref: `.planning/phases/01-capture-foundation/01-01-PLAN.md`
Files: `src/capture/{events,types,kill-switch,paths}.ts` + unit tests
Requirements: Pure-logic leaf modules (Zod schemas for all 5 hook events, TurnMeta type matching CONTEXT C3, kill-switch check function, capture path derivation). Zero-dep. No Phase 0 imports.
Acceptance: All unit tests pass; source-level imports verified; no build output required at this wave.

**2. ARCHITECT: Plan 01-02 — Shim skeleton + bench harness + CI gate**
Ref: `.planning/phases/01-capture-foundation/01-02-PLAN.md`
Files: `src/capture/shim/{main,main-bench,handoff,shim-config}.ts` + `scripts/bench-shim.mjs` + `.github/workflows/bench-shim.yml`
Requirements: Two tsup entrypoints (prod `shim.cjs` + `shim-bench.cjs`). Prod shim has ZERO test branches — grep assertion on dist/. Bench spawns real minimal Node writer stub (`/tmp/bench-writer-stub.cjs` with `process.exit(0)`) to measure true Node→Node spawn cost. CI enforces A3 gate (p50<20 / p95<35 / p99<50) on ubuntu-latest.
Acceptance: Bench passes A3 gate on local+CI. **ESCAPE HATCH:** if p95>35ms, switch shim to Go binary (`go build -ldflags='-s -w'`) dropped into `dist/bin/claude-sop-shim-<platform>` — Wave 2 plans are unaffected (only shim language changes).

### Wave 2 — Writer features (parallel, enabled by routes/ barrel)

**3. ARCHITECT: Plan 01-03 — Writer core + routes dispatcher**
Ref: `.planning/phases/01-capture-foundation/01-03-PLAN.md`
Files: `src/capture/writer/{main,turn-dir,meta,session-state,prompt-response,files-changed}.ts` + `src/capture/writer/routes/{index,types,main-thread-route,pre-start-hooks,finalize-hooks}.ts` + `src/capture/writer/errors.ts` (stub, overwritten by 01-05) + unit tests
Requirements: Owns `main.ts` — **frozen after this plan**. Ships typed route dispatcher `const routes: Record<HookEventName, Handler>`. Handles UserPromptSubmit (turn-dir `.pending` creation) + Stop (finalize + rename). Pre/Post/SubagentStop are stubs that call `logUnhandled(eventName)` writing sentinel file `unhandled-event.<name>`. Integrates Phase 0 Scrubber on prompt.md + response.md. `files-changed.txt` via `git diff --name-only HEAD`. meta.json matches CONTEXT C3 byte-exact. 0600/0700 perms enforced.
Acceptance: UserPromptSubmit + Stop round-trip test produces correct turn directory with scrubbed content; `.pending` → rename atomic; SUMMARY documents "readers MUST ignore `.pending` entries".

**4. ARCHITECT: Plan 01-04 — tool-calls + large-outputs route**
Ref: `.planning/phases/01-capture-foundation/01-04-PLAN.md`
Files: `src/capture/writer/tool-calls.ts` + `src/capture/writer/large-outputs.ts` + `src/capture/writer/routes/tool-calls-route.ts` + ONE LINE re-export added to `routes/index.ts`
Requirements: Pre/post JSONL lines joined on `tool_use_id`. Single-writer-per-turn — plain `appendFileSync`, NO lockfile. Large output threshold 256KB → `large-outputs/<tool_use_id>.txt.gz` with `{"output_ref":"...","bytes":N}` pointer in JSONL. Scrubber runs on both inline + large outputs. **main.ts is NEVER edited.**
Acceptance: Unit tests verify pre/post join, large-output offload, scrubbing; grep assertion confirms `proper-lockfile` NOT imported by this plan.

**5. ARCHITECT: Plan 01-05 — errors + disk-budget**
Ref: `.planning/phases/01-capture-foundation/01-05-PLAN.md`
Files: `src/capture/writer/errors.ts` (overwrites 01-03's stub) + `src/capture/writer/disk-budget.ts` + appends `registerPreStartHook` call in `src/capture/writer/routes/pre-start-hooks.ts` + unit tests
Requirements: Project + global `errors.jsonl`, 10MB cap → single `.1` rotation. `disk-budget.ts` sums `.claude-sop/captures/` via `du` equivalent; 50% threshold (default 1GB of 2GB cap) flips `paused.flag`; writer checks on pre-start hook and skips capture if flag present. Shim still exits 0 (CAPT-07). **main.ts is NEVER edited** — 01-03 already has `let errorWriter: ErrorWriter | null = null; try{…}catch(e){errorWriter?.(e)}` late-binding; this plan ships `initErrorWriter()`.
Acceptance: Error lines append with rotation; disk pause triggers; status integration-testable.

**6. ARCHITECT: Plan 01-06 — Global mirror + dev-army namespace**
Ref: `.planning/phases/01-capture-foundation/01-06-PLAN.md`
Files: `src/capture/writer/global-mirror.ts` + `src/capture/writer/routes/global-mirror-hook.ts` + ONE LINE re-export added to `routes/index.ts`
Requirements: Append one line per finalized turn to `~/.claude/sop/<hash12>/index.jsonl`. **JSONL index only — NOT full copy.** Uses `proper-lockfile` ONLY for this global index (multi-project concurrent writers). dev-army namespace detection: if project path is under `~/.claude/dev-army/<agent-name>/`, route to `~/.claude/sop/dev-army/<agent-name>/` instead. Wires `PathResolver.detectMove()` directly (already exported from Phase 0) — NO "deferred with TODO" escape. **main.ts is NEVER edited.**
Acceptance: Integration test verifies index line per turn, dev-army namespace fires for paths under `~/.claude/dev-army/`, move migration renames global dir atomically.

**7. ARCHITECT: Plan 01-07 — Subagent linking + orphan sweep**
Ref: `.planning/phases/01-capture-foundation/01-07-PLAN.md`
Files: `src/capture/writer/subagent.ts` + `src/capture/writer/orphan-sweep.ts` + `src/capture/writer/routes/subagent-route.ts` + ONE LINE re-export added to `routes/index.ts`
Requirements: Bidirectional `parent_turn_id` + `children_turn_ids` linking (E2). Dual representation — subagent I/O flat in parent's tool-calls.jsonl AND own turn directory (E3). Unlimited nesting depth (E1). Orphan sweep runs as a pre-start hook on every UserPromptSubmit: any `.pending` turn dirs older than 30s finalize with `finalization_reason="timeout"`; older than 30min move to `yarim-kalan/`. Also sweeps stale `~/.claude-sop/tmp/*.json` payloads. **main.ts is NEVER edited.**
Acceptance: Nested subagent scenario produces linked turn dirs; orphan sweep tests cover both 30s and 30min thresholds.

### Wave 3 — Integration + traceability

**8. ARCHITECT: Plan 01-08 — End-to-end integration suite**
Ref: `.planning/phases/01-capture-foundation/01-08-PLAN.md`
Files: `tests/capture/integration/**`
Requirements: 7 fixture JSONL scenarios (main-only turn, tool-heavy turn, subagent nesting, large-output, kill-switch, orphan, dev-army namespace). Runs the built shim+writer end-to-end in memfs+temp HOME. Asserts every ROADMAP Phase 1 success criterion directly (meta.json schema, 0600/0700 perms, scrubber hit counts, subagent linking, global index entries, kill-switch zero-write behavior). **Includes W2 mid-stream assertion:** while Pre/Post events stream (before Stop), `readdirSync(capturesDir).filter(n => !n.endsWith('.pending'))` MUST return empty.
Acceptance: Full test suite green; traceability table in test output maps each assertion to CAPT-01..10 + PRIV-04 + PRIV-07.

## Quality Gates (MANDATORY — in order)

**9. YODA: Code review**
All Phase 1 source files (`src/capture/**`) + tests. Must verify: TypeScript strict mode passes, error handling consistent, no phase-0 imports in shim hot path, route dispatcher pattern honored, main.ts untouched after 01-03, scrubber integration correct.

**10. APEX: Security review**
Must verify: 0600/0700 perms enforced on write, no network egress from writer code paths (zero-network stub harness passes), scrubber runs BEFORE any disk write, no secrets leak to errors.jsonl, `CLAUDE_SOP_LEARNER=1` kill-switch honored in both shim and writer, no user-controlled path traversal in turn dir naming.

**11. ANALYZER: Code improvement review**
Blocks on D/F grade. Readability, performance (especially the writer hot-ish path after scrub), best practices, no duplication across routes.

(No PRISM — Phase 1 has zero UI work.)

## Finalize

**12. ARCHITECT: Commit all changes**
Only after YODA + APEX + ANALYZER all PASS. Commit message: `feat(phase1): capture foundation — hook shim + detached writer + turn directories`.

## Acceptance Criteria (goal-backward from ROADMAP Phase 1)

- [ ] **CAPT-01..04:** Given fixture hook events (UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop), integration test produces expected turn directory with all 5 events captured correctly
- [ ] **CAPT-05:** Capture dir schema matches spec: `<ts>-<agent>-<filehash>-<shorthash>/` containing `prompt.md`, `response.md`, `tool-calls.jsonl`, `files-changed.txt`, `meta.json`
- [ ] **CAPT-06:** CI bench gate asserts shim p50<20ms / p95<35ms / p99<50ms (well under the 50ms hard gate)
- [ ] **CAPT-07:** Shim always exits 0 (verified in bench + integration tests); errors logged to `errors.jsonl`
- [ ] **CAPT-08:** Readers skipping `.pending` entries sees zero mid-turn directories (integration test asserts mid-stream `readdirSync` filter = empty)
- [ ] **CAPT-09:** Subagent `Task` calls captured with bidirectional linking; nested subagent fixture produces parent+child turn dirs linked via `parent_turn_id` / `children_turn_ids`
- [ ] **CAPT-10:** Global mirror `~/.claude/sop/<hash12>/index.jsonl` contains one line per finalized turn (or dev-army namespace path for projects under `~/.claude/dev-army/`)
- [ ] **PRIV-04:** All capture files `0600`, all capture dirs `0700` (integration audit asserts via `fs.stat().mode`)
- [ ] **PRIV-07:** With `CLAUDE_SOP_LEARNER=1` set, shim exits immediately, writer exits immediately, zero writes observed
- [ ] **Zero new npm deps** — `package.json` diff shows no additions
- [ ] All unit + integration tests pass (100%)
- [ ] All quality gates approved (YODA + APEX + ANALYZER)

## Notes for Commander

- **Greenfield status:** `src/capture/` directory does not yet exist. ARCHITECT creates it.
- **Plan files contain full task XML** — dispatch each numbered task above by pointing ARCHITECT at the referenced plan file (`.planning/phases/01-capture-foundation/01-NN-PLAN.md`). The plan files are authoritative for <action>, <verify>, <done>.
- **Wave 1 tasks are TRULY parallel** — 01-01 and 01-02 share no files.
- **Wave 2 tasks are parallel** via the routes/index.ts barrel pattern — each plan adds exactly ONE re-export line to that file. Git/tsup handles the trivial merge.
- **Wave 3 runs after Wave 2 fully complete.**
- **Escape hatch trigger:** if Plan 01-02's bench fails the A3 gate, Commander should pause and notify the user before rewriting the shim in Go. Plans 01-03..08 are language-agnostic and unaffected.
- **Phase 2 is planned in the same session** — after Phase 1 executes and commits, the next plan (`PLAN-v3-phase2-installer-scheduler-cli.md`) will be ready in `plans/queued/`.

# PLAN-v9 — Phase 3 (MVP): Observable Learner Batch

## Overview

This is the first real Phase 3 slice. After v5–v8 shipped a stub `learner.cjs` that just writes `learner-stub v0.0.0 pid=...` to `ticks.log` on every launchd tick, Phase 3 replaces it with a **real batch that reads captures and produces observable output** — but without touching CLAUDE.md directives (saved for Phase 4 with the ManagedSectionEditor), without the recall gate (Phase 4), and without calling the Claude API by default (opt-in only).

**Goal:** after v9 ships, the user can run a real dev-army job in any installed project and `tail -f ~/.claude-sop/logs/recap.log` while it works. Every hour (or on-demand via `claude-sop recap`), the learner scans every installed project, processes new turns since its last cursor, and appends a JSON-line recap entry per project. The user sees the system alive in real time.

**Explicit non-goals for v9:**
- No writing to `<project>/CLAUDE.md`. The ManagedSectionEditor is a Phase 4 deliverable — one bug there is permanent trust loss per STATE.md, and it deserves its own isolated planning cycle.
- No recall gate. Injecting directives into `UserPromptSubmit` hooks is Phase 4 work.
- No automatic Claude API calls. A **toggleable** LLM mode exists via `CLAUDE_SOP_LEARNER_MODE=llm`, off by default. Even when on, the LLM output is appended raw to `recap.log` — no parsing, no directive generation.
- No pattern detectors beyond simple counters (turns, tool calls, scrubber hits, finalization failures). Rule-based detectors are Phase 4+.

## Architecture Decisions

### The learner runs in three layers

1. **Stub/real entry point** — `src/learner/main.ts` replaces `src/learner/stub.ts` as the tsup entry for `dist/plugin/learner.cjs`. Same bundling config as writer (`noExternal: [/.*/]`). Still fail-open — every error path exits 0.
2. **Per-project processing** — for each registered project, the learner locks a per-project cursor file, enumerates new finalized turn directories, parses `meta.json`, aggregates stats, advances the cursor, releases the lock.
3. **Recap writer** — appends one JSON-line-per-project recap entry to `~/.claude-sop/logs/recap.log`. Bounded file: rotated to `recap.log.1` when it exceeds 10 MB.

### Project registry

`~/.claude-sop/projects.json` is the authoritative list of installed projects. Schema:
```json
{
  "version": 1,
  "projects": [
    {
      "project_id": "69047161d614",
      "project_root": "/Users/ugurgokdere/Developer/wrbeautiful-shopify-theme",
      "project_slug": "wrbeautiful-shopify-theme",
      "installed_at": "2026-04-14T20:09:00.000Z",
      "claude_sop_version": "0.0.0"
    }
  ]
}
```

- `claude-sop install` appends/updates a project entry (idempotent on same project_id).
- `claude-sop uninstall` removes the matching project entry (keeps the file even if empty).
- The learner reads this file on every tick. If a registered `project_root` no longer exists (user deleted the project dir), the learner logs a warning and skips it but does NOT auto-deregister. Manual cleanup only — we do not want an hourly cron deleting state.
- File is locked with `proper-lockfile` on writes (install/uninstall paths). Reads are unlocked; the learner tolerates a mid-write inconsistent read by skipping and trying again next tick.

### Cursor per project

`<project>/.claude-sop/state/learner-cursor.json`:
```json
{
  "version": 1,
  "last_processed_turn_id": "DoImf09ZBZjL",
  "last_processed_at": "2026-04-14T22:00:03.412Z",
  "last_finalized_at": "2026-04-14T18:10:51.735Z"
}
```

- `last_processed_turn_id` + `last_finalized_at` — together form the cursor. Next run only processes turn dirs where `meta.finalized_at > last_finalized_at`, OR turns with a newer `finalized_at` even if `turn_id` differs.
- First run on a project: cursor file absent → process ALL existing finalized turns in one batch (bounded to N=500 to prevent unbounded memory on a stale box; older turns are skipped with a log line).
- Lockfile: `<project>/.claude-sop/state/learner-cursor.lock` via proper-lockfile. Held for the entire per-project pass. If another invocation holds the lock, skip this project for this tick and move on.
- Cursor writes are atomic: write to `.tmp`, fsync, rename.

### Recap.log format

Append-only JSON lines. Every tick produces **one line per project processed**. Schema:
```json
{"v":1,"t":"2026-04-14T22:00:00.000Z","tick_id":"ck-22h00","project_id":"69047161d614","project_slug":"wrbeautiful-shopify-theme","turns_new":5,"turns_total_seen":47,"tool_calls_new":23,"scrubber_hits_new":12,"files_changed_new":8,"finalization_failures_new":0,"oldest_new_turn_at":"2026-04-14T20:33:11.000Z","newest_new_turn_at":"2026-04-14T21:52:41.000Z","duration_ms":127,"llm_mode":false}
```

Plus one summary line per tick (across all projects):
```json
{"v":1,"t":"2026-04-14T22:00:00.000Z","tick_id":"ck-22h00","summary":true,"projects_processed":3,"projects_skipped":1,"projects_locked":0,"projects_missing":0,"total_turns_new":18,"total_duration_ms":412,"errors":0}
```

- `tick_id` groups per-project lines with the summary line so you can filter `jq 'select(.tick_id=="ck-22h00")'`.
- 10 MB rotation: before each append, stat the file; if > 10 MB, rename to `recap.log.1` (overwriting any existing .1), truncate, start fresh. Only one generation kept.

### LLM mode (toggleable, off by default)

If `process.env.CLAUDE_SOP_LEARNER_MODE === 'llm'`:
- After per-project stats are written, the learner spawns `claude -p --output-format json` once globally (NOT per project) with a prompt that includes the 20 most recent turns' `prompt.md` + `response.md` + `meta.json` excerpts (scrubbed — use `scrubber` from Phase 0).
- Output is appended to `recap.log` as a single line with `llm_output: <string>` + `llm_model`, `llm_cost_usd`, `llm_duration_ms` fields parsed from claude-p's JSON response.
- Timeout: 60 seconds. Crash-safe: if `claude` isn't on PATH or fails, log once and continue.
- **v9 does NOT parse the LLM response into directives.** It's observability only. The raw string goes into recap.log. Phase 4 teaches the learner to extract structured directives from it.
- **No automatic flip.** The env var must be set manually: `CLAUDE_SOP_LEARNER_MODE=llm claude-sop recap --run` for on-demand, or edit `~/Library/LaunchAgents/com.claude-sop.learner.plist` to add the env var for scheduled runs (document this in the recap verb's help text, don't automate it).

### New CLI verb: `claude-sop recap`

```
claude-sop recap                    # print last 10 recap lines from recap.log (human format)
claude-sop recap --json             # same, but raw JSON lines
claude-sop recap --run              # invoke the learner NOW, then print new lines
claude-sop recap --run --llm        # invoke with CLAUDE_SOP_LEARNER_MODE=llm for this run only
claude-sop recap --tail             # tail -f equivalent, stream new lines
claude-sop recap --follow           # alias for --tail
```

Critical UX: during dogfood, waiting an hour between iterations is unacceptable. `claude-sop recap --run` lets the user kick a tick manually and watch output immediately. This is how we'll validate the plan.

### Bundling strategy (same as writer)

`tsup.config.ts` — change the existing `plugin/learner` entry:
- Input: `src/learner/main.ts` (new) instead of `src/learner/stub.ts` (deleted)
- `noExternal: [/.*/]` — bundle everything non-node
- Keep `banner: { js: '#!/usr/bin/env node' }` — already there
- Expected bundle size: 150–300 KB (proper-lockfile, zod, scrubber deps)

Postbuild already stages `dist/plugin/learner.cjs` via the existing script — no change needed.

### Fail-open policy (the single most important rule)

Every error at every layer is caught and logged to `~/.claude-sop/logs/errors.log` as a one-line JSON entry, then the learner continues. The process never exits non-zero, never throws uncaught, never blocks on a lock longer than 2 seconds. Specific cases:
- Malformed `projects.json` → log, treat as empty, exit 0
- Missing `project_root` on disk → log, skip project, advance to next
- Cursor lock held by another process → log `project_locked`, skip project, advance
- Parse error on `meta.json` → log, skip THAT turn, advance cursor past it anyway (poison-pill turns don't block progress)
- Recap.log write fails → log to errors.log, exit 0 (can't cascade)
- LLM mode on but `claude` not on PATH → log once, exit 0
- LLM mode on but claude-p timeout → log, exit 0

## Phase 0: Advisory

None. No HubSpot, no AWS, no UI.

## Implementation Tasks

### Wave 1 — Foundation (parallel-safe, but one ARCHITECT for coherence)

1. **ARCHITECT: Project registry read/write module**

   Files (NEW):
   - `src/learner/project-registry.ts`
     ```ts
     export interface ProjectRegistryEntry {
       project_id: string;
       project_root: string;
       project_slug: string;
       installed_at: string;
       claude_sop_version: string;
     }
     export interface ProjectRegistry {
       version: 1;
       projects: ProjectRegistryEntry[];
     }

     export function readRegistry(globalSopHome: string): ProjectRegistry;
     export function writeRegistry(globalSopHome: string, reg: ProjectRegistry): void;
     export function upsertProject(globalSopHome: string, entry: ProjectRegistryEntry): void;
     export function removeProject(globalSopHome: string, projectId: string): void;
     ```
   - All writes: `proper-lockfile` on `<globalSopHome>/projects.json.lock`, 5s timeout, retry 3x.
   - Reads are unlocked; catch `ENOENT` → return empty registry; catch JSON parse error → log + return empty registry.
   - Atomic writes: write to `.tmp`, fsync, rename.

   Requirements:
   - Read registry when file absent → returns `{version:1, projects:[]}`, no error.
   - Upsert on same `project_id` updates the existing entry in place (no duplicates).
   - Remove is a no-op if the project_id isn't in the registry.
   - All operations tolerate concurrent install/uninstall invocations without corruption (validated by a concurrent-write test in task 5).

   Acceptance:
   - Unit test (`test/learner/project-registry.test.ts`) covers: empty read, single write, upsert idempotent, remove absent (no-op), concurrent writes don't corrupt file (spawn 5 parallel `upsertProject` calls with different ids, assert all 5 end up in the final file).

2. **ARCHITECT: Wire install/uninstall into registry**

   Files (MODIFIED):
   - `src/installer/orchestrator.ts` — at the end of `runInstall`, call `upsertProject` with the project entry. On `runUninstall`, call `removeProject`. Wrap both in try/catch → log to errors.log → continue (install/uninstall must not fail if registry write fails; this is observability, not correctness).
   - `src/cli/verbs/install.ts`, `src/cli/verbs/uninstall.ts` — no changes needed if the orchestrator handles it internally.

   Requirements:
   - After `claude-sop install` in a new project, `~/.claude-sop/projects.json` contains the entry.
   - After `claude-sop uninstall` in that project, the entry is removed.
   - Re-installing same project does NOT create a duplicate entry (upsert semantics).
   - Installing project A, then project B, leaves both in the registry.

   Acceptance:
   - Integration test (add to existing install integration tests): install into a temp project, assert registry file contains it. Uninstall, assert entry removed. Re-install, assert no duplicates.

### Wave 2 — Learner core (depends on Wave 1)

3. **ARCHITECT: Per-project cursor module**

   Files (NEW):
   - `src/learner/cursor.ts`
     ```ts
     export interface LearnerCursor {
       version: 1;
       last_processed_turn_id: string | null;
       last_processed_at: string;       // ISO timestamp of last learner run
       last_finalized_at: string | null; // ISO timestamp of newest finalized turn processed
     }
     export function readCursor(projectStateDir: string): LearnerCursor;
     export function writeCursor(projectStateDir: string, cursor: LearnerCursor): void;
     export async function withCursorLock<T>(
       projectStateDir: string,
       fn: (cursor: LearnerCursor) => Promise<{ newCursor: LearnerCursor; result: T }>,
     ): Promise<T | null>;  // null = lock held elsewhere, skipped
     ```
   - Lock via proper-lockfile, 2s stale, 1s retry. If can't acquire in 2s, return null (caller logs `project_locked`).
   - Cursor file at `<projectStateDir>/learner-cursor.json`. Atomic write via `.tmp` + rename.
   - Missing cursor file → returns `{version:1, last_processed_turn_id:null, last_processed_at:"1970-01-01T00:00:00Z", last_finalized_at:null}`.

   Acceptance:
   - Unit test covers: read missing = default, read+write roundtrip, write is atomic (no partial files), lock contention returns null within 2.5s, nested lock from same process is rejected (proper-lockfile default).

4. **ARCHITECT: Turn scanner**

   Files (NEW):
   - `src/learner/turn-scanner.ts`
     ```ts
     export interface TurnSummary {
       turn_id: string;
       finalized_at: string;
       tool_call_count: number;
       scrubber_hit_count: number;
       files_changed_count: number;
       finalization_reason: string;
       agent: string;
     }
     export interface ScanResult {
       new_turns: TurnSummary[];   // sorted ascending by finalized_at
       total_seen: number;          // count of all finalized turn dirs in captures/
       skipped_unfinalized: number; // count of .pending directories (not counted)
       skipped_poison: number;      // count of meta.json parse failures
     }
     export function scanNewTurns(
       projectCaptureDir: string,
       cursor: LearnerCursor,
       maxTurns: number,
     ): ScanResult;
     ```
   - Walk `projectCaptureDir` at depth 1 (immediate children). Skip entries ending in `.pending`. For each directory, read `meta.json` inside; if missing or unparseable, increment `skipped_poison` and continue. If `meta.finalized_at > cursor.last_finalized_at` (string comparison works for ISO8601 Zulu), include it.
   - Sort by `finalized_at` ascending. Bound to `maxTurns` (500 for first run, else unbounded per tick — but we could add a cap if needed later).
   - Returns counts even when `new_turns` is empty.

   Acceptance:
   - Unit test with a fixture directory containing: 3 finalized turns, 1 `.pending`, 1 with missing `meta.json`, 1 with malformed JSON. Assert `new_turns.length === 3`, `skipped_unfinalized === 1`, `skipped_poison === 2`. Assert sorted ascending by `finalized_at`.
   - Test with a cursor pointing mid-list: asserts only turns newer than cursor are returned.

5. **ARCHITECT: Recap log writer**

   Files (NEW):
   - `src/learner/recap-log.ts`
     ```ts
     export interface PerProjectRecap {
       v: 1;
       t: string;
       tick_id: string;
       project_id: string;
       project_slug: string;
       turns_new: number;
       turns_total_seen: number;
       tool_calls_new: number;
       scrubber_hits_new: number;
       files_changed_new: number;
       finalization_failures_new: number;
       oldest_new_turn_at: string | null;
       newest_new_turn_at: string | null;
       duration_ms: number;
       llm_mode: boolean;
     }
     export interface TickSummary {
       v: 1;
       t: string;
       tick_id: string;
       summary: true;
       projects_processed: number;
       projects_skipped: number;
       projects_locked: number;
       projects_missing: number;
       total_turns_new: number;
       total_duration_ms: number;
       errors: number;
     }
     export function appendRecap(
       globalSopHome: string,
       lines: Array<PerProjectRecap | TickSummary>,
     ): void;
     ```
   - Rotation: stat `recap.log` before append; if > 10_000_000 bytes, rename to `recap.log.1` (overwriting any existing .1), then append to fresh file.
   - Atomic append: use `fs.appendFileSync` with `'a'` flag. JSON.stringify each line with no pretty-printing, one line per entry, newline separator.
   - Directory `<globalSopHome>/logs/` is created if missing.

   Acceptance:
   - Unit test: append 5 lines, read back, parse each as JSON, assert count + shape.
   - Rotation test: seed a 9.9 MB file, append one line → still in `.log`. Seed a 10.1 MB file, append one line → `.log.1` exists with old content, `.log` has just the new line.

### Wave 3 — Learner entry point (depends on Waves 1-2)

6. **ARCHITECT: Learner main — replaces stub**

   Files (NEW):
   - `src/learner/main.ts` — the real entry point. Pseudocode:
     ```ts
     async function main(): Promise<void> {
       const startedAt = Date.now();
       const tickId = `ck-${new Date().toISOString().slice(11,16).replace(':','h')}`;
       const globalSopHome = join(os.homedir(), '.claude-sop');

       // Pause check (reuses CLAUDE_SOP_PAUSED or pause flag file from v6)
       if (isLearnerPaused()) process.exit(0);

       const registry = readRegistry(globalSopHome);
       if (registry.projects.length === 0) {
         appendRecap(globalSopHome, [makeEmptySummary(tickId)]);
         process.exit(0);
       }

       const projectLines: PerProjectRecap[] = [];
       let processed = 0, skipped = 0, locked = 0, missing = 0, errors = 0;
       const llmMode = process.env.CLAUDE_SOP_LEARNER_MODE === 'llm';

       for (const project of registry.projects) {
         if (!existsSync(project.project_root)) { missing++; continue; }
         try {
           const result = await withCursorLock(join(project.project_root, '.claude-sop', 'state'), async (cursor) => {
             const scan = scanNewTurns(join(project.project_root, '.claude-sop', 'captures'), cursor, 500);
             const recap = buildRecapLine(project, scan, tickId, llmMode);
             const newCursor = advanceCursor(cursor, scan);
             return { newCursor, result: recap };
           });
           if (result === null) { locked++; continue; }
           projectLines.push(result);
           processed++;
         } catch (err) {
           logError('learner_project_failed', { project_id: project.project_id, err: String(err) });
           errors++;
         }
       }

       if (llmMode && projectLines.length > 0) {
         try {
           const llmLine = await runLlmBatch(projectLines, /* … */);
           projectLines.push(llmLine);
         } catch (err) {
           logError('learner_llm_failed', { err: String(err) });
         }
       }

       const summary: TickSummary = {
         v: 1, t: new Date().toISOString(), tick_id: tickId, summary: true,
         projects_processed: processed, projects_skipped: skipped,
         projects_locked: locked, projects_missing: missing,
         total_turns_new: projectLines.reduce((s, l) => s + (l.turns_new ?? 0), 0),
         total_duration_ms: Date.now() - startedAt,
         errors,
       };

       appendRecap(globalSopHome, [...projectLines, summary]);
       process.exit(0);
     }

     main().catch((err) => {
       try { logError('learner_fatal', { err: String(err) }); } catch {}
       process.exit(0);  // FAIL-OPEN, always
     });
     ```
   - Every try/catch exits 0 at the end. No non-zero exit path.
   - 2-minute hard timeout: if the learner itself takes longer than 120 seconds, abort and exit 0 (use `AbortController` + `setTimeout`). The hourly tick must NEVER overlap a previous invocation; proper-lockfile on `~/.claude-sop/learner.lock` guards it.

   Files (DELETED):
   - `src/learner/stub.ts` — replaced by `main.ts`. Delete the file.

   Files (MODIFIED):
   - `tsup.config.ts` — change `entry: { 'plugin/learner': 'src/learner/stub.ts' }` → `entry: { 'plugin/learner': 'src/learner/main.ts' }`. Add `noExternal: [/.*/]` to the learner entry (currently missing; stub didn't need it).

   Requirements:
   - Learner exits 0 on ALL paths (including thrown exceptions).
   - Empty registry → writes one summary line with `projects_processed: 0`.
   - First run on a project (no cursor) → processes up to 500 turns, writes a per-project line with accurate counts, creates cursor file.
   - Second run on same project → processes only new turns (no duplicates).
   - Hard timeout: learner guaranteed to exit within 120s even on a degenerate input.
   - Learner lock: `~/.claude-sop/learner.lock`. If already held, exit 0 with a single log line.

   Acceptance:
   - Manual smoke: `node dist/plugin/learner.cjs` from repo with real `~/.claude-sop/projects.json` pointing at wrbeautiful-shopify-theme exits 0 within 2s and appends lines to `~/.claude-sop/logs/recap.log`.
   - `tail -1 ~/.claude-sop/logs/recap.log | jq` shows a valid summary line.
   - Running twice in a row: second run shows `turns_new: 0` for projects with no new turns.

7. **ARCHITECT: LLM mode handler (feature-flagged, zero-cost by default)**

   Files (NEW):
   - `src/learner/llm-mode.ts`
     ```ts
     export async function runLlmBatch(
       projectLines: PerProjectRecap[],
       globalSopHome: string,
       tickId: string,
     ): Promise<Record<string, unknown>>;
     ```
   - Checks `which claude` on PATH; if absent, throws `ClaudeNotInstalled` which the caller catches.
   - Packages the last 20 turns (across all projects) into a prompt via `scrubber` — reads `prompt.md`, `response.md`, `meta.json` excerpts from each turn directory.
   - Spawns `execa('claude', ['-p', '--output-format', 'json'], { input: promptString, timeout: 60_000 })`.
   - Parses claude-p's JSON response, extracts `result`, `total_cost_usd`, `duration_ms`, `model`.
   - Returns a recap line with shape:
     ```json
     {"v":1,"t":"…","tick_id":"…","llm":true,"llm_model":"claude-…","llm_cost_usd":0.041,"llm_duration_ms":3821,"llm_output":"<raw string>","llm_input_turns":18}
     ```
   - The raw LLM output goes in `llm_output` without any parsing. Phase 4 will teach the learner to extract structured directives.

   Requirements:
   - This code path is NEVER reached unless `CLAUDE_SOP_LEARNER_MODE === 'llm'`.
   - Default launchd environment does NOT set this var (already verified — plist has `CLAUDE_SOP_LEARNER=1` for recursion guard, unrelated).
   - Timeout is strictly enforced at 60 seconds.
   - No file writes except the recap line emitted by the caller.
   - Total LLM output is truncated to 8 KB in the recap line (larger dumps go to `~/.claude-sop/logs/llm-transcripts/<tickId>.txt` for offline inspection).

   Acceptance:
   - Unit test: mock `execa` to return a fake claude-p JSON response, assert the recap line has the expected fields.
   - Integration test (SKIP on CI, enabled locally with `LLM_INTEGRATION=1 npm run test`): actually invokes `claude -p` with a small prompt, asserts a valid response comes back. Documented in the test name so skips are obvious.

### Wave 4 — CLI verb + tests (depends on Wave 3)

8. **ARCHITECT: `claude-sop recap` CLI verb**

   Files (NEW):
   - `src/cli/verbs/recap.ts` — registers with commander. Subcommands/flags:
     - `claude-sop recap` — reads last 10 lines from recap.log, pretty-prints in a human-readable table (columns: time, project, turns_new, total_seen, duration_ms). Exits 0 even if recap.log doesn't exist (prints "no recap history yet").
     - `claude-sop recap --json` — emits raw JSON lines to stdout (for piping to `jq`).
     - `claude-sop recap --run` — spawns the learner as a child process (`spawn(process.execPath, [learnerPath], { stdio: 'inherit' })`), waits for exit, then reads and prints the last N lines produced by this tick (filter by the `tick_id` in the new entries).
     - `claude-sop recap --run --llm` — same, but sets `CLAUDE_SOP_LEARNER_MODE=llm` in the child env for this run only.
     - `claude-sop recap --tail` / `--follow` — `tail -f` equivalent using `fs.watch` or simple poll-and-print loop. Ctrl+C exits cleanly.
     - `--limit <N>` flag for `recap` and `recap --run`, default 10.

   Files (MODIFIED):
   - `src/cli.ts` — register the verb alongside install/uninstall/status/doctor/etc.

   Requirements:
   - Table rendering reuses the existing `renderTable` helper from `src/cli/output/human.ts`.
   - `--json` output is one JSON object per line, no wrapping array.
   - `--run` exits with the learner's exit code (always 0) OR 1 if the spawn itself fails.
   - `--run --llm` prints a notice "LLM mode — may incur API costs" to stderr before spawning.
   - No new runtime deps.

   Acceptance:
   - `claude-sop recap --help` shows all flags
   - `claude-sop recap` on a fresh box prints "no recap history yet" and exits 0
   - After installing a project and running `claude-sop recap --run`, the command prints at least one line of output
   - `claude-sop recap --json` output is valid JSON lines (parseable by `jq -c`)

### Wave 5 — Smoke tests (MANDATORY regression guard)

9. **ARCHITECT: Isolated end-to-end learner smoke tests**

   Files (MODIFIED):
   - `test/smoke.test.ts` — add a new test group `smoke: learner batch end-to-end (isolated)`.

   Tests (all isolated in `tmpdir()` with no ancestor `node_modules`):

   (a) **Empty registry.** Seed `<tmpHome>/.claude-sop/projects.json` with `{version:1, projects:[]}`. Copy `dist/plugin/learner.cjs` into `<tmpHome>/bundle/`. Spawn `sh -c <tmpHome>/bundle/learner.cjs` with `HOME=<tmpHome>`. Assert exit 0, recap.log has exactly one line, that line has `summary: true` and `projects_processed: 0`.

   (b) **Single project, first run.** Seed a fake project at `<tmpHome>/fake-project/` with `.claude-sop/captures/` containing 3 fake finalized turn dirs (each with a valid `meta.json`). Register in `projects.json`. Run learner. Assert recap.log has 2 lines (per-project + summary), per-project line has `turns_new: 3`, cursor file created with `last_finalized_at` matching the newest of the 3.

   (c) **Second run shows cursor advancement.** After (b), without adding new turns, run learner again. Assert the second tick appends 2 new lines, per-project line has `turns_new: 0`, summary has `total_turns_new: 0`.

   (d) **Add new turns, third run processes them.** After (c), drop a 4th turn dir into captures. Run learner. Assert per-project line has `turns_new: 1`.

   (e) **Missing project root.** Seed a project entry where `project_root` points to `<tmpHome>/nonexistent`. Run learner. Assert exit 0, summary has `projects_missing: 1`, no crash.

   (f) **Poison meta.json.** Seed a project with 2 valid turns + 1 turn dir where `meta.json` is invalid JSON. Run learner. Assert per-project line has `turns_new: 2` (valid ones processed), `skipped_poison: 1` (exposed via a new field in the recap line — add this field to the schema in task 5 if missing).

   (g) **Lock contention.** Acquire the cursor lock manually via `proper-lockfile`, then run the learner. Assert summary has `projects_locked: 1` and the learner does not hang beyond 3 seconds total.

   (h) **Log rotation.** Pre-seed `<tmpHome>/.claude-sop/logs/recap.log` with 11 MB of content. Run learner. Assert `recap.log.1` now exists with the old content, `recap.log` has only the new tick's lines.

   (i) **Fail-open on broken registry.** Seed `projects.json` with invalid JSON. Run learner. Assert exit 0, errors.log has a `registry_parse_failed` entry, recap.log has an empty summary line.

   (j) **Bundle bare-require regression guard.** Scan `dist/plugin/learner.cjs` for bare non-node requires (same grep logic as v8's writer assertion). Zero bare requires allowed.

   Requirements:
   - Every test uses `HOME=<tmpHome>` and copies the bundle out of the repo (isolated from repo's node_modules).
   - Every test cleans up its tmpdir in `afterEach`/`afterAll`.
   - Tests must fail loudly if the learner crashes (even though it exits 0, the test asserts specific recap line counts/shapes).
   - Reverting task 6's `noExternal: [/.*/]` must cause test (j) to fail.

   Acceptance:
   - `npm run test:smoke` passes with a total test count ≥ 28 (20 current + 8-10 new learner tests).
   - Isolated tests complete in <15 seconds total.

10. **ARCHITECT: Unit tests for modules (wave 1-2 deliverables)**

    Files (NEW):
    - `test/learner/project-registry.test.ts` — covered in task 1
    - `test/learner/cursor.test.ts` — covered in task 3
    - `test/learner/turn-scanner.test.ts` — covered in task 4
    - `test/learner/recap-log.test.ts` — covered in task 5

    Requirements:
    - Run via `npm run test` (not just `test:smoke`). Add to the existing vitest config if needed.
    - Each module has ≥3 tests covering happy path + 2 edge cases.

    Acceptance:
    - `npm run test` passes.
    - Coverage for `src/learner/` is ≥ 80% (measured via `vitest --coverage`).

## Quality Gates (MANDATORY)

11. **YODA: Code review** — focus on:
    - Fail-open policy: every function that could throw is wrapped
    - Lock hygiene: every lock acquire has a release on all paths (try/finally)
    - No leftover debug logs, no console.log left in production code
    - Cursor logic correctness: first run behavior vs. subsequent runs
    - LLM mode code path: confirm it's ONLY reached when env var is set; confirm default launchd environment does NOT set it
    **100% approval required.**

12. **APEX: Security review** —
    - Registry file: any chance of writing outside `~/.claude-sop/`? (No — paths are constructed from `os.homedir()`.)
    - Cursor file: any chance of path traversal via `project_root` values from registry? (Registry entries come from the installer, which validates paths. But we should defensively `path.resolve` + assert no `..` segments before using any registry path.)
    - LLM mode: scrubber must fire on prompt content before sending to `claude -p`. Verify by code review, not just test.
    - `recap.log`: bounded to 10 MB (rotation). Verify disk-fill attack is not possible.
    - Timeout enforcement: 2-minute hard cap on the entire learner, 60-second cap on LLM subprocess.
    **Must pass P0/P1.**

13. **ANALYZER: Code improvement review** —
    - Grade the learner main.ts + submodules. Must be C or above.
    - Flag any code duplication between the learner and the writer (e.g. error logging, path resolution). If significant, extract to a shared util.

(No PRISM: no UI surface.)

## Finalize

14. **ARCHITECT: Commit** with message:
    ```
    feat(phase3): observable learner batch — project registry, cursor, recap.log, recap verb
    ```

## Acceptance Criteria (POC-level validation)

After this plan lands AND the user runs the post-plan refresh sequence, ALL of these hold:

- `npm run build && npm run test:smoke && npm run test` all pass
- `dist/plugin/learner.cjs` size ≥ 150 KB (bundled), grep for bare non-node requires returns zero
- `~/.claude-sop/projects.json` exists after `claude-sop install`, contains the project entry
- Manual `claude-sop recap --run` produces output within 5 seconds, `recap.log` grows by N+1 lines (N projects + 1 summary)
- `claude-sop recap` prints human-readable table of last 10 lines
- `claude-sop recap --run --llm` works if `claude` is on PATH (may print LLM output or fail gracefully if not configured)
- Running dev-army on a real project while `tail -f ~/.claude-sop/logs/recap.log` is running shows new recap lines every hour (or instantly via `--run`)
- No crashes in `~/.claude-sop/logs/errors.log` beyond expected warning-level entries

## Post-plan steps for the user

```bash
# 1. Build, test, pack, install
cd ~/Developer/claude-sop
npm run build
npm run test:smoke
npm run test                   # new unit tests for learner modules
wc -c dist/plugin/learner.cjs  # expect ≥ 150 KB (was 442 bytes as stub)
npm pack
npm i -g ./claude-sop-0.0.0.tgz

# 2. Clean state (optional — only if you want a fresh start)
launchctl bootout "gui/$UID/com.claude-sop.learner" 2>/dev/null || true
rm -rf ~/.claude-sop/marketplace/claude-sop
rm -f ~/.claude-sop/logs/recap.log*
rm -f ~/.claude-sop/projects.json

# 3. Install into wrbeautiful-shopify-theme (or any project)
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop install
cat ~/.claude-sop/projects.json      # expect the project entry
claude-sop doctor                    # still 9/9 ok

# 4. Manual learner run (INSTANT feedback, no need to wait an hour)
claude-sop recap --run
# expect: spawns learner, prints the new recap lines, exit 0
# recap.log now has at least 2 lines (per-project + summary)

# 5. Real dev-army experiment
#    In one terminal:
tail -f ~/.claude-sop/logs/recap.log | jq
#    In another terminal:
cd ~/Developer/wrbeautiful-shopify-theme
army-start
#    Give Commander a real plan; let it work.
#    Every time you want a snapshot:
claude-sop recap --run
#    Or wait for the hourly tick to fire naturally.

# 6. Optional — enable LLM mode for one run
CLAUDE_SOP_LEARNER_MODE=llm claude-sop recap --run
# expect: learner calls claude -p, recap.log has an llm line with output
# If you don't have claude on PATH or the call fails, the learner still exits 0
# and logs a warning to errors.log.
```

## Out of Scope (explicit non-goals)

- Writing directives to `<project>/CLAUDE.md`. **Phase 4.**
- ManagedSectionEditor. **Phase 4.**
- Recall gate (injecting directives into UserPromptSubmit). **Phase 4.**
- Automatic LLM mode enablement. User must flip env var manually.
- Parsing LLM output into structured directives. **Phase 4.**
- Pattern detection beyond counters (repeated failures, revert loops, etc.). **Phase 4.**
- Per-project recap rotation policy. One global recap.log for MVP.
- Cross-project aggregate statistics beyond the per-tick summary line.
- Retention policy for old turns in `<project>/.claude-sop/captures/`. Out of scope for Phase 3; will be a separate Phase 2.5 or Phase 3.5 cleanup.

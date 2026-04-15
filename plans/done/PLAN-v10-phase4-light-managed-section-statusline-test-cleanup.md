# PLAN-v10 — Phase 4-Light: ManagedSectionEditor + Sample Directive + Statusline + Test Cleanup

## Overview

v9 shipped the observable learner batch — the learner now reads captures, tracks cursors per project, and writes JSON recap lines to `~/.claude-sop/logs/recap.log`. But **nothing appears in the user's project files yet**. The feedback loop isn't closed because the learner writes to a log, not to `<project>/CLAUDE.md`.

v10 closes the write side of the loop **without** closing the full learning loop:

1. **ManagedSectionEditor** — a hardened, idempotent, backed-up writer for `<project>/CLAUDE.md` that owns a marker-bounded section and atomically rewrites only its content. This is the single highest-risk piece of the product (STATE.md: "one bug = permanent trust loss"), so it gets its own module, its own tests, and its own hardening.
2. **Sample directive writer** — after every learner tick, emit a **hardcoded placeholder directive block** to `CLAUDE.md` via ManagedSectionEditor. No pattern detectors, no LLM calls. The block shows turn count + agent roster + timestamp, so the user can see the plugin is alive by just looking at CLAUDE.md.
3. **Statusline verb** — `claude-sop statusline` prints `[sop:on]` or `[sop:off]` based on whether the current directory has claude-sop hooks wired. Zero automatic global-settings mutation — user opts in by adding one line to their Claude Code config.
4. **Test cleanup** — fix the 14 failures v9 exposed in `npm run test`: (a) exclude `smoke.test.ts` from the default vitest run because it gets clobbered by parallel integration tests, and (b) update 3 stale assertions in `test/cli/verbs/doctor.test.ts` that still expect v5 managed-section semantics (fixed in v6 but tests weren't updated).

**Explicit non-goals** (saved for v11 and v12):
- **No pattern detectors.** The sample directive is hardcoded. v11 adds rule-based detection.
- **No LLM-driven directive generation.** v9 already has a toggleable LLM mode; v10 does not change it.
- **No recall gate.** Injecting directives into `UserPromptSubmit` hooks is v12.
- **No changes to `~/.claude/settings.json`.** Statusline is opt-in.

## Architecture Decisions

### ManagedSectionEditor design (the single most important piece)

Lives at `src/managed-section/editor.ts`. Exported API:

```ts
export interface ManagedSectionContent {
  body: string;            // markdown body (without markers)
}

export interface WriteResult {
  verdict: 'created' | 'updated' | 'unchanged' | 'dry_run';
  claudeMdPath: string;
  backupPath: string | null;
  bytesBefore: number;
  bytesAfter: number;
  markersPresent: 'before_write' | 'after_write';
}

export interface WriteOptions {
  projectRoot: string;
  content: ManagedSectionContent;
  dryRun?: boolean;   // if true, computes new content but writes nothing
}

export function writeManagedSection(opts: WriteOptions): WriteResult;
export function readManagedSection(projectRoot: string): ManagedSectionContent | null;
export function removeManagedSection(projectRoot: string): void;
```

**Marker format (exact strings — any change to these breaks idempotency):**
```
<!-- claude-sop:managed-section:begin v1 -->
<!-- GENERATED - DO NOT EDIT. claude-sop owns this section. -->

<body>

<!-- claude-sop:managed-section:end -->
```

- `v1` in the begin marker locks the format. If we ever need to change the format, bump to `v2` and have the editor migrate `v1` sections.
- The marker lines are literal bytes. No regex permissiveness. Exact match required on read/remove.
- The body between markers is owned exclusively by the editor. User edits to anything inside the markers are discarded on next write (this is documented in the DO NOT EDIT line).

**Write algorithm:**

1. **Resolve target.** `claudeMd = path.join(projectRoot, 'CLAUDE.md')`.
2. **Read current content.** If `ENOENT`, set `current = null`. Any other error → throw (caller catches).
3. **Find existing markers** by exact string search in `current`. If found, extract start/end byte offsets.
4. **Construct new content:**
   - If no current file: `newContent = headerTemplate() + '\n\n' + buildSection(content)` where `headerTemplate()` is a minimal `# CLAUDE.md\n\n_Project-level instructions for Claude Code._\n\n` block.
   - If current exists, no markers present: `newContent = current.replace(/\n*$/, '\n\n') + buildSection(content)` — append to end with two newlines separating.
   - If current exists, markers present: slice out the old section (including both markers), splice in the new section.
5. **Dry-run short-circuit:** if `opts.dryRun`, return `{verdict: 'dry_run', bytesBefore, bytesAfter: newContent.length, ...}` WITHOUT writing anything. Caller is responsible for printing the diff.
6. **Backup.** If current file exists AND new content differs from current, write current to `<projectRoot>/.claude-sop/state/CLAUDE.md.backup`. Single-generation — overwrite any existing backup. `mkdir -p` the state dir first.
7. **Unchanged short-circuit.** If `newContent === current`, return `{verdict: 'unchanged'}`. No write, no backup touch.
8. **Atomic write.** Write to `claudeMd + '.tmp'`, `fsync`, `rename` to `claudeMd`. Mode 0o644.
9. **Verdict.** Return `created` if no original file, else `updated`.

**Read algorithm:** open CLAUDE.md, find exact begin/end markers, slice the body between them, strip the "GENERATED" comment line and surrounding whitespace. Return `null` if file doesn't exist or markers absent.

**Remove algorithm:** if markers present, splice them out (including both markers + trailing blank line), write back atomically. If markers absent, no-op.

**Defensive invariants enforced in tests:**
- Idempotent: calling `writeManagedSection` with the same content twice produces identical bytes both times (`verdict: 'unchanged'` on second call).
- Marker uniqueness: if a user manually duplicates the markers (weird but possible), the editor refuses to write and throws `AmbiguousMarkersError`. Caller logs and skips.
- Byte preservation outside markers: any text outside the markers is preserved byte-for-byte across writes (test with Unicode, CRLF, emoji, trailing whitespace).
- Backup atomicity: backup is written BEFORE the main file, so a crash between backup-write and main-write leaves the old CLAUDE.md intact.
- Dry-run never touches disk: test asserts zero filesystem mutations after a dry-run call (including no tmp files, no backup file, no state dir creation).

### Sample directive content (Q1 answer — option B)

The learner calls `writeManagedSection` with a body like:

```markdown
_Last updated: 2026-04-14T22:20:00Z · 47 turns analyzed · 3 agents: main, commander, architect-principal-engineer_

**Learnings**

_No directives generated yet — pattern detection ships in the next version._
```

- Timestamp: ISO format, same as recap.log entries
- Turn count: `turns_total_seen` from the current tick's per-project recap line
- Agent roster: deduplicated list of `agent` values from all `meta.json` files under `<project>/.claude-sop/captures/` (read once per tick, cached in the scan pass)
- Body is deterministic given same inputs — running twice with same data produces byte-identical bytes (matters for `verdict: 'unchanged'`)

The sample directive module lives at `src/learner/directive-builder.ts`:

```ts
export function buildSampleDirective(
  project: ProjectRegistryEntry,
  scan: ScanResult,
  nowIso: string,
): ManagedSectionContent;
```

### Wiring into the learner

`src/learner/main.ts` — after the existing per-project recap logic, add a write step:

```ts
if (!llmMode) {
  // Write the sample directive for this project, unless --dry-run was passed
  try {
    const content = buildSampleDirective(project, scan, nowIso);
    const result = writeManagedSection({
      projectRoot: project.project_root,
      content,
      dryRun: process.env.CLAUDE_SOP_LEARNER_DRY_RUN === '1',
    });
    recapLine.directive_written = result.verdict;  // new recap field
    recapLine.directive_bytes = result.bytesAfter;
    recapLine.directive_backup = result.backupPath !== null;
  } catch (err) {
    logError('directive_write_failed', { project_id: project.project_id, err: String(err) });
    recapLine.directive_written = 'error';
  }
}
```

- Failure is logged but does not abort the tick — per-project independence.
- `llmMode` is left untouched — v9's LLM code path does not write directives, it only appends raw output to recap.log.
- `CLAUDE_SOP_LEARNER_DRY_RUN=1` env flips dry-run mode. The CLI verb (next section) sets this env var when `--dry-run` is passed.

### Recap verb changes

`src/cli/verbs/recap.ts` — add two behaviors:

**1. `--dry-run` flag:**
```
claude-sop recap --run --dry-run
```
- Spawns the learner child with `env: { ...process.env, CLAUDE_SOP_LEARNER_DRY_RUN: '1' }`
- After the learner exits, reads the most recent tick's per-project lines and prints a summary table with the new `directive_written` column (values: `created`, `updated`, `unchanged`, `dry_run`, `error`)
- Additionally: for each project with `directive_written === 'dry_run'`, print a **diff block** showing what WOULD be appended to CLAUDE.md. Use `diff -u` or a minimal inline diff — do NOT spawn an external `diff` binary. Simple 3-line context is enough.

**2. New column in human table:**
The existing `claude-sop recap` table grows a column: `directive` (shows the `directive_written` verdict). Column width ~10 chars.

### Statusline verb

New verb at `src/cli/verbs/statusline.ts`:

```
claude-sop statusline
```

Output rules:
- Prints **exactly one line** to stdout, no trailing newline
- `[sop:on]` if current directory (or `--project <path>` if provided) has `.claude/settings.json` with at least one hook entry containing `claude-sop` as the command path substring
- `[sop:off]` otherwise
- Exits 0 in both cases
- `--json` flag outputs `{"on": true|false, "project_slug": "...", "turns_total": N}` — used if the user wants a richer statusline script

Critical constraint: **this verb is on the statusline critical path**, so it must be FAST. Target: <50ms total runtime on a cached box. Achieve by:
- Synchronous file reads only, no async overhead
- No child process spawns
- No network, no npm resolution
- No logging, no telemetry

Test: benchmark the verb, assert <100ms p95 over 10 runs. If slower, optimize — statusline that blocks the prompt is worse than no statusline.

**Install-time guidance:** `claude-sop install` output gains one new line after the existing result table:
```
tip: add `[sop:on]` indicator to Claude Code statusline:
     echo '{"statusLine":{"type":"command","command":"claude-sop statusline"}}' > ~/.claude/settings.json
     (merge with existing settings — do NOT overwrite)
```
Just informational. Install does NOT touch `~/.claude/settings.json` — the user decides.

### Test cleanup (v9's 14 failures)

**Fix 1: Exclude smoke.test.ts from default vitest run.**

`vitest.config.ts`:
```ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke.test.ts', '**/node_modules/**'],  // NEW
    setupFiles: ['test/setup/no-network.ts'],
    ...
  },
});
```

Rationale: smoke tests read built artifacts from `dist/plugin/` but `test/integration/phase2-e2e.test.ts` runs parallel and clobbers dist during its own install flow. Smoke tests are already run via `npm run test:smoke` which rebuilds first. Double-execution in `npm run test` adds no value and causes flakiness.

Package.json:
```json
"test": "vitest run",
"test:smoke": "npm run build && vitest run test/smoke.test.ts",
"test:all": "npm run test && npm run test:smoke"
```
- `npm run test` = unit + integration (no smoke)
- `npm run test:smoke` = smoke only, rebuilds first
- `npm run test:all` = everything, serial

**Fix 2: Update doctor test assertions to match v6 semantics.**

`test/cli/verbs/doctor.test.ts` — three tests currently failing:

a) `all checks pass → exit 0` — the fixture has zero directives and the old test expected this to still pass because managed-section-check was ok. But the fixture also didn't set up `~/.claude-sop/version.txt` correctly, so the "installed" check fails → exit 3. Fix: add version.txt to the fixture setup.

b) `JSON mode emits ok:true when all checks pass` — same root cause as (a). Same fix.

c) `zero directives → managed section check fails` — this test asserted **old v5 semantics** (0 directives = fail). v6 deliberately changed this to `0 directives = ok — no directives yet`. Fix: rename the test to `zero directives → managed section check OK (v6 semantics)` and flip the assertion to `expect(code).toBe(0)` + `expect(parsed.checks.find(c => c.name === 'managed section').status).toBe('ok')`.

**Fix 3: Smoke test passes `dist/plugin/*` staging before vitest run.**

Belt-and-suspenders: if a future integration test adds parallel dist mutation, also protect smoke by copying `dist/plugin/` into a tmpdir at test-group setup time and reading from there. Specifically in `test/smoke.test.ts`, the group-level `beforeAll` copies `dist/plugin/` into `<os.tmpdir()>/claude-sop-smoke-<pid>/bundle/` and every test in the group uses that tmpdir path instead of `ROOT/dist/plugin/`. This mirrors the v8 e2e pattern.

## Phase 0: Advisory

None.

## Implementation Tasks

### Wave 1 — ManagedSectionEditor (THE high-risk module; do this first, in isolation)

1. **ARCHITECT: ManagedSectionEditor module + comprehensive unit tests**

   Files (NEW):
   - `src/managed-section/editor.ts` — the module (API above)
   - `src/managed-section/markers.ts` — the exact marker strings + helper parse/build functions
   - `test/managed-section/editor.test.ts` — ≥20 test cases covering every invariant below

   Required test cases:
   - Create from scratch: no CLAUDE.md → writes file with header + section, verdict `created`, backup is `null`
   - Update existing section: CLAUDE.md has markers → body replaced, verdict `updated`, backup written
   - Append to existing no-markers file: user's CLAUDE.md preserved byte-for-byte above the new section, verdict `updated`
   - Idempotent write: same content twice → second call returns `unchanged`, no backup touch, no file change (assert mtime unchanged on second call)
   - Dry-run: returns `dry_run`, zero filesystem mutations (stat all paths before/after and assert identical)
   - Unicode body: emoji + multibyte chars preserved correctly
   - CRLF preservation: user content with CRLF line endings outside markers stays CRLF after write
   - Trailing whitespace preservation: tabs, spaces at EOL preserved in user content
   - Duplicate markers: CLAUDE.md has two `begin` markers → throws `AmbiguousMarkersError`
   - Unclosed markers: has begin but no end → throws `MalformedMarkersError`
   - Read on missing file: returns `null`
   - Read on file without markers: returns `null`
   - Remove on missing markers: no-op, no throw, no file change
   - Remove on present markers: markers + body removed, rest of file preserved
   - Backup written BEFORE main file (crash-safety test): use a write spy / fail injection to simulate crash after backup but before main write; assert backup has old content, original file untouched
   - Atomic rename: use `existsSync` on `.tmp` path immediately after write — should be gone (no leftover)
   - Very large CLAUDE.md (1 MB): handles without issue
   - Section at exact end of file with no trailing newline
   - Section with `<!--` in the body content (must not confuse marker parser — use exact string match, not regex)
   - Read-after-write roundtrip: `readManagedSection` returns the exact body that was written

   Acceptance:
   - All 20+ tests pass
   - Coverage for `src/managed-section/` ≥ 95%
   - No `any` types in the API surface
   - Errors are specific subclasses (`AmbiguousMarkersError`, `MalformedMarkersError`, etc.), not generic

   **DO NOT WIRE INTO LEARNER YET.** Task 2 consumes it.

2. **ARCHITECT: Wire editor into learner + directive-builder module**

   Files (NEW):
   - `src/learner/directive-builder.ts` — `buildSampleDirective(project, scan, nowIso)` producing the Q1-answer-B format

   Files (MODIFIED):
   - `src/learner/main.ts` — after per-project recap line is built, call `writeManagedSection` with the sample directive. Respect `CLAUDE_SOP_LEARNER_DRY_RUN=1` env. Catch all errors → log to `errors.log` → record `directive_written: 'error'` in the recap line.
   - `src/learner/recap-log.ts` — add fields to `PerProjectRecap`:
     ```ts
     directive_written?: 'created' | 'updated' | 'unchanged' | 'dry_run' | 'error' | null;
     directive_bytes?: number;
     directive_backup?: boolean;
     ```

   Requirements:
   - On first tick in a project with no CLAUDE.md → file is created with header + sample section, recap shows `directive_written: 'created'`
   - On subsequent ticks with same data → recap shows `directive_written: 'unchanged'` (because `turns_total_seen`, agent roster, and timestamp-rounded-to-second produce same body — WAIT: timestamp changes every second, so this would always be `updated`. FIX: round the `Last updated` timestamp in the directive body to the nearest MINUTE, so two ticks within the same minute produce identical body and trigger the `unchanged` verdict.)
   - When new turns finalize between ticks → recap shows `directive_written: 'updated'` and CLAUDE.md body has new counts
   - When `CLAUDE_SOP_LEARNER_DRY_RUN=1` → recap shows `directive_written: 'dry_run'`, CLAUDE.md is NOT touched, no backup is written
   - Errors in the editor module do not abort the tick — other projects still process

   Acceptance:
   - Unit test: mock the editor, call learner main with a fake registry, assert the editor was called with expected content per project
   - Integration test (isolated, following v8/v9 pattern): create tmpHome with 1 fake project + 3 fake turns → run learner → assert CLAUDE.md exists at `<tmpProject>/CLAUDE.md` with correct markers and body — including the turn count, agent roster, and a timestamp

3. **ARCHITECT: `claude-sop recap --run --dry-run` + directive column in table**

   Files (MODIFIED):
   - `src/cli/verbs/recap.ts` — add `--dry-run` flag (boolean), when present set `CLAUDE_SOP_LEARNER_DRY_RUN=1` in child env
   - After learner exits in dry-run mode, read the most recent tick's per-project lines and print:
     - The existing table (with new `directive` column)
     - For each project with `directive_written === 'dry_run'`, a unified-diff-style block showing the delta between current `CLAUDE.md` and what WOULD be written. Implementation: `diff -u`-style in pure JS (compute longest common subsequence on lines). Keep it simple — 3-line context is enough.

   - Modify the existing human-table output to include a `directive` column on per-project rows. Adjust column widths.

   Requirements:
   - `claude-sop recap --run` (no flag) writes directives normally and shows `directive` column
   - `claude-sop recap --run --dry-run` does NOT write, shows `directive` column with `dry_run` value, prints diff block per project
   - `claude-sop recap` (without `--run`) works as before, now with the new column
   - Dry-run exits 0 even when the diff is empty (nothing to show)

   Acceptance:
   - Manual: `claude-sop recap --run --dry-run` in dogfood project → prints diff showing the sample directive that would be added, CLAUDE.md unchanged on disk
   - Subsequent `claude-sop recap --run` (without dry-run) → CLAUDE.md now has the section

### Wave 2 — Statusline + test cleanup (can run in parallel with wave 1's task 3)

4. **ARCHITECT: `claude-sop statusline` verb**

   Files (NEW):
   - `src/cli/verbs/statusline.ts`
   - `test/cli/verbs/statusline.test.ts`

   Files (MODIFIED):
   - `src/cli.ts` — register the verb

   Requirements:
   - Synchronous only, <50ms on warm box (tested with a perf assertion: `expect(duration).toBeLessThan(100)` over 10 serial invocations in the test)
   - Reads `.claude/settings.json` from cwd (or `--project <path>`), parses, checks for any hook entry with `command` containing `claude-sop`
   - Prints `[sop:on]` (8 bytes, no trailing newline) if detected, `[sop:off]` (9 bytes, no trailing newline) otherwise
   - `--json` flag: outputs `{"on": bool, "project_slug": string|null, "project_root": string}` with no trailing newline
   - Exits 0 in both states
   - Errors (unreadable settings.json, permission denied, etc.) → treat as `[sop:off]`, exit 0 (fail-closed for statusline — never block the prompt)

   Acceptance:
   - Unit tests: mock fs, test each branch (on, off, missing file, malformed JSON, permission denied)
   - Perf test: 10 consecutive invocations all return in <100ms total runtime each
   - Integration test: create tmpHome with fake `.claude/settings.json` that includes a claude-sop hook, run the verb, assert stdout `[sop:on]`
   - Install output update: integration test for `claude-sop install` checks the output now contains the `tip: add [sop:on] indicator` line

5. **ARCHITECT: Vitest config exclusion + package.json scripts**

   Files (MODIFIED):
   - `vitest.config.ts` — add `exclude: ['test/smoke.test.ts', '**/node_modules/**']` (keep the existing `include`)
   - `package.json` — add `test:all` script, keep `test` and `test:smoke` semantics

   Requirements:
   - `npm run test` (new semantics) runs all tests EXCEPT smoke — fast, clean, no flakes
   - `npm run test:smoke` rebuilds first and runs only smoke tests
   - `npm run test:all` runs both sequentially: unit first, then smoke

   Acceptance:
   - `npm run test` completes with zero failures after the doctor test fix in task 6
   - `npm run test:smoke` completes with 30+ tests passing (existing v9 state)
   - `npm run test:all` completes with zero failures, combined test count matches sum

6. **ARCHITECT: Fix stale doctor tests (3 failures from v9)**

   Files (MODIFIED):
   - `test/cli/verbs/doctor.test.ts` — update exactly 3 tests to reflect v6 managed-section semantics (0 directives = ok):
     a) `all checks pass → exit 0` — ensure fixture has `~/.claude-sop/version.txt` set so `installed` check passes, and fixture project has hooks wired so `hooks wired` passes. Then expect `exit 0`.
     b) `JSON mode emits ok:true when all checks pass` — same fixture fix as (a)
     c) Rename `zero directives → managed section check fails` to `zero directives → managed section check OK (v6+ semantics)`. Flip assertion: `expect(code).toBe(0)` and `expect(parsed.checks.find(c => c.name === 'managed section').status).toBe('ok')`.

   Requirements:
   - No behavior change in `src/cli/verbs/doctor.ts` — the code is right, only the tests are stale
   - All 9 existing doctor tests pass
   - `npm run test` is fully green after this + task 5

### Wave 3 — Isolated smoke tests for new capabilities (depends on Waves 1-2)

7. **ARCHITECT: Isolated smoke tests for managed section + learner integration**

   Files (MODIFIED):
   - `test/smoke.test.ts` — add a new group `smoke: managed section end-to-end (isolated)`:

   Tests:
   - (k) **Learner writes sample directive to CLAUDE.md on first run.** Seed tmpHome with 1 project + 3 fake finalized turns. Spawn learner. Assert `<tmpProject>/CLAUDE.md` exists, contains exact begin+end markers, body includes `turns analyzed` text, body mentions agent roster.
   - (l) **Learner is idempotent when no new turns.** After (k), spawn learner again with no new turns. Assert CLAUDE.md mtime is unchanged (byte-identical to previous state). Assert recap.log shows `directive_written: "unchanged"`.
   - (m) **New turn → updated directive + backup exists.** After (l), drop a 4th turn into captures. Spawn learner. Assert CLAUDE.md body shows `4 turns analyzed`, `<tmpProject>/.claude-sop/state/CLAUDE.md.backup` exists with the OLD content, recap shows `directive_written: "updated"`.
   - (n) **Dry-run mode writes nothing.** After (m), set `CLAUDE_SOP_LEARNER_DRY_RUN=1` in child env, drop a 5th turn, spawn learner. Assert CLAUDE.md still shows `4 turns analyzed` (unchanged), no new backup, recap shows `directive_written: "dry_run"`.
   - (o) **User content preserved.** Create tmpProject with a CLAUDE.md that has `# My project\n\nMy own rules\n` + a fake begin marker followed by END but no close marker (malformed) → learner logs error, CLAUDE.md is NOT corrupted, test asserts exact original bytes.
   - (p) **Statusline on an installed project.** tmpHome with project that has `.claude/settings.json` containing a claude-sop hook. Spawn `claude-sop statusline --project <tmpProject>`. Assert stdout is exactly `[sop:on]`.
   - (q) **Statusline on non-installed project.** tmpProject without any `.claude/settings.json`. Assert stdout is exactly `[sop:off]`.

   Requirements:
   - All tests follow the v8/v9 isolation pattern (copy bundle OUT of repo to a tmpdir, spawn learner from there)
   - Bundle grep guard: add an assertion that `dist/plugin/learner.cjs` still has zero bare non-node `require()` calls after v10 (same pattern as v8's writer assertion, already in place for learner via v9)
   - Tests clean up tmpdirs in afterEach
   - Total smoke test count: 30 (v9) + 7 new (k-q) = 37+

   Acceptance:
   - `npm run test:smoke` shows ≥ 37 passing tests
   - Reverting any single task 1-4 change causes the relevant assertion to fail loudly with a clear diagnostic

## Quality Gates (MANDATORY)

8. **YODA: Code review** — focus on ManagedSectionEditor hardness (idempotency, backup atomicity, byte preservation, error classes), learner wiring fail-open policy, statusline perf, test fixture correctness. **100% approval required.**

9. **APEX: Security review** — specific concerns:
   - `writeManagedSection` must resolve `projectRoot` and refuse path traversal (`..`) — defense in depth even though registry is trusted
   - Backup file permissions: 0o644 for CLAUDE.md, 0o600 for backup (contains potentially sensitive project context)
   - Statusline: must NOT expose secrets from `.claude/settings.json` in `--json` output (only emit `on`/`off` and project slug, not raw config)
   - Atomic rename: verify no TOCTOU between the backup write and main write under a concurrent tick (shouldn't happen due to learner lock, but document the invariant)
   - Dry-run mode: MUST NOT call `writeFileSync` under any code path, even accidentally. Verify via a write-spy in unit tests.
   **Must pass P0/P1.**

10. **ANALYZER: Code improvement review** — grade ManagedSectionEditor, directive-builder, recap verb diff logic, statusline verb, test fixtures. **Must be C or above.**

(No PRISM — no UI, statusline is stdout-only.)

## Finalize

11. **ARCHITECT: Commit** with message:
    ```
    feat(phase4-light): managed section editor + sample directive + statusline + test cleanup
    ```

## Acceptance Criteria (POC validation, round 5)

After this plan lands AND the user runs the post-plan refresh sequence, ALL of these hold:

- `npm run build && npm run test:all` exits 0 (unit + integration + smoke all green)
- `dist/plugin/learner.cjs` size ≥ 180 KB (ManagedSectionEditor added)
- After `claude-sop install` into a fresh project:
  - `<project>/CLAUDE.md` does NOT yet exist OR still has user content unchanged (install does NOT trigger a tick)
  - Running `claude-sop recap --run` creates `<project>/CLAUDE.md` (if missing) with the sample directive, OR appends the managed section to the end of existing content
  - `<project>/.claude-sop/state/CLAUDE.md.backup` exists after the first UPDATE write (not after CREATE)
  - Running `claude-sop recap --run` again (no new turns) shows `directive: unchanged` in the table, CLAUDE.md mtime unchanged
  - Running `claude-sop recap --run --dry-run` after a new turn arrives → prints diff, CLAUDE.md unchanged
- `claude-sop statusline` in an installed project prints `[sop:on]`, elapsed time <100ms
- `claude-sop statusline` in a non-installed directory prints `[sop:off]`
- Doctor all 9 checks still ok, no regressions
- Opening CLAUDE.md shows the managed section at the BOTTOM (Q2=B), user content at the top untouched

## Post-plan steps for the user

```bash
# 1. Build + test
cd ~/Developer/claude-sop
npm run build
npm run test            # fast unit+integration (no smoke)
npm run test:smoke      # smoke only, rebuilds first
wc -c dist/plugin/learner.cjs   # expect ≥ 180000

npm pack
npm i -g ./claude-sop-0.0.0.tgz

# 2. Clean slate for the experiment
launchctl bootout "gui/$UID/com.claude-sop.learner" 2>/dev/null || true
rm -rf ~/.claude-sop/marketplace/claude-sop
rm -f ~/.claude-sop/logs/recap.log*

# 3. Install and preflight the editor
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop uninstall 2>/dev/null || true
claude-sop install

# 4. Statusline — manual verification
claude-sop statusline                    # expect: [sop:on]
cd /tmp && claude-sop statusline          # expect: [sop:off]
cd ~/Developer/wrbeautiful-shopify-theme

# 5. Dry-run first (SAFE — does not touch CLAUDE.md)
claude-sop recap --run --dry-run
# expect: table with directive=dry_run column, diff block showing sample section that would be appended

# 6. Real run — watch CLAUDE.md grow the managed section
claude-sop recap --run
tail -20 CLAUDE.md
# expect: managed section markers + sample directive body at the bottom

# 7. Run again — idempotent
claude-sop recap --run
# expect: directive=unchanged in the table
# CLAUDE.md mtime should not have updated
stat -f '%m' CLAUDE.md
sleep 1
claude-sop recap --run
stat -f '%m' CLAUDE.md
# expect: same mtime both times

# 8. Manual statusline wiring (optional — Q6=B)
# Add to ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "claude-sop statusline" }
# Reload Claude Code. Open the shopify theme project. Look at the statusline.
# expect: see [sop:on] somewhere in the prompt area

# 9. Generate new turns via a real Claude Code session
claude
# inside: issue a prompt, /exit
claude-sop recap --run
tail -20 ~/Developer/wrbeautiful-shopify-theme/CLAUDE.md
# expect: turn count in the managed section has increased
ls -la ~/Developer/wrbeautiful-shopify-theme/.claude-sop/state/CLAUDE.md.backup
# expect: backup file exists with previous state
```

## Out of Scope (explicit non-goals)

- Pattern detection (rule-based or LLM-driven). **v11.**
- Recall gate (injecting directives into `UserPromptSubmit`). **v12.**
- Multi-generation backups. One is enough for POC.
- Status line customization beyond `[sop:on]` / `[sop:off]`. No colors, no turn count in the line.
- Automatic `~/.claude/settings.json` mutation on install. User opts in manually.
- Marker format versioning migration. `v1` is the only version; `v2` arrives when we need it.
- Pretty-printing the managed section with fancy markdown (tables, badges, etc.). Keep it plain.

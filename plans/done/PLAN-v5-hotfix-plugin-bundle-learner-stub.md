# PLAN-v5 — Hotfix: Plugin Bundle Layout + Learner Stub (POC dogfood unblock)

## Overview

v4 shipped a runnable CLI and a plugin bundle, but **dogfood install reveals two independent runtime blockers** that stop the POC from actually capturing anything:

1. **BLOCKER 1 — Scheduler crash loop.** `~/.claude-sop/bin/tick.sh` execs `~/.claude-sop/marketplace/claude-sop/learner.cjs`, which does not exist. launchd has been throwing `MODULE_NOT_FOUND` on every tick since v4. Phase 3 builds the real learner; until then we need a **stub that exits 0 cleanly** so the scheduler stops spewing errors.

2. **BLOCKER 2 — `/plugin` discovery fails.** Claude Code's plugin manager reports:
   ```
   Marketplace file not found at
   /Users/<user>/.claude-sop/marketplace/claude-sop/.claude-plugin/marketplace.json
   ```
   v4 put `marketplace.json` at `marketplace/marketplace.json`. Claude Code expects it at `.claude-plugin/marketplace.json` (same directory convention as `plugin.json`). Content may also be missing required fields (`owner`, `plugins[].source`) per the marketplace schema.

3. **Regression guard.** v4's smoke test only covered `cli.js` + `shim.cjs`. It did NOT verify `learner.cjs` runs, nor did it validate marketplace manifest shape/location. We extend the smoke test so v5's blockers can never regress.

Neither blocker is gated by Phase 3 work. Both are pure Phase 2 packaging completeness issues.

## Architecture Decisions

- **Learner stub is a real file, not a shell hack.** Source lives at `src/learner/stub.ts` → tsup entry emits `dist/plugin/learner.cjs`. The stub writes a single line to a `ticks.log` marker file (proves the scheduler is alive + reachable during dogfood), then `process.exit(0)`. No other side effects. When Phase 3 lands the real learner, it replaces this file via the same tsup entry — no installer changes, no `tick.sh` regeneration, no re-install required.
- **Marketplace manifest lives next to plugin manifest.** Both files sit under `.claude-plugin/` in the bundle root. The existing `plugin/marketplace/` directory is removed. This matches Claude Code's documented layout: one directory can act as both a plugin bundle and a single-plugin marketplace when both manifests are present at `.claude-plugin/`.
- **Marketplace manifest gets a valid Claude Code schema.** Current file only has `name` + `plugins[0].source`. Claude Code's marketplace schema also requires `owner` (object with at least `name`) and each plugin entry needs `name` + `source` (string or object). ARCHITECT must research the exact schema via the Claude Code marketplace docs before writing the file — do not guess. If the docs are ambiguous, mirror the shape published in an existing OSS Claude Code marketplace (e.g. the ralph-loop or gsd marketplaces already installed on this machine — see `~/.claude/marketplaces/`).
- **`tick.sh` does not change.** The scheduler wrapper already points at `<marketplaceDir>/learner.cjs`. Once the bundle emits a working `learner.cjs` at that exact path, the crash stops with zero installer code changes. No new re-install should be required after rebuild — just `npm run build`, copy `dist/plugin/learner.cjs` over the installed marketplace dir, and watch launchd go quiet. (Installer-triggered re-copy still works via `claude-sop install` if anyone re-runs it, but is not required for the fix to take effect.)
- **No functional source changes to Phase 1 or Phase 2 logic.** This is packaging + a 20-line stub + a test. Nothing in `src/capture/`, `src/installer/`, `src/scheduler/`, or `src/cli/verbs/` moves.

## Phase 0: Advisory

None. No HubSpot, no AWS, no UI surface.

## Implementation Tasks

### Wave 1 — one ARCHITECT handles all three sequentially (shared package.json edits; no parallelism benefit)

1. **ARCHITECT: Learner stub + build entry (BLOCKER 1)**
   Files (NEW):
   - `src/learner/stub.ts` — ~20 lines: read `CLAUDE_SOP_LEARNER` env, append one line to `~/.claude-sop/logs/ticks.log` in ISO8601 format (`<timestamp> learner-stub v${PKG_VERSION} pid=${process.pid}\n`), `process.exit(0)`. Use `fs.appendFileSync` (sync, no lockfile — the stub is single-shot and finishes in <5ms). Wrap everything in try/catch → `process.exit(0)` on any error (fail-open, same policy as the shim).
   Files (MODIFIED):
   - `tsup.config.ts` — add a new entry identical to the existing `plugin/shim` entry but with `entry: { 'plugin/learner': 'src/learner/stub.ts' }` and the same `format: ['cjs']`, `outExtension: () => ({ js: '.cjs' })`, `bundle: true`, `minify: true`. Output must land at `dist/plugin/learner.cjs`.
   Requirements:
   - `node dist/plugin/learner.cjs` exits 0 in <100ms.
   - Running it twice appends two lines to `~/.claude-sop/logs/ticks.log` (the stub creates the parent dir if missing).
   - Stub must NOT `require` anything that isn't either a Node builtin or bundled by tsup (no runtime deps). Verify by running `node dist/plugin/learner.cjs` from a directory without any `node_modules`.
   - Stub must NOT crash if `~/.claude-sop/logs/` doesn't exist (create it). Must NOT crash if the log file is unwritable (swallow + exit 0).
   - Do NOT import anything from `src/learner/` beyond `stub.ts` — this is a deliberately isolated entry so Phase 3 can replace the file without touching the rest of the tree.
   Acceptance:
   - `npm run build && test -f dist/plugin/learner.cjs`
   - `node dist/plugin/learner.cjs ; echo $?` prints `0`
   - After running it, `tail -1 ~/.claude-sop/logs/ticks.log` shows a line containing `learner-stub`
   - `grep -c "require(" dist/plugin/learner.cjs` shows only bundled requires (no `proper-lockfile`, no `nanoid`, no `execa`)

2. **ARCHITECT: Fix marketplace manifest location + schema (BLOCKER 2)**
   Files (MOVED/DELETED):
   - DELETE `plugin/marketplace/marketplace.json`
   - DELETE `plugin/marketplace/` (empty directory after the delete)
   Files (NEW):
   - `plugin/.claude-plugin/marketplace.json` — valid single-plugin marketplace catalog. Research Claude Code's marketplace schema via:
     (a) `~/.claude/marketplaces/` — inspect at least two installed marketplaces already on this machine (e.g. ralph-loop, gsd) for their `.claude-plugin/marketplace.json` shape, and
     (b) Claude Code plugin docs if reachable.
     The file MUST include at minimum: `name` (`"claude-sop"`), `owner` (object with `name`), and `plugins[]` with one entry for claude-sop pointing at the bundle root as a `directory`-type source. Mirror whatever shape the reference marketplaces use. Do NOT guess fields — copy the schema exactly.
   Files (MODIFIED):
   - `tsup.config.ts` — if the build uses a directory-copy step to stage `plugin/**` → `dist/plugin/**`, ensure the updated layout (`dist/plugin/.claude-plugin/marketplace.json` + `dist/plugin/.claude-plugin/plugin.json`, no `dist/plugin/marketplace/`) gets emitted cleanly. If the copy is globbed, verify hidden `.claude-plugin/` directory is NOT excluded by default glob rules.
   Requirements:
   - Both `plugin.json` and `marketplace.json` sit at `<bundle-root>/.claude-plugin/` after build AND after install.
   - `marketplace.json` validates against Claude Code's marketplace schema (verify by running `/plugin` after install and confirming no "Marketplace file not found" error AND no schema validation error in Claude Code's plugin log).
   - No stray `dist/plugin/marketplace/` directory exists after a clean build (`rm -rf dist && npm run build`).
   - `plugin.json` remains unchanged in content; only its neighbor is new.
   Acceptance:
   - `npm run build && test -f dist/plugin/.claude-plugin/marketplace.json`
   - `npm run build && test -f dist/plugin/.claude-plugin/plugin.json`
   - `npm run build && test ! -d dist/plugin/marketplace`
   - `jq -e '.owner.name' dist/plugin/.claude-plugin/marketplace.json` passes
   - `jq -e '.plugins | length == 1' dist/plugin/.claude-plugin/marketplace.json` passes
   - `jq -r '.plugins[0].name' dist/plugin/.claude-plugin/marketplace.json` prints `claude-sop`

3. **ARCHITECT: Extend smoke test (regression guard)**
   Files (MODIFIED):
   - `tests/smoke.test.ts` — add three new assertions:
     (a) `node dist/plugin/learner.cjs` exits 0 in <500ms.
     (b) `dist/plugin/.claude-plugin/marketplace.json` exists, parses as JSON, has `name === "claude-sop"`, has `owner.name` (non-empty string), and `plugins` is a non-empty array.
     (c) `dist/plugin/.claude-plugin/plugin.json` still exists + parses + has `name === "claude-sop"` (already implicitly tested by v4 shim test, but make it explicit here).
   Requirements:
   - Tests must run against built artifacts in `dist/` — not source. The existing `test:smoke` script already runs `npm run build` first; no script changes needed.
   - Do NOT stub out filesystem or spawn. Real `node` child process, real `fs.readFileSync`.
   - Tests must pass on a fresh clone after `npm install && npm run test:smoke`.
   Acceptance:
   - `npm run test:smoke` exits 0
   - Reverting task 1 (deleting `dist/plugin/learner.cjs`) makes the smoke test fail on the learner assertion
   - Reverting task 2 (moving marketplace.json back to `plugin/marketplace/`) makes the smoke test fail on the marketplace assertion
   - All v4 smoke assertions (cli --help, cli --version, cli status --json, shim stdin-drain) still pass

## Quality Gates (MANDATORY)

4. **YODA: Code review** — review the new `src/learner/stub.ts`, tsup entry additions, and smoke test changes. Verify the stub follows Phase 1 fail-open policy (same as shim), no new runtime deps bled into either bundle. **100% approval required.**

5. **APEX: Security review** — the learner stub runs under launchd with `CLAUDE_SOP_LEARNER=1` on a fixed interval. Verify: (a) no network egress, (b) no shell execution, (c) log append is size-bounded or at least doesn't grow unbounded in a way that'd fill disk over weeks of dogfooding, (d) marketplace.json doesn't leak any internal paths or secrets. **Must pass.**

6. **ANALYZER: Code improvement review** — grade the new stub + smoke test additions. **Must be C or above.**

(No PRISM: no UI surface in this hotfix.)

## Finalize

7. **ARCHITECT: Commit all changes** with message `fix(phase2): plugin bundle layout + learner stub — unblock POC dogfood`.

## Acceptance Criteria (POC-level validation)

The POC is considered unblocked when ALL of these hold on a fresh install:

- `npm run build` succeeds; `npm run test:smoke` exits 0.
- `dist/plugin/` layout:
  ```
  dist/plugin/
    .claude-plugin/
      plugin.json
      marketplace.json
    hooks/
      hooks.json
    shim.cjs
    learner.cjs
  ```
- After `claude-sop install` in `~/Developer/claude-sop`:
  - `~/.claude-sop/marketplace/claude-sop/.claude-plugin/marketplace.json` exists.
  - `~/.claude-sop/marketplace/claude-sop/learner.cjs` exists and `node` can execute it.
- After one launchd tick (wait ≤60s or trigger manually via `launchctl kickstart gui/$UID/<label>`):
  - `~/.claude-sop/logs/errors.log` has NO new `MODULE_NOT_FOUND` lines.
  - `~/.claude-sop/logs/ticks.log` has at least one new `learner-stub` line.
- Inside Claude Code, `/plugin` shows `claude-sop` under **Marketplaces** with NO "Marketplace file not found" error.
- `claude-sop doctor` still reports `installed ok`, `scheduler ok`, `license ok`. (Hooks + managed section remain "fail" until `claude-sop install` is run inside the dogfood project — that's the next manual step, not part of this plan.)

## Out of Scope (explicit non-goals)

- Running `claude-sop install` inside `~/Developer/claude-sop`. That's a manual post-plan step the user will do from the dogfood ghostty terminal.
- Replacing the stub with the real learner. That's Phase 3.
- Fixing the missing `.claude/settings.json` hooks in the project. That happens when the user runs `claude-sop install` after this plan lands.
- Any capture/learner logic. Stub only.
- Cleanup of the stray `claude-sop-0.0.0.tgz` at repo root (unrelated noise).

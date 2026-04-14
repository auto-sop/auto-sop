# PLAN-v4 — Hotfix: Runtime Smoke (CLI ESM bin + Plugin Bundle + Smoke Test)

## Overview

Phase 2 shipped green through all quality gates, but the built artifacts fail at runtime on a clean install:

1. **BLOCKER 1 — CLI crashes on startup.** `package.json` `bin` points at `./dist/cli.cjs`, but `cli.cjs` requires `nanoid` (ESM-only). Running `node dist/cli.cjs --help` crashes with `ERR_REQUIRE_ESM`.
2. **BLOCKER 2 — Plugin bundle missing.** `dist/plugin/` does not exist. The installer's step 3 (copy plugin bundle into `~/.claude-sop/marketplace/claude-sop/`) will fail on every `npx claude-sop install` invocation.
3. **Regression guard missing.** YODA/APEX/ANALYZER reviewed source only; nobody actually executed the built binary. A smoke test that runs `node <bin> --help` would have caught both blockers instantly.

This hotfix lands all three fixes in a single wave before we push to GitHub, install locally, and begin dogfooding.

## Architecture Decisions

- **CLI entry becomes ESM.** `package.json` already declares `"type": "module"`, and tsup already emits `dist/cli.js` as ESM. Switching `bin` from `./dist/cli.cjs` → `./dist/cli.js` eliminates the ESM/CJS interop problem entirely. Source imports stay untouched. nanoid stays at v5.
- **Plugin bundle is a build artifact, not a source tree.** We add a `plugin/` source directory checked into git containing only `.claude-plugin/plugin.json`, `hooks/hooks.json`, and `marketplace/marketplace.json` (verbatim templates from `.planning/phases/02-installer-scheduler-cli/02-RESEARCH.md`). A new tsup task (or plain copy script hooked into `build`) stages `plugin/` → `dist/plugin/` and also emits a bundled `dist/plugin/shim.cjs` (reusing `src/capture/shim/main.ts` — same entry as the existing `dist/capture/shim.cjs`, but placed inside the plugin bundle so `${CLAUDE_PLUGIN_ROOT}/shim.cjs` resolves).
- **Smoke test runs built artifacts.** `tests/smoke.test.ts` spawns `node dist/cli.js --help` (and a few other verbs) and asserts exit 0 + expected stdout. CI runs this AFTER `npm run build`. This is the regression guard — no future plan can regress runtime startup without tripping it.
- **No functional changes.** This is pure build/packaging + test. No Phase 1 or Phase 2 source logic changes. No new deps.

## Phase 0: Advisory

None. No HubSpot, no AWS, no UI.

## Implementation Tasks

### Wave 1 (single wave — all three tasks are independent of each other at the file level, but small enough that one ARCHITECT should do them sequentially for coherence)

1. **ARCHITECT: Fix CLI ESM bin (BLOCKER 1)**
   Files:
   - `package.json` — change `"bin": { "claude-sop": "./dist/cli.cjs" }` → `"bin": { "claude-sop": "./dist/cli.js" }`
   - `tsup.config.ts` — ensure the first entry still emits `dist/cli.js` as ESM (it already does; verify no regressions)
   Requirements:
   - After `npm run build`, `node dist/cli.js --help` must exit 0 and print the commander help output.
   - `node dist/cli.cjs --help` is now unused by the `bin` field but may still exist as a build artifact; DO NOT delete it (other consumers may `require()` the library `./dist/index.cjs`, which is separate from the CLI).
   - Do NOT downgrade nanoid. Do NOT swap to `crypto.randomUUID()`. Do NOT touch source imports. The fix is one line in `package.json`.
   Acceptance:
   - `jq -r '.bin["claude-sop"]' package.json` prints `./dist/cli.js`
   - `npm run build && node dist/cli.js --help` exits 0
   - `npm run build && node dist/cli.js status --json` exits with documented code (0 or 3 per I4) and valid JSON on stdout

2. **ARCHITECT: Create plugin bundle source + build step (BLOCKER 2)**
   Files (NEW):
   - `plugin/.claude-plugin/plugin.json`
   - `plugin/hooks/hooks.json`
   - `plugin/marketplace/marketplace.json`
   - `tsup.config.ts` — add a new entry (or postbuild copy) that stages `plugin/**` → `dist/plugin/**` AND bundles `src/capture/shim/main.ts` → `dist/plugin/shim.cjs` (reuse the same tsup config block as the existing `capture/shim` entry, just change the output path)
   Requirements:
   - Use the VERBATIM template from `.planning/phases/02-installer-scheduler-cli/02-RESEARCH.md` lines 819–859 for `hooks/hooks.json`:
     ```json
     {
       "hooks": {
         "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }] }],
         "Stop":             [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }] }],
         "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }] }],
         "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }] }],
         "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/shim.cjs", "timeout": 10 }] }]
       }
     }
     ```
   - `plugin.json` contains: `{ "name": "claude-sop", "version": "<mirror package.json version>", "description": "Auto-capture Claude Code turns and learn from mistakes." }`. Keep version in sync with `package.json` via a small prebuild script if easy, otherwise hand-maintained and checked in CI.
   - `marketplace.json` contains a single-plugin catalog pointing at this plugin's directory (per Claude Code marketplace docs — local `directory` source type).
   - The build MUST place a working `shim.cjs` at `dist/plugin/shim.cjs` — NOT a symlink, NOT a copy of the existing `dist/capture/shim.cjs`; use a separate tsup entry so that `${CLAUDE_PLUGIN_ROOT}/shim.cjs` resolves when Claude Code runs the plugin.
   - `plugin/` source directory must be included in the published npm package — verify `files` in package.json includes `dist/` (plugin bundle goes there); `plugin/` source does NOT need to be published.
   Acceptance:
   - `npm run build && test -f dist/plugin/.claude-plugin/plugin.json`
   - `npm run build && test -f dist/plugin/hooks/hooks.json`
   - `npm run build && test -f dist/plugin/marketplace/marketplace.json`
   - `npm run build && test -x dist/plugin/shim.cjs && node dist/plugin/shim.cjs < /dev/null ; [ $? -eq 0 ]` (shim fail-open exit 0 per Phase 1 CAPT-07)
   - `jq -e .hooks.UserPromptSubmit dist/plugin/hooks/hooks.json` passes
   - `jq -r .name dist/plugin/.claude-plugin/plugin.json` prints `claude-sop`

3. **ARCHITECT: Runtime smoke test (regression guard)**
   Files (NEW):
   - `tests/smoke.test.ts`
   - `package.json` — add `"test:smoke": "npm run build && vitest run tests/smoke.test.ts"` script; add `test:smoke` to the `test` pipeline so CI runs it
   Requirements:
   - Test suite spawns `node dist/cli.js --help` via `execa` (already a dep) and asserts exit 0 + stdout contains `"claude-sop"` + `"install"` + `"status"` + `"uninstall"`.
   - Test suite spawns `node dist/cli.js --version` and asserts exit 0 + stdout matches a semver pattern.
   - Test suite spawns `node dist/cli.js status --json` in a temp directory (not a project) and asserts it exits cleanly (exit 0 OR exit 3 "not installed" — both are acceptable per I4) and stdout is valid JSON.
   - Test suite spawns `node dist/plugin/shim.cjs` with a synthetic UserPromptSubmit JSON payload on stdin, with `CLAUDE_SOP_LEARNER=1` set, and asserts exit 0 in <100ms (kill-switch path — no writes, no crash).
   - Test suite asserts `dist/plugin/hooks/hooks.json` parses as valid JSON and contains all 5 hook events.
   - This test MUST be runnable via `npm run test:smoke` locally. It is the canonical "is the build shippable" check.
   Acceptance:
   - `npm run test:smoke` exits 0 after a clean `rm -rf dist && npm run build`
   - The smoke test file is <150 lines and uses vitest + execa only (no new deps)
   - Running `node dist/cli.cjs --help` (the OLD broken path) is explicitly NOT tested — we're not guarding a path we've abandoned

## Quality Gates (MANDATORY — and this time they MUST execute the built binary)

4. **YODA: Code review**
   - Review all changes to `package.json`, `tsup.config.ts`, new `plugin/` source files, new `tests/smoke.test.ts`.
   - **MANDATORY step:** YODA must run `rm -rf dist && npm run build && node dist/cli.js --help && node dist/plugin/shim.cjs < /dev/null` as part of the review. If any of those commands fails or hangs, YODA blocks the commit. Reviewing source alone is not sufficient for this plan — runtime verification is the whole point.
   - Grade must be C or above.

5. **APEX: Security review**
   - Check that the new plugin bundle does not introduce new network egress paths (zero-network mandate inherited from Phase 0).
   - Check that `plugin/hooks/hooks.json` only references `${CLAUDE_PLUGIN_ROOT}/shim.cjs` and contains no shell metacharacters that could be injected.
   - Check that the smoke test does not shell-interpolate untrusted input.

6. **ANALYZER: Code improvement review**
   - Readability of `tsup.config.ts` additions.
   - Smoke test clarity and coverage.
   - Grade must be C or above.

(No PRISM — no UI work in this plan.)

## Finalize

7. **ARCHITECT: Commit**
   - Commit message: `fix(phase2): runtime smoke — cli ESM bin + plugin bundle + smoke test`
   - Body briefly enumerates the three blockers and the fixes.
   - Single commit, all three tasks together.

## Acceptance Criteria

A user performing these exact steps on a clean machine with Node ≥18.17 and Claude Code installed must succeed:

```bash
git clone <repo>
cd claude-sop
npm install
npm run build
npm run test:smoke        # EXIT 0
node dist/cli.js --help   # prints help, exit 0
node dist/cli.js --version # prints version, exit 0
node dist/plugin/shim.cjs < /dev/null  # exit 0 (fail-open)
test -f dist/plugin/.claude-plugin/plugin.json
test -f dist/plugin/hooks/hooks.json
test -f dist/plugin/marketplace/marketplace.json
test -x dist/plugin/shim.cjs
```

All 9 checks must pass. If any fails, the plan is not done.

Additionally:
- All existing Phase 0 + Phase 1 + Phase 2 unit/integration tests continue to pass (no regressions).
- Zero new dependencies (`npm ls --depth=0` output is identical apart from version bumps, if any).
- `git status` after commit is clean.

## Notes for Commander

- This is a **hotfix plan** — tight scope, one wave, one commit. Do not let it expand.
- BLOCKER 1 fix is literally one character edit in `package.json`. BLOCKER 2 is the bulk of the work (plugin bundle source + tsup entry + shim bundle). The smoke test is the regression guard that ensures we never ship this class of bug again.
- If ARCHITECT discovers while working that `dist/plugin/shim.cjs` can't be produced by tsup in the shape we need, escape hatch: copy `dist/capture/shim.cjs` → `dist/plugin/shim.cjs` via a postbuild `cp` step in the `build` script. This is uglier but ships. Document the escape-hatch decision in the commit body.
- YODA/APEX/ANALYZER **must** execute the built binary. Do not accept review output that only cites source-file grep. This plan exists because last round's quality gates were source-only.
- After this plan lands and commits, the next user action is: push to GitHub → `npm pack` smoke test → `npx <tarball> install` in a real project → `army-start` → dogfood capture.

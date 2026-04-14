# PLAN-v6 — Hotfix: Shebang + Marketplace Schema + Stub Polarity + Doctor Logic (POC dogfood, round 2)

## Overview

v5 unblocked the scheduler crash-loop and got the marketplace file to the right path. Dogfooding in `~/Developer/wrbeautiful-shopify-theme` immediately surfaced **two new P0 runtime blockers** plus **two lower-severity bugs**:

1. **P0 BLOCKER C — Claude Code rejects our marketplace schema.**
   ```
   Failed to parse marketplace file at .../claude-sop/.claude-plugin/marketplace.json:
   Invalid schema: plugins.0.source: Invalid input
   ```
   Our file has `plugins[0].source = { "source": "directory", "path": "." }` — the nested `source.source` key is wrong. Claude Code's marketplace schema expects either a string path (`"./"`) or an object with `type` (`{ "type": "directory", "path": "./" }`). Result: `/plugin` cannot load claude-sop as a marketplace at all, and this error appears every time the user opens a project with the installer-written hooks.

2. **P0 BLOCKER D — Shim/learner lack shebangs → Claude Code hook crashes and BLOCKS USER PROMPTS.**
   Installer writes `.claude/settings.json` with:
   ```json
   { "type": "command", "command": "/…/marketplace/claude-sop/shim.cjs", "timeout": 10 }
   ```
   Claude Code executes the `command` field as a shell command (`/bin/sh -c …`). The shim file starts with `'use strict';var child_process=require(…)` — valid CJS, but shell sees bare parens and fails:
   ```
   UserPromptSubmit operation blocked by hook:
     .../shim.cjs: line 1: syntax error near unexpected token `('
   ```
   **User impact:** every prompt in the dogfood project is blocked. Claude Code is unusable until the hook is disabled. `learner.cjs` has the same structural problem (tsup-bundled CJS with no shebang); launchd happens to tolerate it via `exec "$NODE_BIN" "$LEARNER_JS"` in `tick.sh`, but the plugin bundle's own `hooks/hooks.json` also references `${CLAUDE_PLUGIN_ROOT}/shim.cjs` as a shell command, so the same crash would hit plugin-loaded users too.

   **Why v5 smoke tests didn't catch it:** every smoke assertion invoked scripts as `node dist/plugin/shim.cjs` — i.e. Node-mode execution. Claude Code invokes them as shell commands. The regression guard missed the only execution mode that actually matters in production.

3. **BUG A — Stub kill-switch polarity conflict (non-blocking, but designed v5 behavior is broken).**
   `src/capture/kill-switch.ts` reads `CLAUDE_SOP_LEARNER === '1'` as "capture is disabled, exit now." That semantics is correct for the **shim** (it's a recursion guard so the shim doesn't re-capture the learner's child process). It is **backwards for the learner stub**, which `src/learner/stub.ts` imports the same function from. `tick.sh` sets `CLAUDE_SOP_LEARNER=1` specifically to say "I am the learner process, go run." The stub imports `isCaptureDisabled`, sees `=1`, and exits before writing the liveness line to `ticks.log`. Proof: running `node learner.cjs` directly (without the env var) writes the line; running it via `tick.sh` does not.

4. **BUG B — `doctor` managed-section check fails on fresh install (non-blocking).**
   On a clean install with zero learned directives, `install` correctly reports `managed section  noop`, but `doctor` reports `managed section  fail — 0 directives` and returns a non-zero exit (precondition failed). These two verbs disagree. On a fresh install with no directives, the correct state is "ok — no directives to write yet," not "fail."

None of these are Phase 3 work; all are Phase 2 packaging + correctness bugs that were missed because (a) smoke tests only ran in Node mode, (b) no end-to-end dogfood ran against a real Claude Code session before v5 was declared done, and (c) v4 and v5 both wrote marketplace.json by hand without validating against Claude Code's actual schema.

## Architecture Decisions

- **Shebangs via tsup `banner`, not postbuild prepend.** Both `plugin/shim` and `plugin/learner` tsup entries get `banner: { js: '#!/usr/bin/env node' }`. This runs before minification, so the shebang survives and nothing else in the bundle touches byte 0. Postbuild `chmod +x` is extended to include `dist/plugin/learner.cjs` in addition to the existing `dist/plugin/shim.cjs`. The internal `dist/capture/shim.cjs` also gets the same treatment even though it's currently invoked via explicit `node path/shim.cjs` — belt and suspenders, and one future installer change could flip that invocation to shell mode.
- **Marketplace schema is researched, not guessed.** ARCHITECT must find the authoritative Claude Code marketplace schema before writing the fix. Three places to check, in priority order:
  1. Official Claude Code docs for plugin marketplaces (reachable via WebFetch).
  2. Any working marketplace file on this machine. `~/.claude/marketplaces/` had no marketplace.json when grepped during v5 planning, but `~/.claude/marketplaces/repos/` may contain cloned marketplace repos from installed plugins — check there. Also check Claude Code's installed plugin registry at `~/.claude/plugins/known_marketplaces.json` for source URLs to fetch reference files.
  3. If neither (1) nor (2) is definitive, try both candidate shapes in sequence and pick whichever one Claude Code accepts without error: `plugins[0].source = "./"` (string form) OR `plugins[0].source = { "type": "directory", "path": "./" }` (object form with `type` key, NOT nested `source`).
  The smoke test MUST validate the produced shape against a known-good reference, not just against our own assumption.
- **Stub gets its own pause check.** `src/learner/stub.ts` stops importing `isCaptureDisabled`. It instead reads `CLAUDE_SOP_PAUSED === '1'` (which is the env var `claude-sop pause` sets, per Phase 2 design). `CLAUDE_SOP_LEARNER` is left alone — it remains the shim's recursion guard with current semantics. No changes to `kill-switch.ts`, no changes to `tick.sh`, no installer changes.
  - If `CLAUDE_SOP_PAUSED` is NOT yet wired into anything on the Phase 2 install path, ARCHITECT should grep for it first. If it's missing, use the project's existing pause mechanism (likely a file at `~/.claude-sop/paused.flag` or similar — check `src/cli/verbs/pause.ts`). The stub's pause check must match whatever `claude-sop pause` actually does; otherwise pausing won't stop ticks.
- **Doctor managed-section check becomes state-aware.** The rule is: if `directives == 0` AND the managed CLAUDE.md section has never been written (file absent or section marker absent), the check is **ok** with detail `no directives yet`. If `directives > 0` AND managed section is absent/drift-detected, the check is **fail** (real problem — directives exist but aren't in the file). The current logic fires fail on `directives == 0`, which is the most common fresh-install state, making doctor useless on a clean box.
- **Smoke tests gain a shell-execution mode.** New test group: spawn `/bin/sh -c '<absolute path to dist/plugin/shim.cjs>'` with synthetic hook stdin, assert exit 0 in <500ms. Same for `dist/plugin/learner.cjs` (no stdin, just shell-invoke). This is the execution mode Claude Code and launchd actually use. Additionally, a marketplace-manifest test that imports the JSON and validates it against an inline copy of Claude Code's schema (derived from the authoritative source ARCHITECT finds above).
- **No source changes outside `src/learner/stub.ts`, `src/cli/verbs/doctor.ts` (or wherever doctor checks live), `tsup.config.ts`, `package.json` (postbuild chmod), `plugin/.claude-plugin/marketplace.json`, and `test/smoke.test.ts`.** Phase 1 capture pipeline is untouched.

## Phase 0: Advisory

None.

## Implementation Tasks

### Wave 1 — one ARCHITECT, sequential (all edits touch related packaging state)

1. **ARCHITECT: Add shebangs + exec bit to plugin bundle cjs files (BLOCKER D)**

   Files (MODIFIED):
   - `tsup.config.ts` — for the `{ 'plugin/shim': 'src/capture/shim/main.ts' }` entry AND the `{ 'plugin/learner': 'src/learner/stub.ts' }` entry, add:
     ```ts
     banner: { js: '#!/usr/bin/env node' }
     ```
     Also apply the same banner to `{ 'capture/shim': 'src/capture/shim/main.ts' }` for parity (internal use still goes through explicit `node`, but a shebang never hurts and makes the file self-executable for debugging).
   - `package.json` — extend the `postbuild` script from:
     ```
     "mkdir -p dist/plugin && cp -R plugin/. dist/plugin/ && chmod +x dist/plugin/shim.cjs"
     ```
     to also `chmod +x dist/plugin/learner.cjs` and `chmod +x dist/capture/shim.cjs`. Keep the existing `cp -R` step for the static `plugin/.claude-plugin/`, `plugin/hooks/` files.

   Requirements:
   - After `npm run build`:
     - `head -c 20 dist/plugin/shim.cjs` must start with `#!/usr/bin/env node`
     - `head -c 20 dist/plugin/learner.cjs` must start with `#!/usr/bin/env node`
     - `head -c 20 dist/capture/shim.cjs` must start with `#!/usr/bin/env node`
     - All three files must have exec bit set (`[ -x dist/plugin/shim.cjs ]`, etc.)
   - `sh -c 'dist/plugin/shim.cjs < /dev/null'` must exit 0 in <500ms with empty stdin. (This is the EXACT execution mode Claude Code uses. It must succeed.)
   - `sh -c 'dist/plugin/learner.cjs'` must exit 0 in <500ms with no stdin. (This is the mode launchd uses.)
   - tsup must NOT strip the banner during minification. Verify by re-running build multiple times.

   Acceptance:
   - `head -n 1 dist/plugin/shim.cjs` prints `#!/usr/bin/env node`
   - `head -n 1 dist/plugin/learner.cjs` prints `#!/usr/bin/env node`
   - `sh -c "dist/plugin/shim.cjs < /dev/null"; echo $?` prints `0`
   - `sh -c "dist/plugin/learner.cjs"; echo $?` prints `0`

2. **ARCHITECT: Fix marketplace manifest schema (BLOCKER C)**

   Files (MODIFIED):
   - `plugin/.claude-plugin/marketplace.json`

   Research step (REQUIRED, do not skip):
   - Attempt WebFetch of Claude Code plugin/marketplace documentation. Search terms: "Claude Code marketplace.json schema", "Claude Code plugin marketplace directory source".
   - Inspect `~/.claude/plugins/known_marketplaces.json` to find installed marketplace source URLs. Git-clone or curl one to see its working `marketplace.json` shape.
   - Inspect `~/.claude/marketplaces/repos/` for any already-fetched marketplace repos on this machine.
   - Record the findings (where the schema came from, what shape it mandates) in a comment at the top of the PR description or as an inline comment in the generated file. Do NOT commit without citing the source.

   Expected shape (confirm via research — do NOT commit this blindly):
   ```json
   {
     "name": "claude-sop",
     "description": "Auto-capture Claude Code turns and learn from mistakes.",
     "owner": { "name": "claude-sop" },
     "plugins": [
       {
         "name": "claude-sop",
         "description": "Auto-capture Claude Code turns and learn from mistakes.",
         "source": "./"
       }
     ]
   }
   ```
   If the string-path form is rejected, fall back to `"source": { "type": "directory", "path": "./" }`. The key insight: the current nested `"source": { "source": "directory", … }` is provably wrong because Claude Code's error says `plugins.0.source: Invalid input`.

   Requirements:
   - After `claude-sop install`, opening `/plugin` in Claude Code must show `claude-sop (user)` with NO "Failed to parse" error and NO "Invalid schema" error.
   - The Errors tab in `/plugin` must have zero claude-sop entries.
   - `plugin.json` is unchanged.

   Acceptance:
   - `jq -e '.plugins[0].name == "claude-sop"' plugin/.claude-plugin/marketplace.json` passes
   - `jq -e '.owner.name' plugin/.claude-plugin/marketplace.json` passes
   - `jq -e '.plugins[0].source | (type == "string") or (type == "object" and has("type"))' plugin/.claude-plugin/marketplace.json` passes (shape must be either string or object-with-`type`, NOT nested-source)
   - In a real Claude Code session opened against a fresh install, `/plugin` shows no errors for claude-sop (manual verification step; record outcome in the task's completion note).

3. **ARCHITECT: Fix learner stub env polarity (BUG A)**

   Files (MODIFIED):
   - `src/learner/stub.ts`

   Change:
   - Remove the `import { isCaptureDisabled } from '../capture/kill-switch.js';` line.
   - Remove the `if (isCaptureDisabled(process.env)) { process.exit(0); }` block.
   - Replace it with a pause check that reads from wherever `claude-sop pause` actually sets state. Research step: grep `src/cli/verbs/pause.ts` and `src/cli/verbs/resume.ts` to find the mechanism (env var, file flag, or config entry). Then mirror that check in the stub.
   - If pause state is a file flag (e.g. `~/.claude-sop/paused`), use `fs.existsSync` — no I/O beyond a single stat.
   - If pause state is a config value, read `~/.claude-sop/config.json` and check the field. Wrap in try/catch, fail-open (if the check itself errors, run the stub normally — do NOT exit).
   - The rest of the stub (append line to `ticks.log`, exit 0) is unchanged.

   Requirements:
   - `CLAUDE_SOP_LEARNER=1 node dist/plugin/learner.cjs` writes a line to `ticks.log` (it's the learner itself — not paused, not disabled).
   - `node dist/plugin/learner.cjs` (no env) also writes a line.
   - After `claude-sop pause`, running the stub (either mode above) does NOT write a line and exits 0.
   - After `claude-sop resume`, the stub writes again.
   - No change to `src/capture/kill-switch.ts`. No change to `tick.sh` template.

   Acceptance:
   - After `npm run build`:
     - `CLAUDE_SOP_LEARNER=1 node dist/plugin/learner.cjs && tail -1 ~/.claude-sop/logs/ticks.log` shows a `learner-stub` line timestamped within the last 5 seconds.
     - Create pause state (manually or via `claude-sop pause` if available); run stub; verify `ticks.log` did NOT grow.
     - Clear pause state; run stub; verify `ticks.log` grew by exactly one line.

4. **ARCHITECT: Fix doctor managed-section check (BUG B)**

   Files (MODIFIED):
   - Wherever the doctor `managed section` check lives — likely `src/cli/verbs/doctor.ts` or `src/doctor/checks.ts`. Grep for the exact string `0 directives` to find it.

   Change:
   - Current behavior (infer from code): `managed section` check fails when `directives.length === 0`, regardless of whether any directives were ever expected.
   - New behavior:
     - If `directives.length === 0`: check is **ok**, detail `no directives yet`. (Fresh install state. This is normal.)
     - If `directives.length > 0` AND the managed section is present in CLAUDE.md with matching content: **ok**, detail `<N> directives`.
     - If `directives.length > 0` AND the managed section is absent OR drift is detected: **fail**, detail `<N> directives not synced`. (This is the real failure mode.)
   - The `install` verb already reports `managed section  noop` correctly — doctor should now agree on a fresh box.

   Requirements:
   - On a fresh install (no directives), `claude-sop doctor` exits 0 and all checks report ok.
   - On a box with non-zero directives and a correctly synced CLAUDE.md section, doctor still reports ok.
   - On a box with non-zero directives and an absent/broken managed section, doctor still reports fail (regression guard — do NOT mask real drift).

   Acceptance:
   - `claude-sop doctor` in a fresh-install dogfood project exits 0
   - `claude-sop doctor --json | jq '.checks[] | select(.name=="managed section")'` shows `{ "status": "ok", ... }` when directives == 0
   - Existing Phase 2 doctor tests (if any) for the directives > 0 path still pass. If no such test exists, add one with a fixture that has 2 directives in the config and a matching CLAUDE.md — assert ok. Then one with 2 directives and no CLAUDE.md — assert fail.

5. **ARCHITECT: Extend smoke test for shell-mode execution + schema validation (regression guard)**

   Files (MODIFIED):
   - `test/smoke.test.ts`

   Add four new assertions:

   (a) **Shell-mode shim execution.** Spawn `sh` with `-c` pointing at `dist/plugin/shim.cjs` (absolute path). Pipe a minimal fake UserPromptSubmit JSON payload on stdin. Assert exit 0, assert completion in <500ms, assert no stderr on the "syntax error near unexpected token" pattern. This is the exact execution mode Claude Code uses for hook commands.

   (b) **Shell-mode learner execution.** Same as (a) but no stdin, for `dist/plugin/learner.cjs`. Assert exit 0 and no shell parse errors. This is the mode launchd uses via `tick.sh`.

   (c) **Marketplace schema shape validation.** Read `dist/plugin/.claude-plugin/marketplace.json`. Assert:
   - `name === 'claude-sop'`
   - `owner.name` is a non-empty string
   - `plugins` is a non-empty array
   - `plugins[0].name === 'claude-sop'`
   - `plugins[0].source` is EITHER a string OR an object with a `type` field (NOT a nested `source` field)
   - Explicitly: `typeof plugins[0].source === 'object' && 'source' in plugins[0].source` must be FALSE. (This is the exact bug that v5 shipped — guard against it returning.)

   (d) **Shebang presence.** Read first 20 bytes of `dist/plugin/shim.cjs`, `dist/plugin/learner.cjs`, `dist/capture/shim.cjs`. Assert each starts with `#!/usr/bin/env node\n`. Also stat each file and assert the exec bit is set (`(mode & 0o111) !== 0`).

   Requirements:
   - All four new assertions pass after a clean build.
   - Reverting any single task 1–3 change causes the relevant assertion(s) to fail.
   - Existing v4/v5 assertions still pass.
   - Total smoke test count goes from 8 → 12+.

   Acceptance:
   - `npm run test:smoke` exits 0 with the new test count
   - `git stash push plugin/.claude-plugin/marketplace.json` → restore the broken v5 shape → smoke test fails assertion (c) with a clear message mentioning `plugins[0].source`
   - Temporarily removing the `banner` from `tsup.config.ts` → rebuild → smoke fails assertion (d)

## Quality Gates (MANDATORY)

6. **YODA: Code review** — stub rewrite (polarity), doctor check logic (state-aware), smoke test additions (shell execution mode), tsup banner config. Look for: fail-open violations, doctor check masking real drift, brittle shebang handling. **100% approval required.**

7. **APEX: Security review** — focus on:
   (a) Does adding a shebang + exec bit to shim.cjs change any threat surface? (It shouldn't — the file was already being `require()`d by node; making it directly executable is a no-op for privilege.)
   (b) Pause-flag file check in the stub: is there a TOCTOU between check-pause and append-log? (For a stub this is irrelevant, but Phase 3's real learner will care — note it for the record.)
   (c) Marketplace schema: does any plugin source type other than `directory` expose a path-traversal or remote-fetch risk? Our plugin uses `directory` only, but note what Claude Code's schema allows for future reference.
   **Must pass P0/P1.**

8. **ANALYZER: Code improvement review** — stub, doctor check, smoke tests. Grade must be **C or above.**

(No PRISM: no UI surface.)

## Finalize

9. **ARCHITECT: Commit all changes** with message:
   ```
   fix(phase2): shim shebang + marketplace schema + stub polarity + doctor logic — POC dogfood round 2
   ```

## Acceptance Criteria (POC-level validation, round 2)

After this plan lands AND the user runs the post-plan refresh sequence (see "Post-plan steps for the user" below), ALL of these must hold:

- `npm run build && npm run test:smoke` exits 0, test count ≥ 12
- `head -1 dist/plugin/shim.cjs` == `#!/usr/bin/env node`
- `head -1 dist/plugin/learner.cjs` == `#!/usr/bin/env node`
- `sh -c "dist/plugin/shim.cjs < /dev/null"` exits 0 in <500ms with no shell parse error
- After `claude-sop install` in the dogfood project:
  - `claude-sop doctor` exits 0, all 9 checks report ok
  - Opening Claude Code in the project, issuing a real prompt, and getting a normal response works (no "operation blocked by hook")
  - `/plugin` shows `claude-sop (user)` with no parse error, no Errors tab entries
  - `~/.claude-sop/captures/<project-slug>/<turn-id>/turn.json` exists with `events.length ≥ 2` after one real turn
  - `~/.claude-sop/logs/ticks.log` has at least one `learner-stub` line after a manual `launchctl kickstart`
  - `~/.claude-sop/logs/errors.log` is empty (no MODULE_NOT_FOUND, no shell parse errors, no new stack traces)

## Post-plan steps for the user (not part of the plan's work, but necessary for validation)

After Commander finishes v6:

```bash
# 1. Pause/uninstall the broken v5 state in any project that has it, to avoid blocked prompts
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop uninstall --keep-data

# 2. Refresh the global binary
cd ~/Developer/claude-sop
npm run build
npm run test:smoke
npm pack
npm i -g ./claude-sop-0.0.0.tgz

# 3. Clean slate the installed bundle
launchctl bootout "gui/$UID/com.claude-sop.learner" 2>/dev/null || true
rm -rf ~/.claude-sop/marketplace/claude-sop
: > ~/.claude-sop/logs/errors.log
rm -f ~/.claude-sop/logs/ticks.log

# 4. Fresh install into dogfood project
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop install
claude-sop doctor   # must exit 0, all 9 ok

# 5. Live validation
launchctl kickstart -k "gui/$UID/com.claude-sop.learner"
sleep 2
tail ~/.claude-sop/logs/ticks.log           # expect: learner-stub line
cat ~/.claude-sop/logs/errors.log            # expect: empty

# 6. Real turn
claude
# inside: /plugin → verify no errors; issue one prompt; /exit
find ~/.claude-sop/captures -name 'turn.json' | head -1 | xargs -I{} jq '{events: (.events|length)}' {}
```

Success = all six steps pass with no user-visible error in Claude Code.

## Out of Scope (explicit non-goals)

- Phase 3 real learner logic (directives, recall, learner gate).
- Rewriting `tick.sh` or the installer scheduler-bootstrap logic.
- Adding `CLAUDE_SOP_PAUSED` wiring if it doesn't exist — if pause state is a file flag, use that; don't invent new mechanisms.
- Changing `kill-switch.ts` or the shim's recursion-guard semantics. The shim is correct; only the learner stub was wrong to reuse it.
- Cleaning up the stray `claude-sop-0.0.0.tgz` at repo root.
- Documenting the marketplace schema as project-level docs — just cite the source in the task completion note.

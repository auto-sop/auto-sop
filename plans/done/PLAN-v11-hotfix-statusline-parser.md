# PLAN-v11 — Hotfix: Statusline Parser Reads Wrong Nesting Level

## Overview

v10 shipped the `claude-sop statusline` verb. Real-world dogfood in `~/Developer/wrbeautiful-shopify-theme` revealed that the verb **always returns `[sop:off]` even when claude-sop is correctly installed with 5/5 hooks wired**. Root cause: the `detectHooks` function in `src/cli/verbs/statusline.ts` parses `.claude/settings.json` at the wrong nesting level.

**Proof of the bug:**
```
$ grep -c 'claude-sop' ~/Developer/wrbeautiful-shopify-theme/.claude/settings.json
10                    # 5 command paths + 5 id strings = 10 matches
$ claude-sop statusline
[sop:off]             # WRONG — should be [sop:on]
$ claude-sop statusline --json
{"on":false,"project_slug":"wrbeautiful-shopify-theme","project_root":"..."}
```

**User impact:** The statusline indicator — the whole UX point of Q6/Task 4 from v10 — is broken for every real user. The Claude Code statusline always shows `[sop:off]` regardless of actual state. A user adds the statusline command to their global Claude Code settings, expects to see `[sop:on]` in installed projects, gets `[sop:off]` everywhere, concludes the plugin is broken, uninstalls.

## Root Cause

### What Claude Code's settings.json actually looks like

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/…/claude-sop/marketplace/claude-sop/shim.cjs",
            "id": "claude-sop"
          }
        ]
      }
    ],
    "Stop":  [ /* same shape */ ],
    "PreToolUse":  [ /* same shape */ ],
    "PostToolUse": [ /* same shape */ ],
    "SubagentStop": [ /* same shape */ ]
  },
  "statusLine": { /* ... */ },
  "permissions": { /* ... */ }
}
```

The structure is **three levels deep**:
1. Top-level `hooks` key (literal string `"hooks"`)
2. Inside that, event-name keys (`UserPromptSubmit`, `Stop`, …)
3. Each event-name value is an array of entries
4. Each entry has its own nested `hooks` array containing the actual hook definitions

### What v10's parser actually does

```ts
// src/cli/verbs/statusline.ts
function detectHooks(projectRoot: string): boolean {
  try {
    const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;

    const obj = parsed as Record<string, unknown>;
    for (const key of Object.keys(obj)) {              // iterates TOP-level keys
      const val = obj[key];                             // "hooks", "statusLine", "permissions", ...
      if (typeof val !== 'object' || val === null) continue;
      const entry = val as Record<string, unknown>;
      if (!Array.isArray(entry.hooks)) continue;        // ← val.hooks doesn't exist on any top-level key
      for (const hook of entry.hooks) {                 //    except for nested entries TWO levels down
        // never reached
      }
    }
    return false;  // always reached, always false
  } catch {
    return false;
  }
}
```

The loop walks top-level keys (`hooks`, `statusLine`, `permissions`, `enabledPlugins`, …) and treats each value as if it directly has a `hooks: [...]` array property. **None of them do**, because the real structure needs:
- `parsed.hooks` (drop into top-level hooks object)
- `Object.keys(hooks)` (iterate event names)
- `hooks[eventName]` (get array of entries)
- `entries[i].hooks` (get array of actual hook definitions)
- `hooks[j].command` (check the command string)

### Why the unit tests missed it

`test/cli/verbs/statusline.test.ts` has 10 passing tests, but every fixture uses a **simplified settings.json structure that doesn't match Claude Code's real schema**. Specifically, the fixtures probably structure the file as:

```json
{ "UserPromptSubmit": { "hooks": [ { "command": ".../claude-sop/..." } ] } }
```

or similar — missing the top-level `hooks` wrapper. Under that incorrect structure, the v10 parser's logic happens to work (it walks top-level keys, finds one with a `hooks` array, matches). So tests pass but production fails.

**This is the fourth test-false-positive class bug in this project** (v4/v5/v7/v10). Pattern: tests don't reflect real execution environment. Each time the fix is "make the test load the real production shape".

## Architecture Decisions

- **Fix the parser, not the test in isolation.** Rewrite `detectHooks` to walk the real three-level structure. Keep the fail-closed semantics (any error → `false`).
- **Add a new fixture file `test/cli/verbs/fixtures/real-settings.json`** containing a byte-for-byte copy of a Claude Code settings.json shape, ideally captured from an actual `claude-sop install` run. Use this fixture in the test — not a hand-built simplified object literal.
- **Add a regression test that specifically uses the same structure we found broken in dogfood.** Name it clearly: `detects claude-sop hooks in real Claude Code settings.json structure (v11 regression)`.
- **Do not touch the rest of the statusline verb.** The `--json` mode, `deriveSlug`, the fail-closed path — all correct. Only `detectHooks` is broken.
- **Add a smoke-level assertion.** The v10 smoke tests `(p)` and `(q)` check statusline against fixture settings.json, but evidently with the wrong structure. Update those fixtures AND add a new one that reproduces the exact wrbeautiful-shopify-theme file shape.
- **Manual verification step included in acceptance criteria.** After the fix, user must run `claude-sop statusline` in the dogfood project and see `[sop:on]`. This is the only way to guarantee the bug is really dead — because if we only trust the tests, we've demonstrated four times that tests can lie.

## Phase 0: Advisory

None.

## Implementation Tasks

### Wave 1 — single ARCHITECT, sequential

1. **ARCHITECT: Fix `detectHooks` parser**

   Files (MODIFIED):
   - `src/cli/verbs/statusline.ts` — rewrite the `detectHooks` function to walk the correct three-level structure. Keep the function signature, fail-closed semantics, and <50ms perf constraint unchanged.

   New implementation (target):
   ```ts
   function detectHooks(projectRoot: string): boolean {
     try {
       const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
       const raw = readFileSync(settingsPath, 'utf8');
       const parsed: unknown = JSON.parse(raw);
       if (typeof parsed !== 'object' || parsed === null) return false;

       // Top-level key is literally "hooks", whose value is an object
       // keyed by event names (UserPromptSubmit, Stop, PreToolUse, …).
       const hooks = (parsed as Record<string, unknown>).hooks;
       if (typeof hooks !== 'object' || hooks === null) return false;

       // Each event-name value is an array of entries, each with a nested
       // "hooks" array of actual hook definitions.
       for (const eventName of Object.keys(hooks as Record<string, unknown>)) {
         const entries = (hooks as Record<string, unknown>)[eventName];
         if (!Array.isArray(entries)) continue;
         for (const entry of entries) {
           if (
             typeof entry !== 'object' ||
             entry === null ||
             !Array.isArray((entry as Record<string, unknown>).hooks)
           ) continue;
           for (const hook of (entry as Record<string, unknown>).hooks as unknown[]) {
             if (
               typeof hook === 'object' &&
               hook !== null &&
               typeof (hook as Record<string, unknown>).command === 'string' &&
               ((hook as Record<string, unknown>).command as string).includes('claude-sop')
             ) {
               return true;
             }
           }
         }
       }
       return false;
     } catch {
       return false;
     }
   }
   ```

   Requirements:
   - The function traverses exactly three levels (top-level `hooks` → event name → `entries[i].hooks`) before checking the `command` string.
   - It uses `.includes('claude-sop')` on the command string (substring match, not exact equality).
   - Any structural mismatch (missing `hooks` key, non-object, non-array at any level) returns `false` without throwing.
   - JSON parse errors return `false` (existing fail-closed semantics preserved).
   - Permission denied / missing file returns `false` (preserved).
   - No I/O beyond the one `readFileSync`, no async, no spawns.

   Acceptance:
   - Manual: `claude-sop statusline` in `~/Developer/wrbeautiful-shopify-theme` prints `[sop:on]`
   - Manual: `claude-sop statusline --json` returns `{"on":true,...}` in that project
   - Manual: `claude-sop statusline` in `/tmp` or any non-installed directory prints `[sop:off]`
   - Manual: removing just the hooks entries from the settings.json but keeping an empty `"hooks":{}` still returns `[sop:off]`
   - Automated: perf benchmark test (see Task 3) — 10 consecutive invocations all <100ms

2. **ARCHITECT: Rewrite unit tests with real Claude Code settings.json fixtures**

   Files (NEW):
   - `test/cli/verbs/fixtures/real-settings-installed.json` — a byte-for-byte copy of `~/Developer/wrbeautiful-shopify-theme/.claude/settings.json` (the exact shape that fails in v10). Sanitize any real paths to synthetic placeholders like `/synthetic/home/.claude-sop/marketplace/claude-sop/shim.cjs`, but keep the structure identical.
   - `test/cli/verbs/fixtures/real-settings-not-installed.json` — a Claude Code settings.json with hooks section but NO claude-sop entries. Keep other hooks (e.g. a `SessionStart` hook for an unrelated tool) to verify non-claude-sop hooks aren't false-positive matched.
   - `test/cli/verbs/fixtures/real-settings-empty-hooks.json` — has `"hooks": {}` empty object.
   - `test/cli/verbs/fixtures/real-settings-no-hooks-key.json` — Claude Code settings without any `hooks` top-level key at all.

   Files (MODIFIED):
   - `test/cli/verbs/statusline.test.ts` — replace any hand-built fixture object literals with `readFileSync` of the new fixture files. Add the following test cases (or replace existing ones):

   Required test cases:
   - `detects claude-sop hooks in real Claude Code settings.json structure (v11 regression)` — loads `real-settings-installed.json`, asserts `[sop:on]`
   - `does not match when non-claude-sop hooks present` — loads `real-settings-not-installed.json`, asserts `[sop:off]`
   - `does not match when hooks object is empty` — loads `real-settings-empty-hooks.json`, asserts `[sop:off]`
   - `does not match when hooks key missing entirely` — loads `real-settings-no-hooks-key.json`, asserts `[sop:off]`
   - `returns false on malformed JSON` — write `{not valid json` to a tmpfile, assert `[sop:off]`
   - `returns false when settings.json is absent` — no file, assert `[sop:off]`
   - `returns false when .claude/ directory is missing` — assert `[sop:off]`
   - `substring match — hook command path contains 'claude-sop' somewhere` — fixture with command `/opt/bin/claude-sop-wrapper.sh` should match (substring)
   - `mixed hooks — one claude-sop hook among several non-claude-sop hooks` — asserts `[sop:on]` (any match wins)
   - `deeply nested false — entry.hooks array exists but none have command matching` — asserts `[sop:off]`

   Requirements:
   - Every test uses a REAL fixture file, not an inline object literal.
   - The `real-settings-installed.json` fixture file MUST have at minimum: top-level `hooks` key, containing at least one event name, containing at least one entry, containing at least one `hook.command` with `claude-sop` substring. Document this structure in a comment at the top of the test file.
   - Fixture paths resolved via `path.join(__dirname, 'fixtures', '...')` so tests are location-independent.
   - Tests run against `detectHooks` directly via module import (white-box unit test) AND against the built CLI via `execa` spawn (black-box end-to-end) — both must pass.

   Acceptance:
   - `npm run test` includes the new test cases, all pass
   - Reverting Task 1's parser fix causes EVERY new positive-match test to fail with a clear diagnostic (`expected [sop:on] but got [sop:off]`)
   - Reverting the fixture files and using the old object-literal fixtures causes tests to pass on v10's broken code — this confirms the old tests were lying. (You don't have to keep this reversion; it's just a manual sanity check documented in the task completion note.)

3. **ARCHITECT: Perf guard + smoke test update**

   Files (MODIFIED):
   - `test/cli/verbs/statusline.test.ts` — add a perf assertion:
     ```ts
     it('statusline verb runs in under 100ms on warm box', async () => {
       const fixturePath = join(__dirname, 'fixtures', 'real-settings-installed.json');
       const tmpProject = mkdtempSync(join(tmpdir(), 'statusline-perf-'));
       mkdirSync(join(tmpProject, '.claude'));
       copyFileSync(fixturePath, join(tmpProject, '.claude', 'settings.json'));

       const durations: number[] = [];
       for (let i = 0; i < 10; i++) {
         const start = Date.now();
         const result = execaSync('node', [cliPath, 'statusline', '--project', tmpProject]);
         durations.push(Date.now() - start);
         expect(result.stdout).toBe('[sop:on]');
       }
       const p95 = durations.sort((a, b) => a - b)[9];
       expect(p95).toBeLessThan(200);  // generous ceiling; we expect <100ms usually

       rmSync(tmpProject, { recursive: true, force: true });
     }, 15000);
     ```
   - `test/smoke.test.ts` — the existing `(p)` and `(q)` tests in the `managed section end-to-end (isolated)` group must also be updated to use real settings.json structures. Either inline the new fixture content into the test setup, or have the smoke test copy the fixture file into the tmp bundle.

   Requirements:
   - Perf test uses 200ms ceiling (generous — laptop + CI variance) but expects typical <100ms
   - Smoke (p) and (q) tests remain, but with real-structured fixtures
   - No changes to v9/v10 smoke tests outside the (p) and (q) cases

   Acceptance:
   - `npm run test:smoke` still passes 37+ tests after fixture updates
   - Perf test p95 under 200ms locally

## Quality Gates (MANDATORY)

4. **YODA: Code review** —
   - Parser correctness: does every code path match the real Claude Code schema?
   - Fail-closed invariant preserved: any error/mismatch returns `false`
   - Test fixtures are REAL copies of Claude Code settings.json, not hand-built object literals
   - No performance regression from the fix (parser is still synchronous, no spawns)
   **100% approval required.**

5. **APEX: Security review** —
   - `detectHooks` reads settings.json — no change to attack surface
   - `.includes('claude-sop')` substring match: could a malicious settings.json with an unrelated command containing "claude-sop" substring trigger false positive? (Acceptable — the check is "is claude-sop probably wired", not "is this definitely claude-sop's shim". False positives here are fine; false negatives — the v10 bug — are the real threat.)
   - Fixture files must NOT contain real secrets, real user paths, real session IDs, or any other PII. Audit fixture content in review.
   - Perf test runs `execa` — confirm no leftover tmpdirs on failure paths.
   **Must pass P0/P1.**

6. **ANALYZER: Code improvement review** — grade the parser rewrite + new tests + fixture files. **Must be C or above.** Flag any lingering `any` casts in the parser and propose tighter types.

(No PRISM.)

## Finalize

7. **ARCHITECT: Commit** with message:
   ```
   fix(phase4-light): statusline parser reads real Claude Code settings.json structure
   ```

## Acceptance Criteria (POC-level validation, v10.1)

After this plan lands AND the user runs the refresh sequence, ALL of these hold:

- `npm run test` and `npm run test:smoke` both green with new tests
- `claude-sop statusline` in `~/Developer/wrbeautiful-shopify-theme` prints `[sop:on]` (manual)
- `claude-sop statusline` in `/tmp` prints `[sop:off]` (manual)
- `claude-sop statusline --json` in installed project emits `{"on":true,...}`
- Claude Code's statusLine integration (if wired) now shows `[sop:on]` when in the dogfood project
- No regression in v10 features (CLAUDE.md writing, dry-run, directive column, etc.)

## Post-plan steps for the user

```bash
cd ~/Developer/claude-sop
git log --oneline -3    # expect: fix(phase4-light): statusline parser ...

npm run build
npm run test            # all tests pass including new statusline cases
npm run test:smoke      # still 37+

wc -c dist/cli.js       # size grew by ~1 KB (parser rewrite + extra checks)

npm pack
npm i -g ./claude-sop-0.0.0.tgz

# Refresh the marketplace bundle in the dogfood project
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop uninstall
claude-sop install

# Manual validation — the three checks that must pass
claude-sop statusline; echo
# expect: [sop:on]

cd /tmp
claude-sop statusline; echo
# expect: [sop:off]

cd ~/Developer/wrbeautiful-shopify-theme
claude-sop statusline --json
# expect: {"on":true,"project_slug":"wrbeautiful-shopify-theme","project_root":"..."}

# If the statusline is wired in ~/.claude/settings.json, restart Claude Code and
# verify the prompt area shows [sop:on] when inside the shopify project.
```

## Out of Scope

- Redesigning the statusline verb API — keep it exactly as v10 shipped
- Adding richer statusline output (colors, turn counts, etc.) — v11+ concern
- Fixing the v10 flaky perf test (`shim runs via sh -c 507ms vs 500ms limit`) — separate cosmetic cleanup
- Expanding `detectHooks` to detect more than `.command.includes('claude-sop')` — keep the existing semantics, just parse correctly
- Touching any other v10 code — this is a surgical 1-file + 4-fixture + test update

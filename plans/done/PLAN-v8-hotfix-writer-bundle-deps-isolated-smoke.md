# PLAN-v8 — Hotfix: Writer Runtime Deps Not Bundled + Isolated E2E Smoke Test

## Overview

v7 staged `writer.cjs` into the plugin bundle and the smoke test passed. Real-turn dogfood in `~/Developer/wrbeautiful-shopify-theme` immediately revealed that **writer.cjs silently crashes on every real invocation** with `Cannot find module 'zod'`. The shim spawns the writer with `detached: true, stdio: "ignore"`, so the MODULE_NOT_FOUND stack is invisible: no errors.log entry, no stderr anywhere, shim still exits 0 (fail-open), and 4 stranded payloads pile up in `~/.claude-sop/tmp/` with zero `turn.json` on disk.

**Proof obtained by running the writer manually against a stranded payload:**
```
$ node ~/.claude-sop/marketplace/claude-sop/writer.cjs /Users/…/tmp/0LTF2lNk59PFNSVE.json
Error: Cannot find module 'zod'
Require stack:
- /Users/ugurgokdere/.claude-sop/marketplace/claude-sop/writer.cjs
```

## Root cause

The writer's tsup entry only bundles `['nanoid', 'execa']`:
```ts
// tsup.config.ts — "Capture writer: detached grandchild entrypoint (FROZEN after plan 01-03)"
{
  entry: { 'capture/writer': 'src/capture/writer/main.ts' },
  bundle: true,
  minify: true,
  noExternal: ['nanoid', 'execa'],   // ← missing zod, proper-lockfile, everything else
  ...
}
```

The writer imports (directly or transitively) at least:
- `zod` — schema validation (transitive, probably via a shared config/schema module)
- `proper-lockfile` — the comment on `tick.sh` even says "locking is done INSIDE the learner via proper-lockfile"; the writer uses `lockSync/unlockSync` from it directly
- Possibly others (the `noExternal: ['nanoid', 'execa']` is a lie about what's actually reachable)

In development, `require('zod')` from `dist/capture/writer.cjs` walks up the tree, finds `~/Developer/claude-sop/node_modules/zod`, and succeeds. **In production**, the installed `~/.claude-sop/marketplace/claude-sop/writer.cjs` has NO ancestor `node_modules` anywhere up the path tree, so every `require()` for a non-bundled dep fails.

This is a **pre-existing Phase 1 bug** that was invisible until v7 finally made the writer reachable from the installed bundle. Phase 1's original design evidently expected the writer to live somewhere with node_modules available (likely inside the npm package dir `$(npm root -g)/claude-sop/node_modules/…`), but Phase 2's installer copies only `dist/plugin/` to `~/.claude-sop/marketplace/claude-sop/`, not `node_modules/`.

The "FROZEN after plan 01-03" comment on the writer tsup entry is now stale — we're thawing it.

## Root cause #2 — the smoke test was a FALSE POSITIVE

v7's end-to-end smoke test (`shim → writer pipeline produces meta.json for UserPromptSubmit`) passed while production was broken. Why?

The test spawned `dist/plugin/shim.cjs` from inside `~/Developer/claude-sop/`. When the shim forked the writer, Node's module resolution walked UP from `dist/plugin/` and found the repo's own `~/Developer/claude-sop/node_modules/zod`. The test passed, the bundle was shipped, and it crashed in production the first time a real user invoked it outside the repo.

**Setting `HOME=<tmpdir>` in the test env isolated `os.homedir()` but NOT `require()`'s module search path.** Module resolution walks up the **physical file path** of the script being executed, not from cwd, not from `HOME`. The only way to isolate require() is to physically relocate the bundle outside the repo tree.

Without fixing this test design, v8 could pass CI smoke and still ship broken the same way. Four bundle-layout regressions in a row have taught us: **smoke tests must reflect production execution environment, not developer execution environment.**

## Architecture Decisions

- **Writer tsup entry bundles everything non-node-builtin.** Change `noExternal: ['nanoid', 'execa']` to `noExternal: [/.*/]` on the `capture/writer` entry. This forces tsup to inline every non-node: import, including transitive ones (zod, proper-lockfile, graceful-fs, etc.). Expected bundle size grows from 140 KB to somewhere in the 200–400 KB range (zod alone is ~50 KB minified). Acceptable: this file runs once per hook, the size cost is negligible.
- **Verify via bundle introspection, not runtime.** After the build, grep the built `dist/capture/writer.cjs` for `require(` calls to any non-`node:` module. The only permissible runtime `require()` calls should be for node builtins (e.g. `require('fs')`, `require('path')`, `require('node:crypto')`). A grep for `require\(['"](?!node:|\./)` (i.e. require of a bare module name that isn't a node: import or a relative path) must return zero matches. If it returns matches, the bundle is incomplete — fail the build.
- **Isolated e2e smoke: the bundle is copied out of the repo before execution.** Revised test flow:
  1. `fs.mkdtemp(os.tmpdir() + '/claude-sop-isolated-')` → creates `<tmpRoot>`
  2. `fs.mkdir(<tmpRoot>/bundle)` and `fs.cp` the contents of `dist/plugin/` into `<tmpRoot>/bundle/` (shim, learner, writer, hooks, .claude-plugin — the full installed-bundle layout)
  3. Spawn `sh -c '<tmpRoot>/bundle/shim.cjs'` with `cwd: <tmpRoot>`, `env: { ...process.env, HOME: <tmpRoot>, PATH: process.env.PATH }`
  4. Now `<tmpRoot>/bundle/shim.cjs` is in `/var/folders/…/claude-sop-isolated-XXX/bundle/` — there is NO ancestor `node_modules` anywhere up the path. `require('zod')` either works because it's bundled, or fails hard exactly like in production.
  5. Poll for `turn.json` under `<tmpRoot>/.claude-sop/captures/` for up to 5 seconds
  6. On failure, dump `<tmpRoot>/.claude-sop/tmp/` contents AND run `node <tmpRoot>/bundle/writer.cjs <any-stranded-tmp-file>` to surface the actual crash in the test output (this is the diagnostic that would have made v7's false positive impossible to miss)
  7. Clean up `<tmpRoot>` in `afterAll`
- **Also relocate the v7 `shim → writer pipeline produces meta.json` test into isolation.** The existing test has the same false-positive risk. Either delete it and replace with the isolated version, or update it in place to copy the bundle to a tmpdir first. Do NOT keep both — one good isolated test is better than a good test plus a false-positive test that gives misleading green signal.
- **No source changes outside tsup config + smoke test.** Writer source is correct; it's the bundling that's wrong.
- **Regression guard on tsup itself.** Add a smoke assertion: `grep -E "require\(['\"][a-z@]" dist/plugin/writer.cjs | grep -v "require\(['\"]node:" | grep -v "require\(['\"]\\."` must return zero lines. If anyone in the future shrinks `noExternal` back to a list, this test trips immediately.

## Phase 0: Advisory

None.

## Implementation Tasks

### Wave 1 — one ARCHITECT, sequential

1. **ARCHITECT: Bundle all writer runtime deps (BLOCKER)**

   Files (MODIFIED):
   - `tsup.config.ts` — on the `capture/writer` entry, change:
     ```ts
     noExternal: ['nanoid', 'execa'],
     ```
     to:
     ```ts
     noExternal: [/.*/],
     ```
     Also remove the stale `(FROZEN after plan 01-03)` comment — it's actively misleading at this point. Replace with: `// Capture writer: detached grandchild entrypoint — ALL runtime deps bundled (no ancestor node_modules in installed bundle)`.

   Requirements:
   - After `npm run build`:
     - `dist/capture/writer.cjs` and `dist/plugin/writer.cjs` both exist, byte-identical (postbuild cp is unchanged).
     - Bundle size has grown (sanity: was ~140 KB, expect 200–500 KB). If it's still ~140 KB, the change didn't take effect.
     - Running `node -e "require('/path/to/dist/plugin/writer.cjs')"` from a directory with NO ancestor node_modules (use `/tmp/` as cwd, and copy writer.cjs to `/tmp/` first) must NOT crash with MODULE_NOT_FOUND. The ONLY acceptable failure mode for this smoke-run is "missing argv[2] payload file" or similar — not "cannot find module".
     - More concretely: `cp dist/plugin/writer.cjs /tmp/writer-smoke.cjs && node /tmp/writer-smoke.cjs /dev/null 2>&1 | grep -q "Cannot find module"` must return exit 1 (no match).
   - No source changes under `src/`.
   - `npm run test:smoke` still passes after the change (the existing tests that run the writer will now be testing the properly-bundled version).

   Acceptance:
   - `test -f dist/capture/writer.cjs && test -f dist/plugin/writer.cjs`
   - `cmp dist/capture/writer.cjs dist/plugin/writer.cjs` exits 0
   - `wc -c < dist/plugin/writer.cjs` shows a byte count of at least 180000 (sanity: zod alone adds ~50 KB; if the number hasn't grown, noExternal didn't apply)
   - Grep assertion: bundle must not contain bare-name runtime requires.
     ```sh
     grep -oE "require\\(['\"][^'\"]+['\"]\\)" dist/plugin/writer.cjs \
       | grep -vE "require\\(['\"](node:|\\./)" \
       | grep -vE "require\\(['\"](fs|path|os|crypto|util|stream|zlib|child_process|events|assert|buffer|url|net|tls|http|https|querystring|string_decoder|timers|tty|v8|vm|worker_threads|async_hooks|perf_hooks|readline|repl|constants|module|process|dgram|dns|cluster|domain|punycode|inspector|trace_events|wasi|diagnostics_channel)['\"]\\)" \
       | wc -l
     ```
     This must print `0`. Any non-node-builtin bare require in the final bundle is a bundling gap.
   - Isolated smoke run: `cp dist/plugin/writer.cjs /tmp/w.cjs && cd /tmp && node w.cjs /dev/null 2>&1` must NOT contain the string `Cannot find module`. It WILL crash with some other error (probably JSON parse on `/dev/null` payload) — that's fine, we're only checking module resolution.

2. **ARCHITECT: Isolated end-to-end smoke test (regression guard — no more false positives)**

   Files (MODIFIED):
   - `test/smoke.test.ts`

   Rewrite the existing `smoke: end-to-end capture pipeline` group. The new flow:

   ```ts
   import { mkdtemp, cp, rm } from 'node:fs/promises';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { execa } from 'execa';

   describe('smoke: end-to-end capture pipeline (isolated from repo node_modules)', () => {
     let tmpRoot: string;

     beforeAll(async () => {
       tmpRoot = await mkdtemp(join(tmpdir(), 'claude-sop-isolated-'));
       // CRITICAL: copy the entire plugin bundle OUT of the repo tree
       // so require() can't find ancestor node_modules
       await cp(
         join(repoRoot, 'dist', 'plugin'),
         join(tmpRoot, 'bundle'),
         { recursive: true },
       );
     });

     afterAll(async () => {
       await rm(tmpRoot, { recursive: true, force: true });
     });

     it('shim → writer pipeline writes turn.json under isolated HOME', async () => {
       const payload = JSON.stringify({
         session_id: 'smoke-e2e',
         transcript_path: join(tmpRoot, 'fake-transcript.jsonl'),
         cwd: join(tmpRoot, 'fake-project'),
         permission_mode: 'default',
         hook_event_name: 'UserPromptSubmit',
         prompt: 'smoke test prompt',
       });

       const shimPath = join(tmpRoot, 'bundle', 'shim.cjs');

       const result = await execa('sh', ['-c', shimPath], {
         cwd: tmpRoot,
         input: payload,
         env: {
           ...process.env,
           HOME: tmpRoot,
         },
         reject: false,
       });

       expect(result.exitCode).toBe(0);
       expect(result.stderr).not.toMatch(/Cannot find module/);
       expect(result.stderr).not.toMatch(/syntax error/i);

       // Poll for turn.json
       const capturesDir = join(tmpRoot, '.claude-sop', 'captures');
       const start = Date.now();
       const deadline = start + 5000;
       let turnPath: string | null = null;

       while (Date.now() < deadline) {
         const found = await findFirst(capturesDir, 'turn.json');
         if (found) {
           turnPath = found;
           break;
         }
         await sleep(250);
       }

       if (!turnPath) {
         // Diagnostic dump on failure
         const tmpFiles = await listSafe(join(tmpRoot, '.claude-sop', 'tmp'));
         const captureTree = await listSafe(capturesDir);
         const errorsLog = await readSafe(
           join(tmpRoot, '.claude-sop', 'logs', 'errors.log'),
         );
         // Re-run the writer manually against the stranded payload to surface crashes
         let writerDiagnostic = '';
         if (tmpFiles.length > 0) {
           const strandedPayload = join(
             tmpRoot,
             '.claude-sop',
             'tmp',
             tmpFiles[0],
           );
           const writerResult = await execa(
             'node',
             [join(tmpRoot, 'bundle', 'writer.cjs'), strandedPayload],
             { cwd: tmpRoot, reject: false },
           );
           writerDiagnostic = `writer exit=${writerResult.exitCode}\nstdout=${writerResult.stdout}\nstderr=${writerResult.stderr}`;
         }

         throw new Error(
           `turn.json not produced within 5s.\n` +
             `tmp/ files: ${JSON.stringify(tmpFiles)}\n` +
             `captures/ tree: ${JSON.stringify(captureTree)}\n` +
             `errors.log: ${errorsLog}\n` +
             `writer manual run:\n${writerDiagnostic}`,
         );
       }

       // Validate the turn
       const turnJson = JSON.parse(await readFile(turnPath, 'utf8'));
       expect(turnJson.events).toBeInstanceOf(Array);
       expect(turnJson.events.length).toBeGreaterThanOrEqual(1);
       expect(turnJson.events.map((e: any) => e.type)).toContain(
         'UserPromptSubmit',
       );
     });
   });
   ```

   Helpers (`findFirst`, `listSafe`, `readSafe`, `sleep`) — implement inline or import from an existing test-utils file if one exists in the repo. Keep them ≤10 lines each.

   Requirements:
   - The test must fail **loudly with the writer stderr** if the bundle is broken, not just time out. The diagnostic dump re-runs the writer manually with `reject: false` to capture its stdout/stderr, so MODULE_NOT_FOUND errors appear in the test failure message.
   - The test MUST be run from OUTSIDE any directory where an ancestor `node_modules` contains `zod`. The `tmpdir()` location (`/var/folders/…` on macOS, `/tmp` on Linux) satisfies this by construction.
   - The test must pass on a clean `npm run build && npm run test:smoke` with the v8 bundling fix.
   - The test must FAIL with a clear `Cannot find module 'zod'` message if task 1's tsup change is reverted. Verify this manually before marking the task done: revert `noExternal: [/.*/]` back to `noExternal: ['nanoid', 'execa']`, rebuild, run the test, confirm it fails with the expected diagnostic, restore `noExternal: [/.*/]`, rebuild, run again, confirm it passes. Document the manual verification in the task completion note.
   - The existing v7 "shim → writer pipeline produces meta.json" test is REPLACED by this, not duplicated. If the v7 test had assertion logic the new test doesn't cover, port it over; otherwise delete the v7 version.
   - `tmpRoot` is cleaned up on both success and failure.

   Acceptance:
   - `npm run test:smoke` exits 0, total count ≥ 18 (one less than v7's 19 because we're replacing one test, but adding diagnostics)
   - Test passes repeatedly (run 3× in a row to catch flakiness)
   - Reverting task 1's `noExternal` change produces a failing test whose error message contains the literal string `Cannot find module 'zod'` (or whichever non-bundled dep would crash first)
   - No stale `/var/folders/*/claude-sop-isolated-*` directories remain after test run

3. **ARCHITECT: Regression guard smoke assertion — writer bundle contains no bare requires**

   Files (MODIFIED):
   - `test/smoke.test.ts` — add a standalone test in the `smoke: plugin bundle artifacts` group:

   ```ts
   it('writer.cjs bundles all non-node runtime deps', async () => {
     const writerSrc = await readFile(
       join(repoRoot, 'dist', 'plugin', 'writer.cjs'),
       'utf8',
     );
     // Find all `require("something")` calls
     const requires = [...writerSrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(
       (m) => m[1],
     );
     // Node builtins are fine (with or without `node:` prefix)
     const nodeBuiltins = new Set([
       'fs', 'path', 'os', 'crypto', 'util', 'stream', 'zlib',
       'child_process', 'events', 'assert', 'buffer', 'url', 'net',
       'tls', 'http', 'https', 'querystring', 'string_decoder', 'timers',
       'tty', 'v8', 'vm', 'worker_threads', 'async_hooks', 'perf_hooks',
       'readline', 'repl', 'constants', 'module', 'process', 'dgram',
       'dns', 'cluster', 'domain', 'punycode', 'inspector',
       'trace_events', 'wasi', 'diagnostics_channel',
     ]);
     const bareRequires = requires.filter((r) => {
       if (r.startsWith('node:')) return false;
       if (r.startsWith('.') || r.startsWith('/')) return false;
       if (nodeBuiltins.has(r)) return false;
       return true;
     });
     expect(bareRequires).toEqual([]);
   });
   ```

   Requirements:
   - This test complements the e2e test: even if the e2e test somehow gives a false positive again, the grep-based assertion makes bundling regressions structurally detectable.
   - Applies to `dist/plugin/writer.cjs` specifically (the production artifact).
   - If the test fails, the error message must show WHICH bare requires were found so the fix is obvious.

   Acceptance:
   - After task 1's fix, this test passes with `bareRequires` empty
   - Before task 1's fix (revert to old `noExternal`), this test fails showing `[ 'zod', 'proper-lockfile', ... ]` (or whatever the real leaked requires are)

## Quality Gates (MANDATORY)

4. **YODA: Code review** — the tsup change is trivial; the e2e test rewrite is substantial. Focus on:
   - Does the isolated-bundle-copy approach actually isolate require() resolution?
   - Is the diagnostic dump on failure useful enough to avoid the "smoke passes, prod crashes" cycle a FIFTH time?
   - Do helpers leak file handles or temp dirs?
   - Is the test deterministic across macOS and Linux tmpdir paths?
   **100% approval required.**

5. **APEX: Security review** —
   - Bundling all deps into one file: any new supply-chain risk? (No — same deps, same versions, just inlined.)
   - Test's `HOME` override: any chance the test writes outside `tmpRoot` if the writer has a path traversal bug? Verify the writer only uses `os.homedir()`-relative paths and never `process.env.USER`/etc.
   - Diagnostic dump: if errors.log contains scrubber false-positive secrets, the test failure message would leak them into CI logs. Make sure `readSafe` has a size cap (e.g. first 2 KB) and redacts any PEM-looking blocks.
   **Must pass P0/P1.**

6. **ANALYZER: Code improvement review** — grade the new test + helpers. **Must be C or above.**

(No PRISM.)

## Finalize

7. **ARCHITECT: Commit** with message:
   ```
   fix(phase2): bundle all writer runtime deps + isolated e2e smoke (no more false positives)
   ```

## Acceptance Criteria (POC-level validation, round 4)

After this plan lands AND the user runs the post-plan refresh sequence, ALL of these hold:

- `npm run build && npm run test:smoke` exits 0
- `dist/plugin/writer.cjs` size ≥ 180 KB (sanity: zod + proper-lockfile + etc. are inlined)
- Regression grep assertion passes: zero bare non-node `require()` calls in `dist/plugin/writer.cjs`
- Isolated e2e smoke passes AND fails loudly with `Cannot find module` when bundling is reverted (manually verified)
- After `claude-sop install` in dogfood project:
  - Running one real prompt in Claude Code produces at least one `~/.claude-sop/captures/<project-slug>/<turn-id>/turn.json` with events
  - `~/.claude-sop/tmp/` is empty (no stranded payloads after the real turn)
  - `~/.claude-sop/logs/errors.log` is empty
  - Manual `node ~/.claude-sop/marketplace/claude-sop/writer.cjs <some-payload>` does NOT crash with MODULE_NOT_FOUND

## Post-plan steps for the user

```bash
# 1. Uninstall current state
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop uninstall

# 2. Rebuild and refresh global
cd ~/Developer/claude-sop
npm run build
npm run test:smoke
# sanity check the size grew
wc -c dist/plugin/writer.cjs
# expect: number ≥ 180000
npm pack
npm i -g ./claude-sop-0.0.0.tgz

# 3. Clean state
launchctl bootout "gui/$UID/com.claude-sop.learner" 2>/dev/null || true
rm -rf ~/.claude-sop/marketplace/claude-sop
rm -f  ~/.claude-sop/tmp/*.json
: > ~/.claude-sop/logs/errors.log
rm -f  ~/.claude-sop/logs/ticks.log

# 4. Fresh install
cd ~/Developer/wrbeautiful-shopify-theme
claude-sop install
ls ~/.claude-sop/marketplace/claude-sop/
# expect: .claude-plugin  hooks  learner.cjs  shim.cjs  writer.cjs
claude-sop doctor            # 9/9 ok

# 5. Pre-flight check: run the writer manually against a dummy payload
# This proves the bundled version works before we even touch Claude Code
echo '{"session_id":"preflight","transcript_path":"/tmp/x","cwd":"/tmp","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"test"}' \
  > /tmp/preflight.json
node ~/.claude-sop/marketplace/claude-sop/writer.cjs /tmp/preflight.json
echo "writer exit=$?"
# expect: exit 0 (or some non-MODULE_NOT_FOUND error) — the KEY is "no Cannot find module"
ls -la ~/.claude-sop/captures/ 2>/dev/null || echo "(captures not yet created — the preflight payload may not trigger directory creation depending on writer logic)"
rm /tmp/preflight.json

# 6. Real turn through Claude Code
claude
# inside: /plugin → verify still clean; issue "list top-level files"; /exit

# 7. Final verification
find ~/.claude-sop/captures -name 'turn.json'
find ~/.claude-sop/captures -name '*.pending'   # expect: empty
ls ~/.claude-sop/tmp/                            # expect: empty
cat ~/.claude-sop/logs/errors.log                # expect: empty

TURN=$(find ~/.claude-sop/captures -name 'turn.json' | head -1)
jq '{events: (.events|length), types: (.events|map(.type)|unique)}' "$TURN"
claude-sop status
```

**Success = step 7 shows a real turn.json with events, clean tmp, clean errors.** That is POC validation.

## Out of Scope

- Replacing `stdio: "ignore"` in the shim's writer spawn. Making writer crashes visible is a Phase 3-ish concern — for v8 we rely on the isolated smoke test + manual preflight to catch bundling issues before install.
- Shrinking the bundle size. 200–500 KB is fine for a file that runs once per hook event.
- Phase 3 real learner, recall gate, or any directive-writing logic.
- Teaching the writer to log its own crashes to `errors.log` (separate fix — useful but not required for POC).

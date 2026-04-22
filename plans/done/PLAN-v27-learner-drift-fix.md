# V27: Learner Drift Detection Fix + Error Logging + Repair CLI

## Overview
The learner has been silently failing on every hourly tick since April 20th due to two bugs:

1. **Managed section drift false alarm** — CLAUDE.md was legitimately updated (the managed section data timestamp changed from a learner run that completed successfully), but a subsequent external modification (v25 army session or manual edit) changed the managed section content without updating the hash store. Now every tick detects "drift", aborts the write, and logs the error. The learner is stuck — it can never write directives until the hash is re-synced.

2. **Error serialization bug** — The drift logger passes a structured object `{projectRoot, conflictPath, storedHash, currentHash}` to `logError()`, but `logError()` does `String(err)` which produces `"[object Object]"` instead of the actual drift details. This makes the errors.log useless for diagnosing the problem.

Additionally, there's no CLI verb to repair this state. Users who hit drift have no recovery path other than manually editing JSON files. This plan adds an `auto-sop repair` command.

## Root Cause Analysis

### Bug 1: Drift detection stuck
- `managed-section-hash.json` stores hash `4defbf3d...` (from April 20 09:00 UTC)
- Current CLAUDE.md managed section hashes to `cd46ecf8...` (different)
- The managed section was updated by an external process (the dev army agents modify CLAUDE.md data lines like turn counts)
- Every hourly tick: `computeManagedHash(current) !== stored.lastHash` → drift_aborted
- The learner can never write directives because it always aborts before reaching the write step
- No self-healing: the drift never resolves on its own

### Bug 2: Error serialization
- `logError(kind, err)` at line 149 of `src/learner/main.ts`:
  ```typescript
  err: err instanceof Error ? err.message : String(err)
  ```
- The editor's logger callback passes `(kind, data)` where `data` is an object `{projectRoot, conflictPath, storedHash, currentHash}`
- `String({...})` → `"[object Object]"` — loses all diagnostic info
- Same bug affects `managed_section_skip_git_state` events (also pass objects)

### Not a bug: `no_new_turns`
- The 10 new captures from today arrived at/after the 18:00 UTC tick — they'll be processed on the next tick. This is expected behavior, not a bug.

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Fix error serialization in logError()
   Files: `src/learner/main.ts`
   Requirements:
   - At line 149, change the `err` serialization to handle objects:
     ```typescript
     // Before:
     err: err instanceof Error ? err.message : String(err),
     
     // After:
     err: err instanceof Error ? err.message : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err)),
     ```
   - This ensures structured objects from the editor logger (`{projectRoot, conflictPath, storedHash, currentHash}`) are properly serialized as JSON strings in errors.log
   - Verify by checking all `logError()` call sites — some pass strings (fine), some pass Error objects (fine), some pass objects (this is the fix)
   - Add a unit test in `test/learner/` that verifies `logError` serializes objects correctly (mock `appendFileSync`, call with an object, verify JSON output contains the object's keys)
   - Run `npm test` to verify no regressions
   Acceptance: `logError()` produces readable JSON for object arguments. Unit test covers the object case.

2. ARCHITECT: Add `auto-sop repair` CLI verb
   Files: `src/cli/verbs/repair.ts`, `src/cli/index.ts`
   Requirements:
   - New CLI verb: `auto-sop repair [--project <path>]`
   - The repair verb performs these recovery actions:
     a. **Re-sync managed section hash** — Read current CLAUDE.md, compute hash of managed section, write to `managed-section-hash.json`. This clears the drift deadlock.
     b. **Clean stale current-turn markers** — Remove `current-turn-*.json` files in state/ older than 1 hour (orphaned session markers)
     c. **Report** — Print what was repaired:
        ```
        auto-sop repair results:
          ✓ Managed section hash re-synced (was: 4defb..., now: cd46e...)
          ✓ Cleaned 3 stale turn markers
          ℹ Learner cursor: 23 turns seen, last tick ck-21h00
          ℹ Next tick will process 10 new captures
        ```
   - With `--json` flag: output structured JSON (same pattern as other verbs)
   - If no managed section markers exist in CLAUDE.md, clear the hash store (same as `clearLastHash`)
   - Register the verb in `src/cli/index.ts` alongside existing verbs
   - Add tests:
     - Test 1: repair re-syncs hash when drift is detected
     - Test 2: repair clears hash when no markers exist
     - Test 3: repair cleans stale turn markers
     - Test 4: repair is a no-op when everything is healthy (reports "nothing to repair")
   Acceptance: `npx auto-sop repair` resolves the drift deadlock. All 4 tests pass. `--json` output works.

3. ARCHITECT: Add auto-recovery on drift detection (self-healing after N consecutive drifts)
   Files: `src/managed-section/editor.ts`, `src/managed-section/hash-store.ts`
   Requirements:
   - Currently, drift detection aborts forever with no recovery path. Add a **consecutive drift counter** to the hash store:
     ```typescript
     interface HashRecord {
       lastHash: string;
       updatedAt: string;
       consecutiveDrifts?: number;  // NEW — incremented on each drift abort
     }
     ```
   - In the editor's drift detection path (line ~209):
     - On drift: increment `consecutiveDrifts` in hash store, then abort as before
     - If `consecutiveDrifts >= 3`: **auto-repair** — re-compute the hash from current file, write it, reset counter to 0, log `managed_section_drift_auto_repaired`, and proceed with the write instead of aborting
   - This means: first 2 drifts still abort (protecting against accidental clobber), but on the 3rd consecutive drift the learner assumes the file was intentionally changed and re-syncs
   - The counter resets to 0 on any successful write (no drift)
   - Add a log event `managed_section_drift_auto_repaired` with the old and new hashes
   - Add unit tests:
     - Test: 1st and 2nd drift → abort (existing behavior preserved)
     - Test: 3rd consecutive drift → auto-repair + successful write
     - Test: successful write resets counter to 0
   Acceptance: After 3 consecutive drift aborts, the learner self-heals. Counter resets on success. Existing 1st/2nd drift behavior unchanged.

### Wave 2 (depends on Wave 1)

4. ARCHITECT: Fix current project state + verify learner works end-to-end
   Files: (no new files — operational fix + verification)
   Requirements:
   - Run `npx auto-sop repair --project /Users/ugurgokdere/Developer/auto-sop` to fix the current drift state
   - Verify the hash store was re-synced: `cat .auto-sop/state/managed-section-hash.json` should show the new hash matching `cd46ecf8...`
   - Run `npx auto-sop learn-now --dry-run` to verify the learner can now process turns without drift abort
   - Check the output: should show turns processed, detectors run, and either proposals or "no patterns found" (both are OK — what matters is it doesn't abort)
   - Verify the errors.log no longer gets drift entries on the next run
   - Run full test suite: `npm test`
   Acceptance: `repair` command succeeds. `learn-now --dry-run` runs without drift abort. Hash store in sync.

## Quality Gates (MANDATORY)
5. YODA: Code review — error serialization fix, repair verb implementation, auto-recovery logic (is 3 the right threshold?), hash store schema backward compatibility
6. APEX: Security review — repair verb doesn't expose sensitive data, hash store changes don't weaken drift protection, auto-recovery can't be exploited to bypass user-edit protection
7. ANALYZER: Code improvement review — grade must be C or above

## Finalize
8. ARCHITECT: Commit with message: `fix(v27): learner drift detection auto-recovery + repair CLI + error serialization`

## Acceptance Criteria
- `logError()` properly serializes objects as JSON (no more `[object Object]`)
- `auto-sop repair` CLI verb exists and re-syncs managed section hash
- After 3 consecutive drift aborts, learner auto-heals (re-syncs hash and proceeds)
- Consecutive drift counter resets on successful writes
- Current auto-sop project's drift deadlock is resolved
- `learn-now --dry-run` runs without drift abort after repair
- All new tests pass
- `npm test` passes (full suite)
- `npm run lint` and `npm run typecheck` pass
- All quality gates approved

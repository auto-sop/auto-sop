# PLAN-v38: CLI Bug Cleanup + BIND-7 Self-Hash Tamper Detection

## Overview
Two objectives in one plan for the auto-sop CLI repo:
1. Fix remaining non-blocking bugs (BUG-V36-1, BUG-V36-4, BUG-D1, BUG-E1)
2. Implement BIND-7 (CLI self-hash tamper detection) — advanced protection layer

## Project
**auto-sop** (CLI repo)

## Architecture Decisions
- BIND-7: CLI computes SHA-256 hash of its own dist/ files at runtime and sends to server. Server has a registry of known hashes per version. Unknown hash = tampered client = server refuses to sign.
- Hash algorithm: sort all files in dist/ by path, concatenate contents, SHA-256 the result. Deterministic across platforms.
- Server endpoint already accepts `cli_hash` and `cli_version` fields (added in v36). Currently server ignores them — v39 site plan will add server-side enforcement.
- BUG-D1 (semantic dedup): Add LLM-based "same lesson?" gate before accepting new directive. Cheaper than embeddings, uses existing `claude -p` pathway.

## Implementation Tasks

### Wave 1: Bug Fixes (parallel — no dependencies)

1. ARCHITECT: Fix BUG-V36-1 — Remove unused isCacheValid import
   Files: src/license/server-client.ts
   Requirements: The `isCacheValid` function is imported but only used in `fallbackToCache`. Verify it IS used there. If not, remove the import. If it should be used (cache freshness check before returning cached payload), add the check.
   Acceptance: No unused imports. `fallbackToCache` correctly checks cache validity before returning.

2. ARCHITECT: Fix BUG-V36-4 — Use resetFailures utility in success path
   Files: src/license/server-client.ts
   Requirements: In the success path of `validateLicense`, the code manually constructs a cache object with `consecutive_failures: 0` and `first_failure_at: undefined`. Use the existing `resetFailures()` utility instead for consistency. Check current code — may already be fixed by v36 army.
   Acceptance: Success path uses `resetFailures()`. No manual failure counter reset.

3. ARCHITECT: Fix BUG-D1 — Semantic near-duplicate directive detection
   Files: src/learner/dedup.ts (new), src/learner/merge.ts, test/learner/dedup.test.ts
   Requirements: Before accepting a new directive proposal, compare its `rule_text` against all existing active directives. Use bigram similarity (Dice coefficient) with threshold 0.6 as fast pre-filter. If similarity > 0.6, use `claude -p` with a short prompt: "Are these two directives teaching the same lesson? Respond YES or NO." If YES, skip the new directive and log "duplicate_skipped". Target: <5% duplicate rate across active directives.
   Acceptance: Tests with known near-duplicates (e.g., "never embed API tokens" vs "never pass access tokens inline") are correctly detected. LLM gate only called when bigram pre-filter triggers (not on every directive).

4. ARCHITECT: Fix BUG-E1 — Flaky e2e integration tests
   Files: test/capture/integration/end-to-end.test.ts
   Requirements: The large-output and orphan-recovery tests timeout under parallel load (waitForQuiescence 160s). Root cause: resource contention. Fix by either: (a) marking these tests as serial (`test.serial` or separate test file), (b) increasing timeout only for these specific tests, or (c) reducing resource contention by using unique temp directories per test. Preferred: option (a) — run these specific tests serially.
   Acceptance: Full test suite passes reliably in CI. No flaky timeouts.

### Wave 2: BIND-7 Implementation (parallel — no bug fix dependencies)

5. ARCHITECT: CLI self-hash computation
   Files: src/license/self-hash.ts, test/license/self-hash.test.ts
   Requirements: Compute a deterministic hash of the CLI's dist/ directory. Algorithm: (1) list all .js and .cjs files in dist/, sorted by relative path, (2) read each file content, (3) concatenate path + content with separator, (4) SHA-256 the result. Cache the hash in memory (compute once per process). Handle both npm global install and local symlink cases — resolve the actual dist/ path from the CLI entry point.
   Acceptance: Hash is deterministic — same dist/ always produces same hash. Hash changes when any dist/ file is modified. Tests verify with fixture directories.

6. ARCHITECT: Send cli_hash in validation requests
   Files: src/license/enforcement.ts, src/license/server-client.ts, src/installer/orchestrator.ts
   Requirements: Import `computeCliHash()` and pass it as `cliHash` in all `validateLicense()` calls. Include `cliVersion` from package.json. Both `checkLicenseBeforeTick` and install orchestrator must send these. Server currently ignores them — that's fine, server enforcement comes in the site plan.
   Acceptance: Validation requests include `cli_hash` and `cli_version` fields. Server receives them (verify via Vercel logs or curl test).

7. ARCHITECT: Hash registry endpoint prep (CLI side)
   Files: src/license/server-client.ts
   Requirements: Handle new server response field `reason: "tampered_client"` in validate response. If server returns `valid: false, reason: "tampered_client"`, treat as a hard failure (not cacheable, not grace-eligible). Display clear message: "CLI integrity check failed. Please reinstall: npm install -g auto-sop". Do NOT fall back to cache on tamper detection.
   Acceptance: If server returns tampered_client, CLI stops learner and shows reinstall message. Cache is not used as fallback.

### Wave 3: Integration (depends on Wave 1 + 2)

8. ARCHITECT: Integration tests for self-hash + dedup
   Files: test/license/self-hash-integration.test.ts, test/learner/dedup-integration.test.ts
   Requirements: Self-hash: verify hash changes when dist/ file modified, verify hash sent in validate request. Dedup: verify near-duplicate directives are caught in a simulated learner run with sample captures that produce similar directives.
   Acceptance: All integration tests pass.

## Quality Gates (MANDATORY)
9. YODA: Code review — all bug fixes and BIND-7 code
10. APEX: Security review — self-hash computation, tamper detection flow
11. ANALYZER: Code improvement review — must pass C or above

## Finalize
12. ARCHITECT: Commit all changes with message "feat(v38): bug cleanup + BIND-7 CLI self-hash tamper detection"

## Acceptance Criteria
- BUG-V36-1, V36-4 fixed (clean imports, proper utility usage)
- BUG-D1 fixed (semantic dedup with <5% duplicate rate)
- BUG-E1 fixed (no flaky test timeouts in CI)
- BIND-7 self-hash computed and sent in all validate requests
- Tampered client rejection handled gracefully
- All tests pass (100%)
- All quality gates approved

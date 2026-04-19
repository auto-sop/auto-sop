# V21: GitHub Templates + Dogfood Verification + PROJECT.md Cleanup

## Overview
Three housekeeping tasks: (1) Add GitHub community files (issue templates, PR template, SECURITY.md, FUNDING.yml, CODEOWNERS), (2) verify v20 directive-restore fix works end-to-end on wrbeautiful dogfood project, (3) update PROJECT.md to reflect current state (v18-v20 are done, add F6 server-side validation, add go-public prep section).

## Implementation Tasks

### Wave 1 (parallel — independent)

1. ARCHITECT: Create GitHub community files
   Files: `.github/ISSUE_TEMPLATE/bug_report.md` (NEW), `.github/ISSUE_TEMPLATE/feature_request.md` (NEW), `.github/PULL_REQUEST_TEMPLATE.md` (NEW), `.github/SECURITY.md` (NEW), `.github/FUNDING.yml` (NEW), `.github/CODEOWNERS` (NEW)
   Requirements:
   - Create `.github/ISSUE_TEMPLATE/bug_report.md`:
     ```markdown
     ---
     name: Bug Report
     about: Something isn't working as expected
     title: "[bug] "
     labels: bug
     ---

     **Environment**
     - OS: [e.g. macOS 15.1, Ubuntu 24.04]
     - Node.js: [e.g. 20.20.2]
     - auto-sop version: [run `auto-sop --version`]
     - Claude Code version: [run `claude --version`]

     **Describe the bug**
     A clear description of what the bug is.

     **Steps to reproduce**
     1. ...
     2. ...

     **Expected behavior**
     What you expected to happen.

     **Actual behavior**
     What actually happened.

     **Doctor output**
     ```
     # Paste output of: auto-sop doctor
     ```

     **Additional context**
     Any other context, error messages, or screenshots.
     ```
   - Create `.github/ISSUE_TEMPLATE/feature_request.md`:
     ```markdown
     ---
     name: Feature Request
     about: Suggest an improvement or new feature
     title: "[feature] "
     labels: enhancement
     ---

     **Problem**
     What problem does this solve? What's the use case?

     **Proposed solution**
     How you'd like it to work.

     **Alternatives considered**
     Any alternative solutions or workarounds you've tried.
     ```
   - Create `.github/PULL_REQUEST_TEMPLATE.md`:
     ```markdown
     ## Summary
     <!-- 1-3 bullet points -->

     ## Test plan
     - [ ] `npm test` passes
     - [ ] `npm run test:smoke` passes
     - [ ] `npm run release-check` passes

     ## Checklist
     - [ ] No TODO/FIXME left in code
     - [ ] No `claude-sop` references in user-visible files
     - [ ] Tests added for new functionality
     ```
   - Create `.github/SECURITY.md`:
     ```markdown
     # Security Policy

     ## Reporting a Vulnerability
     1. Do NOT open a public issue
     2. Email: ugokdere@gmail.com
     3. Include: description, steps to reproduce, potential impact

     We will acknowledge receipt within 48 hours.

     ## Scope
     - Capture pipeline (secret scrubbing, data handling)
     - Managed section editor (CLAUDE.md integrity)
     - Scheduler (launchd/systemd privilege)
     - CLI commands (input validation, path traversal)

     ## Out of Scope
     - Claude Code itself (report to Anthropic)
     - Third-party dependencies (report upstream, then notify us)
     ```
   - Create `.github/FUNDING.yml`:
     ```yaml
     github: [ugurgokdere]
     ```
   - Create `.github/CODEOWNERS`:
     ```
     # All changes require review from the maintainer
     * @ugurgokdere
     ```
   Acceptance: All 6 files exist under `.github/`. No syntax errors.

2. ARCHITECT: Dogfood verification — v20 directive-restore fix
   Files: none (verification only, do NOT modify wrbeautiful files)
   Requirements:
   - Build the project first: `npm run build`
   - Run from `/Users/ugurgokdere/Developer/wrbeautiful-shopify-theme`:
     ```bash
     # Step 1: Count current directives
     grep -c '\*\*\[' CLAUDE.md
     # Expected: 6

     # Step 2: Run learn-now — directives should persist
     node /Users/ugurgokdere/Developer/auto-sop/dist/cli.js learn-now
     
     # Step 3: Count again — must still be 6
     grep -c '\*\*\[' CLAUDE.md
     # Expected: 6

     # Step 4: Run learn-now again — still 6
     node /Users/ugurgokdere/Developer/auto-sop/dist/cli.js learn-now
     grep -c '\*\*\[' CLAUDE.md
     # Expected: 6
     ```
   - If directive count drops below 6, the v20 fix has a regression — STOP and report
   - If directive count stays at 6, v20 fix is confirmed working
   Acceptance: Directive count is 6 after both learn-now runs. No directives lost.

3. ARCHITECT: Update PROJECT.md to reflect current state
   Files: `.planning/PROJECT.md`
   Requirements:
   - Mark v18 publish readiness items as DONE (checkboxes → [x]):
     - [x] Rename to `auto-sop`
     - [x] Apache 2.0 LICENSE
     - [x] `.github/workflows/publish.yml`
     - [x] `release-check.sh` 28-item gate
     - [x] `publint` + `@arethetypeswrong/cli` CI
     - [x] README rewrite (demo GIF still pending)
     - [x] Auto-bump version on every commit
   - Update "Current State Summary" section:
     - Change "17 versions released (v1-v17)" → "20 versions released (v1-v20)"
     - Change "version 0.0.13 in package.json (v18 catches up to 0.0.18)" → "version 0.0.20 in package.json"
     - Change "Phase 5 50%" → "Phase 5 95% — v17 (CLI), v18 (publish), v19 (org migration), v20 (directive fix)"
     - Update test count: "730+ unit tests" → "1012+ unit tests" (from v18 test run)
     - Add: "Zero known production bugs as of v20"
   - Update Phase Map:
     ```
     Phase 5  Inspection + Packaging       🟨 95% — v17-v20 done, v21 (templates + dogfood verify)
     ```
   - Ensure the "Go Public prep" section (already added) and F6 server-side validation (already added) are present
   - Update "Last updated" date to 2026-04-19
   Acceptance: PROJECT.md reflects accurate current state. No stale version numbers.

4. ARCHITECT: Fix CI failures (3 categories)
   Files: `src/cli/shared/learner-spawn.ts`, `src/learner/directive-builder.ts`, `test/capture/integration/end-to-end.test.ts`, `test/cli/verbs/doctor.test.ts`, `test/cli/verbs/learn-now.test.ts`, `test/cli/verbs/show.test.ts`, `test/cli/verbs/recent.test.ts`, `test/cli/verbs/recap.test.ts`
   Requirements:
   **Fix A — TypeScript `exactOptionalPropertyTypes` errors (lint job):**
   - `src/cli/shared/learner-spawn.ts` line 130: `error` property typed as `string | undefined` but `LearnerResult` expects `string`. Add `undefined` to the `LearnerResult.error` type definition, OR ensure the value is always a string (use `?? ''` fallback).
   - `src/learner/directive-builder.ts` line 331: `newestTurnFinalizedAt` typed as `string | null | undefined` but `DirectiveInput` expects `string | null`. Same fix — either widen the type or narrow the value.
   - Run `npm run typecheck` to verify zero errors after fix.

   **Fix B — Flaky e2e subagent tests (macOS test jobs):**
   - `test/capture/integration/end-to-end.test.ts` — CAPT-04 (bidirectional linking) and CAPT-09 (dual representation) fail intermittently due to race condition in subagent capture finalization.
   - These pass when run in isolation (`npx vitest run test/capture/integration/end-to-end.test.ts`).
   - Fix options (pick one):
     a) Add retry/wait logic in the test for subagent dir to be finalized before asserting
     b) Add `{ retry: 2 }` to the flaky test cases as a pragmatic fix
     c) Increase the quiescence timeout for CI (Node 20 macOS already times out at 160s)
   - Whichever fix: ensure `npx vitest run` passes 3 consecutive times locally.

   **Fix C — Ubuntu platform-aware tests:**
   - `test/cli/verbs/doctor.test.ts` (8 failures): Tests expect `launchd` scheduler output but Ubuntu has no launchd. Tests must be platform-aware:
     - Skip launchd-specific assertions on Linux
     - OR mock the scheduler backend to return platform-appropriate results
   - `test/cli/verbs/learn-now.test.ts` (7 failures): Same platform issue — "non-macOS platform — skipped" message breaks assertions expecting "fresh install"
   - `test/cli/verbs/show.test.ts` (1 failure), `test/cli/verbs/recent.test.ts` (1 failure), `test/cli/verbs/recap.test.ts` (1 failure): Likely same root cause — platform detection
   - Run tests with `--reporter=verbose` to get exact assertion mismatches before fixing
   - After fix: tests must pass on BOTH macOS and Ubuntu (use `process.platform` checks or conditional assertions)
   Acceptance: `npm run typecheck` passes. `npm test` passes on macOS. CI green on all 3 matrix entries (node 18.17/ubuntu, node 20/macOS, node 22/macOS). No flaky tests.

## Quality Gates (MANDATORY)
5. YODA: Code review — GitHub templates, CI fixes, PROJECT.md updates
6. APEX: Security review — SECURITY.md content, no secrets in templates
7. ANALYZER: Code improvement review — grade must be C or above

## Finalize
8. ARCHITECT: Commit with message: `chore(v21): GitHub community files + CI fixes + dogfood verify + PROJECT.md update`

## Acceptance Criteria
- 6 GitHub community files committed under `.github/`
- Dogfood verification: wrbeautiful directives survive 2 consecutive learn-now runs
- PROJECT.md accurately reflects v20 state (versions, test counts, phase progress)
- CI passes: `npm run typecheck` zero errors, `npm test` green on macOS + Ubuntu
- No flaky e2e tests
- All quality gates approved

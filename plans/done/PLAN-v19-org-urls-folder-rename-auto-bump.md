# V19: Org URL Migration + Local Folder Rename + Auto-Bump Version

## Overview
GitHub repo has been transferred from `ugurgokdere/claude-sop` to `auto-sop/auto-sop`. This plan updates all remaining references to the new org URL, renames the local project folder, and adds auto-bump version on every commit so package.json version never drifts from plan version again.

## Architecture Decisions
- All GitHub URLs change from `ugurgokdere/auto-sop` → `auto-sop/auto-sop`
- Local folder rename: `~/Developer/claude-sop` → `~/Developer/auto-sop`
- Auto-bump: pre-commit hook or npm script that patches version on each commit
- `.planning/` and `plans/done/` files are HISTORICAL — do NOT update `ugurgokdere` refs in those files (they reflect decisions made at that time)
- `.claude/settings.local.json` contains local filesystem paths with `ugurgokdere` (macOS username) — those are CORRECT, do not change

## Implementation Tasks

### Wave 1 (parallel — no dependencies between these)

1. ARCHITECT: Update all org URLs from `ugurgokdere/auto-sop` to `auto-sop/auto-sop`
   Files: `package.json`, `scripts/release-check.sh`, `CONTRIBUTING.md`
   Requirements:
   - In `package.json`, update these 3 fields to use `auto-sop/auto-sop`:
     ```json
     "repository": { "type": "git", "url": "git+https://github.com/auto-sop/auto-sop.git" },
     "homepage": "https://github.com/auto-sop/auto-sop#readme",
     "bugs": { "url": "https://github.com/auto-sop/auto-sop/issues" }
     ```
   - In `scripts/release-check.sh`, update the 2 hardcoded URL strings (lines 53 and 59) from `ugurgokdere/auto-sop` to `auto-sop/auto-sop`
   - In `CONTRIBUTING.md`, update the git clone URL from `ugurgokdere/auto-sop` to `auto-sop/auto-sop`
   - Do NOT touch `.planning/` files, `plans/done/` files, or `.claude/settings.local.json`
   - Do NOT touch any file under `plans/handoff/` (historical reference)
   - After edits, run: `grep -rn 'ugurgokdere' package.json scripts/release-check.sh CONTRIBUTING.md` — expect ZERO matches
   Acceptance: All 3 files use `auto-sop/auto-sop` URLs. `npm run release-check` passes (build first if needed).

2. ARCHITECT: Update `.planning/PROJECT.md` org references
   Files: `.planning/PROJECT.md`
   Requirements:
   - Update any remaining `ugurgokdere/auto-sop` references to `auto-sop/auto-sop` in the Repository Structure table and Context section
   - The file already has some correct references from our earlier edit — just fix any remaining `ugurgokdere/auto-sop` instances
   - Preserve the `(this repo, was ugurgokdere/claude-sop)` parenthetical — that's historical context
   Acceptance: `grep 'ugurgokdere/auto-sop' .planning/PROJECT.md` returns zero matches. `ugurgokdere/claude-sop` references (historical) are preserved.

3. ARCHITECT: Add auto-bump version pre-commit hook
   Files: `scripts/bump-version.sh` (NEW), `package.json` (scripts section)
   Requirements:
   - Create `scripts/bump-version.sh`:
     - Reads current version from `package.json`
     - Increments patch version (0.0.18 → 0.0.19)
     - Writes back to `package.json` using `npm version patch --no-git-tag-version`
     - Stages the changed `package.json`: `git add package.json`
   - Add npm script: `"version:auto-bump": "bash scripts/bump-version.sh"`
   - Add to `.claude/settings.json` hooks OR create a git pre-commit hook at `.git/hooks/pre-commit` that runs `bash scripts/bump-version.sh`
   - IMPORTANT: The hook must be idempotent — if version was already bumped in this commit (e.g., manual `npm version`), don't double-bump
   - IMPORTANT: The hook must NOT run during `npm version` commands (detect via `npm_lifecycle_event` env var)
   - Test: make a test commit, verify version incremented, then verify a second commit increments again
   Acceptance: After any `git commit`, `package.json` version auto-increments. No double-bump on manual `npm version patch`. Hook is idempotent.

### Wave 2 (depends on Wave 1 — final verification)

NOTE: Local folder rename (`claude-sop` → `auto-sop`) was already done manually. Skip that step.

4. ARCHITECT: Full verification sweep
   Files: all
   Requirements:
   - Run from `/Users/ugurgokdere/Developer/auto-sop`:
     - `grep -rn 'ugurgokdere' package.json scripts/ CONTRIBUTING.md README.md .github/` — expect ZERO matches
     - `npm run build && npm test` — all pass
     - `npm run release-check` — all 28 checks pass
     - `git remote -v` — shows `auto-sop/auto-sop.git`
   - List any remaining `ugurgokdere` references (excluding `.planning/`, `plans/done/`, `.claude/settings.local.json`, `plans/handoff/`) as warnings
   Acceptance: Zero `ugurgokdere` references in active source/config files. Build + test + release-check all green.

## Quality Gates (MANDATORY)
6. YODA: Code review — all changes to package.json, release-check.sh, CONTRIBUTING.md, bump-version.sh, pre-commit hook
7. APEX: Security review — verify no secrets exposed, hook script is safe
8. ANALYZER: Code improvement review — grade must be C or above

## Finalize
9. ARCHITECT: Commit all changes with message: `feat(v19): org URL migration to auto-sop/auto-sop + auto-bump version hook`

## Acceptance Criteria
- All GitHub URLs in active files point to `auto-sop/auto-sop` (not `ugurgokdere/auto-sop`)
- Local folder is `~/Developer/auto-sop`
- Git remote is `https://github.com/auto-sop/auto-sop.git`
- Auto-bump version hook works on every commit
- `npm run release-check` passes all 28 checks
- `npm run build && npm test` passes
- All quality gates approved
- Historical files (`.planning/`, `plans/done/`, `plans/handoff/`) left untouched

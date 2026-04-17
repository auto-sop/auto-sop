# PLAN-v16 — ManagedSectionEditor Hardening (E1-E7)

## Overview

v10 shipped ManagedSectionEditor as "light" — atomic writes + 1-generation backup. v14 adds LLM-driven directives that land in CLAUDE.md via this editor. v16 closes Phase 4 by adding the hardening that STATE.md has been warning about since day 1: **"one bug here = permanent trust loss."**

The editor now has to handle real production pressure:
- Users edit their own CLAUDE.md between ticks → writer must detect drift and NOT clobber user edits
- `git rebase` / `git merge` creates conflict markers → writer must skip silently or it corrupts the repo
- Directives accumulate over time → need TTL pruning + cap (currently unbounded)
- Duplicate directives from LLM + rule-based detectors can pile up → need dedup
- Users deserve a way to undo the last write → `claude-sop revert` command
- Every directive must have evidence pointers back to captures → auditability
- Byte-identical preservation of user content outside markers → must be test-enforced

After v16: the editor is safe to trust in production, on real projects with real users' hand-written CLAUDE.md content, across git workflows, with no growth-without-bound risk.

## The 7 hardening items (one task per E)

### E1 — Hash-checked writes + drift detection

**Problem:** Current editor writes unconditionally. If user edits CLAUDE.md between ticks (adds their own content inside managed section, or changes the content around it), the next learner run overwrites their edits without warning.

**Fix:**
- Before writing, compute SHA256 of current managed section content.
- Store the "last-known-hash" from the previous write in `<project>/.claude-sop/state/managed-section-hash.json`.
- If current hash != last-known-hash → **drift detected**.
- Action on drift:
  - Backup current CLAUDE.md to `<project>/.claude-sop/state/managed-history/conflict-<ts>.md`
  - ABORT the write (don't clobber user edits)
  - Log `managed_section_drift_detected` to errors.log
  - Set recap field `directive_written: 'drift_aborted'`
  - On next tick: if user cleans up / accepts, editor retries. If drift persists, keeps aborting.
- After successful write: update last-known-hash to the new post-write content hash.
- First run (no stored hash): write and record initial hash, no drift check.

**Files:** `src/managed-section/editor.ts` — add hash check + drift logic. New helper module `src/managed-section/hash-store.ts`. Update tests with drift scenarios.

### E2 — Git-aware: skip during rebase/merge

**Problem:** If user is mid-rebase or mid-merge, the editor could write to CLAUDE.md and corrupt conflict markers or interfere with git's view of the working tree.

**Fix:**
- Before writing, check for these marker files in the project root:
  - `.git/rebase-merge/` directory exists
  - `.git/rebase-apply/` directory exists
  - `.git/MERGE_HEAD` exists
  - `.git/CHERRY_PICK_HEAD` exists
  - `.git/BISECT_LOG` exists
  - `.git/REVERT_HEAD` exists
- If ANY exists → skip write, log `managed_section_skip_git_state`, set recap `directive_written: 'git_busy'`.
- Resume on next tick when git state is clean.

**Files:** `src/managed-section/git-state.ts` — new helper with `isGitBusy(projectRoot): boolean`. Wire into editor write path. Tests with fixture `.git/` directories.

### E3 — `claude-sop revert` command

**Problem:** If editor writes something unexpected or bad, user needs a one-shot rollback.

**Fix:**
- New verb: `claude-sop revert [--project <path>]`
- Behavior:
  - Reads the most recent backup from `<project>/.claude-sop/state/CLAUDE.md.backup`
  - Validates it exists and isn't empty
  - Copies backup → CLAUDE.md (atomic rename)
  - Prints: `✓ Reverted CLAUDE.md from backup (taken YYYY-MM-DD HH:MM:SS)`
  - Also clears `managed-section-hash.json` so next tick treats it as fresh
- If no backup exists: `✗ No backup to revert from` (exit 1)
- `--dry-run` flag: show what WOULD be restored without doing it
- `--json` flag: machine-readable output

**Files:** `src/cli/verbs/revert.ts` — new verb. `src/managed-section/editor.ts` — reset hash store on revert. Tests.

### E4 — Duplicate directive detection

**Problem:** v14's LLM might propose a directive the rule-based detector also caught. Or two detectors might find overlapping patterns. Currently `merge-proposals.ts` dedupes by `id` but `id` depends on detector — same pattern from different sources produces different ids.

**Fix:**
- Compute a **semantic fingerprint** from each proposal: normalized rule_text (lowercased, whitespace-collapsed, first 100 chars) + severity.
- In merge step: group by fingerprint, keep the one with:
  1. Most evidence (`session_ids.length` descending)
  2. Then by severity (error > warning > info)
  3. Then LLM-sourced over rule-based (richer rule_text)
- Drop the rest silently, add `merge_deduped_count: N` to recap.

**Files:** `src/learner/merge-proposals.ts` — add fingerprint + dedup logic. Tests.

### E5 — TTL pruning + max directive cap

**Problem:** Directives accumulate forever. Over months, CLAUDE.md's managed section grows unbounded. Also, some directives become irrelevant (problem fixed, workflow changed) but never expire.

**Fix:**
- Each directive in `<project>/.claude-sop/state/directive-history.json` tracks:
  - `id`, `first_seen`, `last_reinforced` (last tick it appeared in proposals), `occurrence_count`
- TTL rule: if `last_reinforced` > 30 days ago → prune from managed section.
- Cap rule: if total directives > 25 → drop lowest-severity + oldest `last_reinforced` first.
- Pruned directives are NOT deleted from history — just removed from CLAUDE.md. History is kept for analytics (v17+ inspection CLI can show archived directives).
- Config via env vars or config file:
  - `CLAUDE_SOP_DIRECTIVE_TTL_DAYS` (default 30)
  - `CLAUDE_SOP_DIRECTIVE_MAX` (default 25)

**Files:** `src/managed-section/directive-history.ts` — new store. `src/managed-section/editor.ts` — integrate TTL + cap before write. Tests.

### E6 — Evidence pointer per directive

**Problem:** Directives currently show "evidence: 4 sessions" but no way to trace back to WHICH captures. A user seeing a confusing directive has no audit trail.

**Fix:**
- Current schema (v13) already has `evidence.session_ids[]` and `evidence.turn_ids[]`.
- Extend directive builder to render these as a `details` line under each bullet:

```markdown
- **[warning]** Command `npm test` has exited non-zero in 4 sessions...
  _(evidence: 4 sessions · [view turns](.claude-sop/captures/20260416T102301-...) [+3 more])_
```

- The `[view turns]` links are relative paths to the actual turn directories under `<project>/.claude-sop/captures/`. User can `cd` there and inspect.
- Link text: first turn path + "[+N more]" where N = remaining count.
- If no turn_ids in evidence (shouldn't happen with v13 schema, but defensive) → fall back to just session count.

**Files:** `src/learner/directive-builder.ts` — expand rendering. Tests.

### E7 — Golden-file test suite

**Problem:** Editor byte-preservation outside markers is a critical invariant. One off-by-one bug could eat user content. We have unit tests but no golden-file tests that prove the exact bytes.

**Fix:**
- Create `test/managed-section/golden/` directory with fixture CLAUDE.md files:
  - `golden-01-fresh-project.md` → no markers, no managed section yet
  - `golden-02-existing-section.md` → has markers + old content
  - `golden-03-crlf-line-endings.md` → Windows-style CRLF
  - `golden-04-emoji-and-unicode.md` → multibyte content
  - `golden-05-trailing-whitespace.md` → spaces/tabs at line ends
  - `golden-06-markers-in-code-block.md` → markers appearing in a code block (should not be confused with real markers)
  - `golden-07-very-large.md` → 500 KB content outside markers
  - `golden-08-exact-byte-boundary.md` → marker at exact EOF with no newline
- For each: run editor with known proposals, assert output bytes match `golden-NN-expected.md`.
- Any byte mismatch = test failure with a diff.

**Files:** 8 golden fixtures + 8 expected-output files + `test/managed-section/golden.test.ts`.

## Phase 0: Advisory

None.

## Implementation Tasks

### Wave 1 — Standalone helpers (parallel-safe)

1. **ARCHITECT: E1 hash store + drift detection**
   - `src/managed-section/hash-store.ts` — read/write last-known-hash per project
   - Integrate into `editor.ts` write path
   - Tests: drift scenarios + fresh install

2. **ARCHITECT: E2 git state detection**
   - `src/managed-section/git-state.ts` — `isGitBusy()` helper
   - Integrate into editor write path
   - Tests with fixture `.git/` directories

### Wave 2 — Storage + logic (depends on Wave 1)

3. **ARCHITECT: E4 semantic dedup in merge-proposals**
   - Extend `src/learner/merge-proposals.ts` with fingerprint-based dedup
   - Tests covering LLM+rule overlap, severity priority, evidence-count priority

4. **ARCHITECT: E5 directive history + TTL + cap**
   - `src/managed-section/directive-history.ts` — history store
   - Wire into editor write: load history, update timestamps, apply TTL + cap
   - Tests: 30-day expiry, 25-max cap, history preservation after prune

### Wave 3 — User-facing (depends on Wave 2)

5. **ARCHITECT: E3 revert verb**
   - `src/cli/verbs/revert.ts` — new CLI verb with `--dry-run` + `--json`
   - Register in `src/cli.ts`
   - Clears hash store on revert so next tick treats CLAUDE.md as fresh
   - Tests: backup exists → revert OK, no backup → error, dry-run shows diff

6. **ARCHITECT: E6 evidence pointer rendering**
   - Update `src/learner/directive-builder.ts` to render evidence links
   - Tests: relative paths, "+N more" truncation, empty-evidence fallback

### Wave 4 — Golden-file regression guard

7. **ARCHITECT: E7 golden-file test suite**
   - 8 fixture CLAUDE.md files + 8 expected outputs
   - `test/managed-section/golden.test.ts` — assert byte-identical output
   - Run as part of `npm run test`

## Quality Gates (MANDATORY)

8. **YODA: Code review** — focus on:
   - Drift detection: does ANY code path write CLAUDE.md without hash check?
   - Git state: can git commands be interpreted ambiguously (rebase vs rebase-apply)?
   - Revert: atomic rename for the restore, no partial writes?
   - TTL pruning: history preserved even after prune from managed section?
   - Dedup: does fingerprint collision cause wrong directive to win?
   - Golden files: bytes ACTUALLY identical (no trailing newline mismatch)?
   **100% approval required.**

9. **APEX: Security review** —
   - Hash store file: permissions 0600 (user-only read)
   - Backup/conflict-history: permissions 0600
   - Revert: can user revert to a backup that contains stale/malicious content? (Answer: yes, intentionally — it's THEIR backup)
   - Git-state check: no shell interpolation when looking at `.git/` paths
   - Directive history: size-bounded? (history file could grow, add rotation at 10 MB)
   **Must pass P0/P1.**

10. **ANALYZER: Code improvement review** — grade all modules. **Must be C or above.**

## Finalize

11. **ARCHITECT: Commit** with message:
    ```
    feat(phase4): ManagedSectionEditor hardening — hash check + git-aware + revert + TTL + dedup + evidence links + golden tests
    ```

## Acceptance Criteria

After v16:
- Phase 4 roadmap success criteria ALL pass (MD-01 through MD-08)
- `claude-sop recap --run` is safe to run on a project with user-hand-edited CLAUDE.md → drift detected, no clobber
- Mid-rebase: learner silently skips, no repo corruption
- `claude-sop revert` → one-shot rollback works
- Directives don't grow past 25 items or live past 30 days
- Managed section bullets link to actual captures
- Golden-file tests enforce byte preservation

## Post-plan steps for the user

```bash
cd ~/Developer/claude-sop
npm run build
npm run test
npm run test:smoke

npm pack && npm i -g ./claude-sop-*.tgz

# Test E1 drift detection
cd ~/Developer/wrbeautiful-shopify-theme
# Manually edit CLAUDE.md's managed section (add a user line inside markers)
echo "  \n_User-added line, should not be clobbered_" >> CLAUDE.md
claude-sop recap --run
# Expect: recap shows directive: drift_aborted
# Expect: .claude-sop/state/managed-history/conflict-*.md backup created

# Test E3 revert
claude-sop revert
# Expect: CLAUDE.md restored from backup

# Test E2 git-aware
git rebase -i HEAD~2        # enter rebase mode (don't complete, just start)
claude-sop recap --run
# Expect: recap shows directive: git_busy, CLAUDE.md unchanged
git rebase --abort          # exit rebase
claude-sop recap --run      # now proceeds normally
```

## Out of Scope for v16

- Multi-backup generations (we keep 1 backup — user can't go back 3 writes)
- Directive promotion/demotion by user feedback (v17+)
- Cross-project directive sharing (v19+ SaaS)
- Re-running pruned directives against fresh captures ("relearn") — directive history stays but isn't re-evaluated

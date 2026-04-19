# V20: Fix Directive Restore Render Bug (CRITICAL)

## Overview
After uninstall+install, directives are correctly restored to `directive-history.json` (6 entries, all `pruned: false`). But on the next learner tick, they disappear from CLAUDE.md — rendered as "0 directives". This is the product's core value proposition broken.

## Root Cause

**File:** `src/learner/main.ts`, lines 529-534

```typescript
const renderProposals: DirectiveProposalType[] =
  activeEntries !== null
    ? activeEntries
        .map((e) => mergedProposals.find((p) => p.id === e.id))
        .filter((p): p is DirectiveProposalType => p !== undefined)
    : mergedProposals;
```

**Bug:** `activeEntries` comes from directive-history (6 restored entries). `mergedProposals` comes from THIS TICK's detector+LLM proposals — which is EMPTY when there are no new turns. The `.find()` lookup matches active history entries against current proposals by id. Since no proposal was made this tick, ALL 6 are filtered out → `renderProposals = []` → CLAUDE.md shows "0 directives".

**Impact:** Every uninstall+install cycle wipes directives from CLAUDE.md on the next tick. The directives survive in `directive-history.json` but never render. Users see their carefully-learned rules vanish.

**When it triggers:**
- After `auto-sop uninstall && auto-sop install` (restore path)
- On any tick where no new turns were captured (the common case — hourly tick, user hasn't used Claude Code recently)
- Existing directives from history should persist in CLAUDE.md between ticks even without re-proposal

## Implementation Tasks

### Wave 1

1. ARCHITECT: Fix renderProposals to include history-sourced directives
   Files: `src/learner/main.ts`
   Requirements:
   - The `renderProposals` block (lines 529-534) must handle TWO cases:
     a) Directive exists in BOTH `activeEntries` AND `mergedProposals` → use the proposal (current behavior, correct)
     b) Directive exists in `activeEntries` but NOT in `mergedProposals` → synthesize a `DirectiveProposalType` from the history entry
   - The fix should look something like:
     ```typescript
     const renderProposals: DirectiveProposalType[] =
       activeEntries !== null
         ? activeEntries.map((e) => {
             // Prefer the current tick's proposal (fresher rule_text)
             const fromProposal = mergedProposals.find((p) => p.id === e.id);
             if (fromProposal) return fromProposal;
             // Fallback: synthesize from history entry (restored or previously active)
             return {
               id: e.id,
               rule_text: e.rule_text,
               severity: e.severity,
               detector: 'history',  // or whatever the DetectorType for restored entries is
               evidence: {
                 first_seen: e.first_seen,
                 occurrences: e.occurrence_count,
                 session_ids: [],
               },
               created_at: e.last_reinforced,
             } satisfies DirectiveProposalType;
           })
         : mergedProposals;
     ```
   - Check the `DirectiveProposalType` type definition to ensure the synthesized object matches all required fields
   - The `detector` field should use whatever value makes sense for history-sourced entries — check existing detector types
   Acceptance: After uninstall+install+learn-now, CLAUDE.md shows all 6 restored directives. Subsequent ticks with 0 new turns preserve the directives.

2. ARCHITECT: Write regression test
   Files: `test/learner/main.test.ts` or new test file
   Requirements:
   - Test scenario: "restored directives survive a zero-turn tick"
     1. Set up a project with `directive-history.json` containing 3 entries (non-pruned, within TTL)
     2. Set `just-restored.flag`
     3. Run learner tick with 0 new captures
     4. Assert CLAUDE.md managed section contains all 3 directives
   - Test scenario: "restored directives survive multiple consecutive zero-turn ticks"
     1. Same setup
     2. Run learner tick 3 times
     3. Assert directives still present after each tick
   - Test scenario: "restored directives are replaced when re-proposed with fresher text"
     1. History has entry with `rule_text: "old text"`
     2. New detector proposes same id with `rule_text: "improved text"`
     3. Assert CLAUDE.md uses "improved text"
   Acceptance: All 3 test scenarios pass. Tests are deterministic (no flaky timing).

### Wave 2 (depends on Wave 1)

3. ARCHITECT: Dogfood verification on wrbeautiful-shopify-theme
   Files: none (verification only)
   Requirements:
   - Run from `/Users/ugurgokdere/Developer/wrbeautiful-shopify-theme`:
     ```bash
     node /Users/ugurgokdere/Developer/auto-sop/dist/cli.js learn-now
     ```
   - Verify CLAUDE.md managed section now contains directives (grep for `**[error]**` or `**[warning]**`)
   - Run `learn-now` a second time — directives must persist (not disappear)
   - Count directives: should be 6 (matching directive-history.json entries)
   Acceptance: `grep -c '\*\*\[' CLAUDE.md` shows 6 after both runs.

## Quality Gates (MANDATORY)
4. YODA: Code review — the fix in main.ts + new tests
5. APEX: Security review — verify no injection via synthesized proposals
6. ANALYZER: Code improvement review — grade must be C or above

## Finalize
7. ARCHITECT: Commit with message: `fix(learner): render history-sourced directives on zero-turn ticks — fixes restore+tick wipe bug`

## Acceptance Criteria
- After uninstall+install, directives survive the next learner tick
- `directives_active` in recap log matches actual directives in CLAUDE.md
- Existing directives persist across consecutive zero-turn ticks
- New proposals override history entries when same id matches
- wrbeautiful-shopify-theme dogfood: 6 directives visible in CLAUDE.md
- All tests pass (100%)
- All quality gates approved

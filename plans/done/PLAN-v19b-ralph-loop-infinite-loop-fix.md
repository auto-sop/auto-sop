# V19b: Ralph-Loop Infinite Loop Fix (HOTFIX)

## Overview
Ralph-loop's setup script has dangerous defaults: `max_iterations=0` (unlimited) and `completion_promise=null` (no exit condition). When Commander dispatches a task and arguments aren't parsed correctly (quoting issues, truncation), the state file gets created with these defaults → infinite loop that burns resources and blocks the session.

This has happened TWICE now (v18 commit task + v19 URL migration task). Both times required manual deletion of `.claude/ralph-loop.local.md`.

## Root Cause
**File:** `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/ralph-loop/scripts/setup-ralph-loop.sh`
- Line 10: `MAX_ITERATIONS=0` → means "unlimited" → no iteration exit
- Line 11: `COMPLETION_PROMISE="null"` → means "no promise" → no promise exit  
- Combined: loop has NO exit condition at all

**File:** `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/ralph-loop/hooks/stop-hook.sh`
- Line 61: `if [[ $MAX_ITERATIONS -gt 0 ]]` → false when 0 → never exits
- Line 129: `if [[ "$COMPLETION_PROMISE" != "null" ]]` → false when null → never exits
- No safety valve for runaway loops

## Implementation Tasks

### Wave 1 (parallel — independent fixes)

1. ARCHITECT: Add safe defaults to setup-ralph-loop.sh
   Files: `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/ralph-loop/scripts/setup-ralph-loop.sh`
   Requirements:
   - Change line 10: `MAX_ITERATIONS=0` → `MAX_ITERATIONS=15`
     - This is the SAFE DEFAULT — if args aren't parsed, loop still exits after 15 iterations
     - Users who explicitly pass `--max-iterations 0` still get unlimited (that's intentional use)
   - Make `--completion-promise` REQUIRED when `--max-iterations 0` (unlimited):
     - After argument parsing (after line 110), add validation:
       ```bash
       # Safety: if unlimited iterations, completion_promise MUST be set
       if [[ $MAX_ITERATIONS -eq 0 ]] && [[ "$COMPLETION_PROMISE" == "null" ]]; then
         echo "❌ Error: --max-iterations 0 (unlimited) requires --completion-promise" >&2
         echo "   Without a completion promise AND iteration limit, the loop runs forever." >&2
         echo "   Either set --max-iterations to a positive number, or add --completion-promise." >&2
         exit 1
       fi
       ```
   - Update the help text (line 27) to say `default: 15` instead of `default: unlimited`
   - Update the WARNING at line 167 to reflect new safe default
   Acceptance: Running `/ralph-loop "test task"` without flags creates state file with `max_iterations: 15`. Running `--max-iterations 0` without `--completion-promise` fails with error.

2. ARCHITECT: Add safety valve to stop-hook.sh
   Files: `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/ralph-loop/hooks/stop-hook.sh`
   Requirements:
   - Add a HARD SAFETY LIMIT after line 58 (after numeric validation, before max_iterations check):
     ```bash
     # SAFETY VALVE: Absolute maximum regardless of settings
     # Prevents infinite loops from misconfigured state files
     SAFETY_LIMIT=50
     if [[ $ITERATION -ge $SAFETY_LIMIT ]]; then
       echo "🛑 Ralph loop: SAFETY LIMIT reached ($SAFETY_LIMIT iterations)." >&2
       echo "   This usually means the loop was misconfigured (max_iterations=0, no completion promise)." >&2
       echo "   Stopping to prevent infinite resource burn." >&2
       rm "$RALPH_STATE_FILE"
       exit 0
     fi
     ```
   - This is a BELT-AND-SUSPENDERS defense. Even if setup-ralph-loop.sh has a bug, the loop ALWAYS stops at 50.
   Acceptance: A loop with `max_iterations: 0` and `completion_promise: null` stops at iteration 50 with safety message.

## Quality Gates (MANDATORY)
3. YODA: Code review — review both script changes
4. APEX: Security review — verify no injection vectors in the scripts
5. ANALYZER: Code improvement review — grade must be C or above

## Finalize
6. ARCHITECT: Commit all changes with message: `fix(ralph-loop): safe defaults (max_iterations=15) + safety valve (hard stop at 50) to prevent infinite loops`

## Acceptance Criteria
- Default max_iterations is 15 (not 0)
- `--max-iterations 0` without `--completion-promise` exits with error
- Safety valve stops any loop at 50 iterations regardless of settings
- Existing ralph-loop functionality preserved for normal use cases
- All quality gates approved

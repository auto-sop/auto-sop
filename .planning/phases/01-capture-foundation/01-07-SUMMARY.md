# 01-07 Summary: Subagent Linking + Orphan Sweep

## State Marker Convention

- Main-thread turn: `current-turn-<session_id>.json` in state dir
- Subagent turn: `current-turn-<session_id>-<agent_id>.json` in state dir
- Both contain `{ turnDir: string, turnId: string }`

## Sweep Thresholds

| Condition | Action |
|-----------|--------|
| `.pending` dir, no activity > 30s (`STALE_TIMEOUT_MS`) | Finalize with `finalization_reason: 'timeout'`, drop `.pending` suffix |
| `.pending` dir, no activity > 30min (`STALE_YARIM_KALAN_MS`) | Move entire dir to `yarim-kalan/` (quarantine) |
| tmp payload file > 1h (`TMP_MAX_AGE_MS`) | Delete (max 50 per pass via `MAX_TMP_SWEEP_PER_PASS`) |

## Files Created

- `src/capture/writer/subagent.ts` — `resolveSubagentTurn`, `setSubagentCurrentTurn`, `clearSubagentCurrentTurn`, `linkChildToParent`
- `src/capture/writer/orphan-sweep.ts` — `sweepOrphanedTurns`, `sweepOrphanTmpPayloads`
- `src/capture/writer/routes/subagent-route.ts` — `handleSubagentStop`, `handleSubagentUserPromptSubmit`, `handleSubagentPreToolUse`, `handleSubagentPostToolUse`, orphan sweep pre-start hook
- `test/capture/writer/subagent.test.ts` — 13 tests (state markers, linking, parent+child scenario, lazy create, nesting, dual representation)
- `test/capture/writer/orphan-sweep.test.ts` — 7 tests (fresh/stale/ancient dirs, mixed ages, error resilience, tmp sweep, sweep cap)

## Files Modified

- `src/capture/writer/routes/index.ts` — Added `SubagentStop: handleSubagentStop` route + import

## Key Design Decisions

- Bidirectional linking: child `meta.parent_turn_id` + parent `meta.children_turn_ids[]`
- Unlimited nesting depth (E1): no depth cap, no depth stored in meta
- Dual representation (E3): main turn's `tool-calls.jsonl` has Task pre/post lines; child has its own turn dir
- Lazy subagent creation (Pitfall 9): first PreToolUse with unknown agent_id auto-creates turn dir
- Sweep runs ONLY on UserPromptSubmit (B2 turn boundary) via pre-start hook
- `main.ts` was NOT modified (frozen per 01-03)

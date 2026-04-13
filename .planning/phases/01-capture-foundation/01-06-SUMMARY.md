# 01-06 Summary: Global Mirror + Dev-Army Namespace

## Status: COMPLETE

## GlobalIndexLine Schema

```ts
interface GlobalIndexLine {
  turn_id: string;           // unique turn identifier
  session_id: string;        // Claude Code session
  project_id: string;        // 12-char hex project hash
  project_path: string;      // absolute project root
  project_turn_dir: string;  // absolute path to finalized turn dir
  agent: string;             // 'main' or subagent type
  parent_turn_id: string | null;
  finalization_reason: string; // 'stop' | 'subagent_stop' | 'timeout' | 'unknown'
  t: string;                 // ISO timestamp (finalized_at)
}
```

## Files Created/Modified

- `src/capture/writer/global-mirror.ts` — exports `appendGlobalIndexLine`, `resolveGlobalTargetDir`, `migrateGlobalDirOnMove`
- `src/capture/writer/routes/global-mirror-hook.ts` — registers finalize hook (index append) + pre-start hook (move migration)
- `src/capture/writer/routes/index.ts` — ONE LINE added: side-effect import of global-mirror-hook
- `test/capture/writer/global-mirror.test.ts` — 10 tests (append, modes, migration)
- `test/capture/writer/dev-army.test.ts` — 5 tests (namespace routing)

## Key Decisions

- **JSONL index only** — no full copy of capture content (D1 explicit)
- **Migration is LIVE-WIRED** — pre-start hook reads stored project.json synchronously, compares with `ctx.projectId`, computes old/new global dirs via `getCapturePaths`, and calls `migrateGlobalDirOnMove` directly. No TODO deferral (W3 resolved).
- **main.ts NOT edited** — all wiring through hook registries (finalize-hooks + pre-start-hooks) and routes/index.ts barrel
- **No locking for per-turn appends** — single JSON line << PIPE_BUF, so appends are atomic on POSIX
- **Dev-army namespace**: projects under `~/.claude/dev-army/<agent>/` route to `~/.claude/sop/dev-army/<agent>/index.jsonl`
- **Zero new npm deps** — uses only Node.js built-ins

## Acceptance Criteria Met

- CAPT-10: Captures discoverable from `~/.claude/sop/<project-id>/index.jsonl`
- F4: Dev-army namespace working
- D2: Migration wired directly to move detection (W3 — no TODO deferral)

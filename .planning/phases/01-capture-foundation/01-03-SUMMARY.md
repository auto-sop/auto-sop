# Plan 01-03 Summary: Writer Core + Routes Dispatcher

## Status: COMPLETE

## What was built

### Writer entrypoint (`src/capture/writer/main.ts`) — FROZEN
- Reads `argv[2]` tmp payload path, parses via `HookPayload.parse(JSON.parse(...))`
- Kill-switch check (`isCaptureDisabled`) as first gate
- Dispatches via `routes[event.hook_event_name]` table lookup — no switch/if-chain
- `logUnhandled(eventName)` writes sentinel file `unhandled-event.<name>` to state dir
- Top-level `try/catch → exit 0` error boundary — writer MUST never crash CC
- **This file is FROZEN — no downstream plan edits it**

### Routes dispatcher (`src/capture/writer/routes/index.ts`)
- Barrel with `const routes: Partial<Record<HookEventName, Handler>>`
- Currently wires: `UserPromptSubmit` and `Stop`
- Extension contract: downstream plans add ONE LINE each (e.g., `PreToolUse: handlePreToolUse`)

### HandlerContext shape
```ts
interface HandlerContext {
  projectRoot: string;
  projectId: string;
  projectSlug: string;
  paths: CapturePaths;
  scrubber: Scrubber;
  hookShimVersion: string;
}
```

### ErrorWriter late-binding pattern (for 01-05)
- `src/capture/writer/errors.ts` is a STUB: `initErrorWriter(_paths) → null`
- main.ts declares `let errorWriter: ErrorWriter | null = null`
- After paths are built: `errorWriter = initErrorWriter(paths)` (returns null until 01-05)
- All catches use `errorWriter?.('kind', turnId, err)` — no-op until 01-05 lands
- 01-05 OVERWRITES errors.ts with real impl. Zero main.ts edits needed.

### finalizeHooks registration pattern (for 01-06)
- `src/capture/writer/routes/finalize-hooks.ts` exports `registerFinalizeHook(h)` + `finalizeHooks(...)`
- Called after atomic rename in Stop handler
- 01-06 registers its global-mirror index appender via `registerFinalizeHook`

### Pre-start hooks (for 01-05)
- `src/capture/writer/routes/pre-start-hooks.ts` exports `registerPreStartHook(h)` + `runPreStartHooks(...)`
- main.ts calls `runPreStartHooks` before route dispatch; if `abort: true`, skip handler + exit 0
- 01-05 registers its disk-budget-and-pause hook here

### Unhandled event sentinel files
- Written to `<projectStateDir>/unhandled-event.<eventName>` (mode 0600)
- Contains ISO timestamp
- Integration tests (01-08) can `readdirSync` for `unhandled-event.*` to detect missing route wiring
- Once 01-04 and 01-07 land, these sentinels stop appearing for their events

### Transcript format for `extractLastAssistantMessage`
- Reads JSONL where each line is `{ type: 'assistant'|'human', message: { content: [{type: 'text', text: '...'}] } }`
- Returns the text content of the LAST assistant entry
- Returns empty string on missing file, empty file, or all-malformed lines

## Key rule: Readers MUST ignore `.pending` directories (W2)

Any tool consuming capture output (future phases: search index, timeline CLI, anything that `readdirSync`s the captures dir) **MUST filter out entries ending in `.pending`**. A `.pending` dir is an in-flight turn whose meta.json may be mid-write.

Pattern:
```ts
const entries = readdirSync(capturesDir).filter(e => !e.endsWith('.pending'));
```

## Files created
- `src/capture/writer/main.ts` — FROZEN entrypoint
- `src/capture/writer/turn-dir.ts` — createPendingTurnDir, finalizeTurnDir, session state
- `src/capture/writer/meta.ts` — startMeta, writeMeta, readMeta, updateMeta, finalizeMeta
- `src/capture/writer/session-state.ts` — thin re-export of turn-dir session helpers
- `src/capture/writer/prompt-response.ts` — writePromptMd, writeResponseMd, extractLastAssistantMessage
- `src/capture/writer/files-changed.ts` — writeFilesChanged via git diff
- `src/capture/writer/errors.ts` — STUB (01-05 overwrites)
- `src/capture/writer/routes/types.ts` — HandlerContext, Handler, ErrorWriter, HookEventName
- `src/capture/writer/routes/index.ts` — route barrel (extension point)
- `src/capture/writer/routes/main-thread-route.ts` — handleUserPromptSubmit, handleStop
- `src/capture/writer/routes/pre-start-hooks.ts` — pre-start hook registry
- `src/capture/writer/routes/finalize-hooks.ts` — post-finalization hook registry
- `test/capture/writer/turn-dir.test.ts` — 22 tests
- `test/capture/writer/prompt-response.test.ts` — 11 tests
- `test/capture/writer/stop-finalization.test.ts` — 7 tests

## Verification
- `npm run typecheck` — clean
- `npm run lint` — clean (eslint + prettier)
- `npm test` — 195/195 passed (40 new writer tests)
- All files 0600, all dirs 0700
- Scrubber runs before disk write
- meta.json matches TurnMeta schema (C3)
- Atomic writes via temp+rename throughout

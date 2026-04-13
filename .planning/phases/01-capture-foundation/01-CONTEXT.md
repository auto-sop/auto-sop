# Phase 1: Capture Foundation - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning (planned jointly with Phase 2)

<domain>
## Phase Boundary

Every Claude Code turn — user prompts, assistant responses, subagent `Task` I/O, and all tool calls with inputs + outputs — lands on disk as a scrubbed, finalized, atomically-visible capture directory without adding perceptible latency to the user's Claude Code session.

Uses Phase 0 foundations: PathResolver (project id + paths), Config (global + project config), Scrubber (pre-write redaction).

Phase 1 does NOT install hooks (Phase 2), does NOT run a learner (Phase 3), does NOT touch CLAUDE.md (Phase 4). It only produces the on-disk capture store and the hook shim binary that writes into it.
</domain>

<decisions>
## Implementation Decisions

### A — Hook Speed & Write Path

- **A1 — Write strategy: double-fork detached writer.** Hook shim process must exit in <10ms wall-clock. It `fork()`s twice so the grandchild inherits init/launchd as its parent, then the shim exits 0 immediately. The detached grandchild does all the real work (scrub → write → atomic rename). The shim itself never blocks on I/O beyond reading stdin. (Claude's decision — rejected inline-write and queue-file approaches.)
- **A2 — Scrub location: inside the detached writer, never in the shim.** The shim just captures raw stdin to a tmp file and kicks the writer. Scrubbing, YAML/JSON parsing, and directory layout all happen in the detached process. This keeps the shim's hot path trivial.
- **A3 — Latency budget enforcement: CI synthetic benchmark.** CI runs a harness that invokes the shim 200× with representative payloads and asserts p50 < 20ms, p95 < 35ms, p99 < 50ms. Exceeding budget fails CI. Budget is 50ms total per PRIV/CAPT-06; we target well under it to leave headroom.
- **A4 — Large tool outputs:** payloads over a configured threshold (default 256KB) are streamed to `large-outputs/<tool_use_id>.txt.gz` inside the turn directory instead of being inlined into `tool-calls.jsonl`. The JSONL line carries a pointer `{"output_ref": "large-outputs/<id>.txt.gz", "bytes": N}` so the learner can open it lazily.

### B — Turn Finalization

- **B1 — Turn is "finalized" when Stop OR SubagentStop fires — with a 30-second timeout fallback.** If neither fires within 30s of the last observed PostToolUse for a turn, the writer finalizes the turn anyway and tags `meta.json.finalization_reason = "timeout"`. This prevents orphaned in-flight directories from polluting the store forever.
- **B2 — Orphan recovery: auto-detect on next session start.** When the shim runs for a UserPromptSubmit event and sees any turn directories still marked `.pending` from a previous session, it moves them to `yarim-kalan/` (literally "left-unfinished") inside the captures dir before proceeding. The learner can still read them; they're just quarantined from "normal" turns.
- **B3 — Tool calls: separate `pre` and `post` lines in `tool-calls.jsonl`.** PreToolUse writes `{"event":"pre","tool_use_id":"...","tool":"Read","input":{...},"t":...}` and PostToolUse writes `{"event":"post","tool_use_id":"...","output":...,"duration_ms":...,"success":true,"t":...}`. The learner joins on `tool_use_id`. This is more robust than waiting to write a single merged line (lets us survive crashes between pre and post).
- **B4 — Turn boundary: UserPromptSubmit starts a new turn directory.** Each UserPromptSubmit opens `<ts>-<agent>-<file-hash>.pending/`; the name is finalized (rename to drop `.pending`) at Stop/SubagentStop.

### C — Capture File Set

- **C1 — Base file set per turn directory:**
  - `prompt.md` — UserPromptSubmit content, scrubbed
  - `response.md` — assistant text from Stop/SubagentStop, scrubbed
  - `tool-calls.jsonl` — one line per PreToolUse + one line per PostToolUse (see B3)
  - `files-changed.txt` — see C4
  - `meta.json` — see C3
  - `large-outputs/` — (created only if C4 threshold hit)
  - NO `errors.jsonl` at the turn level. Errors go to project-level + global error logs (see F1).
- **C2 — (intentionally unused)** — answer was auto-generated from B3.
- **C3 — `meta.json` schema:**
  ```json
  {
    "schema_version": 1,
    "project_id": "<hash12>",
    "project_slug": "<human-slug>",
    "session_id": "<claude-code-session-id>",
    "turn_id": "<nanoid>",
    "parent_turn_id": null,
    "children_turn_ids": [],
    "agent": "main" | "<subagent-type>",
    "subagent_type": null,
    "started_at": "<iso>",
    "finalized_at": "<iso>",
    "finalization_reason": "stop" | "subagent_stop" | "timeout",
    "hook_shim_version": "<semver>",
    "files_changed_count": <n>,
    "tool_call_count": <n>,
    "scrubber_hit_count": <n>
  }
  ```
- **C4 — `files-changed.txt`: git diff only.** Populated by running `git diff --name-only HEAD` at turn finalization, relative to repo root. If project isn't a git repo, file is empty. Does NOT attempt to diff each PostToolUse individually.

### D — Global Mirror (`~/.claude/sop/<project-id>/`)

- **D1 — Global mirror stores a JSONL index only, not a full copy.** The detached writer appends one line to `~/.claude/sop/<hash12>/index.jsonl` per finalized turn: `{"turn_id":"...","project_path":"...","project_turn_dir":"<abs-path>","agent":"...","t":"..."}`. Full capture content stays in the project dir. Cross-project learner (v2) reads the index and opens project dirs lazily.
- **D2 — Project move detection: auto-migrate on `PathResolver.detectMove()`.** On every shim invocation, if the cached `project.json` identity no longer matches current git remote/toplevel/cwd, the writer renames `~/.claude/sop/<old-hash>/` → `~/.claude/sop/<new-hash>/` and rewrites index.jsonl paths. Migration is logged to `~/.claude/sop/<new-hash>/migration.log`.
- **D3 — Capture kill-switch (`CLAUDE_SOP_LEARNER=1`): shim exits immediately after reading stdin, writes nothing — project OR global.** This prevents learner→hook→learner infinite loops when the learner itself spawns `claude` which triggers hooks.
- **D4 — Cross-project sharing stance: v1 silos every project.** No directive cross-pollination in v1; the global index exists purely for discovery. v2 decides the cross-project learning policy.

### E — Subagent Nesting

- **E1 — Unlimited nesting depth.** Phase 1 doesn't cap depth. Each subagent Task spawns its own capture turn with its own nanoid.
- **E2 — Linking: bidirectional.** Child turns set `parent_turn_id`. Parent turns maintain `children_turn_ids: [...]` appended at Stop. This lets both "drill down" and "walk up" queries work for the learner.
- **E3 — Subagent I/O representation: BOTH flat in parent AND own file in child.** Parent's `tool-calls.jsonl` gets the `Task` pre/post lines like any other tool (with input = subagent prompt, output = subagent result). The child subagent's full turn also lives in its own turn directory linked via `parent_turn_id`. The learner can use whichever view is convenient.
- **E4 — `meta.json` subagent fields: minimal.** Only `subagent_type` and `parent_turn_id` in the child meta; no depth, no index-within-parent, no timing rollups. Keep it simple; the learner can compute derived fields.

### F — Errors + dev-army Dogfood

- **F1 — Error logging: BOTH project and global.** Writer failures (scrub failed, fs full, rename failed) append one line to:
  - `<project>/.claude-sop/errors.jsonl`
  - `~/.claude/sop/<hash12>/errors.jsonl`
  - Both files are append-only, capped at 10MB (then rotated to `.1`). Lines carry `{"t":"...","kind":"...","turn_id":"...","err":"..."}`. The shim itself still exits 0 per CAPT-07.
- **F2 — Error surfacing: ALL THREE channels.**
  1. `npx claude-sop status` prints the last-24h error count.
  2. `npx claude-sop doctor` runs full health check + tails the last 10 error lines.
  3. `npx claude-sop errors` is a dedicated command that cats errors.jsonl (with `--tail`, `--since`, `--global` flags).
- **F3 — Disk budget: auto-pause at 50% of configured cap.** Default cap is 2GB per project. When `du` on `.claude-sop/captures/` crosses 1GB (50%), the writer flips `<project>/.claude-sop/paused.flag` which the shim checks on entry; subsequent captures are skipped (with a single line in errors.jsonl explaining why) until the user runs `purge` or `resume`.
- **F4 — dev-army namespace (dogfood touch).** When the writer detects that a captured turn's `project_path` is inside `~/.claude/dev-army/`, the global mirror namespace is `~/.claude/sop/dev-army/<agent-name>/` instead of `~/.claude/sop/<hash12>/`. `<agent-name>` is derived from the subdirectory name under `~/.claude/dev-army/` (e.g., `commander`, `architect`, `yoda`). This gives a clean dogfood view where the user can browse captures by DEV ARMY agent instead of by project hash. **Scope: v1 ships this detection; "şimdilik" flag means if it gets messy we rip it out in v2 without user impact.**

### Claude's Discretion

- Exact `fork()` / `setsid()` implementation for double-fork in Node (likely `child_process.spawn` with `detached:true, stdio:'ignore'` + `unref()`)
- Turn directory naming: `<iso-compact>-<agent>-<filehash>.pending` → rename to drop `.pending`
- nanoid length (planner picks — default 12 is fine)
- Compression lib for `large-outputs/*.gz` (zlib built-in is fine)
- Exact rotation policy for errors.jsonl (planner picks single `.1` backup or ring of 3)

</decisions>

<specifics>
## Specific Ideas

- **dev-army dogfood goal:** Phase 1 finishes → user can manually hook up `~/.claude/dev-army/commander/` (or whichever agent's working dir) to see captures flow into `~/.claude/sop/dev-army/commander/`. Full install wiring comes in Phase 2; Phase 1 proves the write path works.
- **"Şimdilik" scope discipline:** dev-army namespace is a convenience feature, not a requirement. If it causes a single planner question to spiral, cut it.
- **Zero-network test mandate:** Phase 1 unit + integration tests MUST use the zero-network stub from Phase 0 test harness. The writer must not make any outbound network calls — full stop.
- **No installer work here:** Phase 1 ships the shim binary + writer library. Wiring hooks into `settings.json` is Phase 2. Testing uses fixture stdin payloads that simulate the hook events.

</specifics>

<deferred>
## Deferred Ideas

- **SessionStart / SessionEnd hooks** — deferred to Phase 2 or later; Phase 1 only needs UserPromptSubmit / Pre|PostToolUse / Stop / SubagentStop.
- **Cross-project directive learning** — v2.
- **Binary-file capture (e.g., Write with raw bytes)** — v2; Phase 1 captures text only; binary Write inputs get `[BINARY:sha256]` placeholders.
- **Sqlite index for large capture stores** — v2 (per STORE-01).
- **Live capture tail (`tail -f` equivalent)** — v2 (UX-01).
- **Per-turn error file (`errors.jsonl` inside turn dir)** — rejected in favor of project + global error logs.

</deferred>

---

*Phase: 01-capture-foundation*
*Context gathered: 2026-04-13*

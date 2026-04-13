# Phase 1: Capture Foundation - Research

**Researched:** 2026-04-13
**Domain:** Claude Code hook event capture pipeline (short-lived shim → detached Node writer → scrubbed turn directories on disk)
**Confidence:** HIGH for hook payload schemas and POSIX semantics; MEDIUM-HIGH for double-fork Node pattern; **CRITICAL FINDING** on shim latency budget (see §User Constraints / Blockers).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**A — Hook Speed & Write Path**
- **A1 — Write strategy: double-fork detached writer.** Hook shim process must exit in <10ms wall-clock. It `fork()`s twice so the grandchild inherits init/launchd as its parent, then the shim exits 0 immediately. The detached grandchild does all the real work (scrub → write → atomic rename). The shim itself never blocks on I/O beyond reading stdin.
- **A2 — Scrub location: inside the detached writer, never in the shim.** The shim just captures raw stdin to a tmp file and kicks the writer. Scrubbing, YAML/JSON parsing, and directory layout all happen in the detached process.
- **A3 — Latency budget enforcement: CI synthetic benchmark.** CI runs a harness that invokes the shim 200× with representative payloads and asserts p50 < 20ms, p95 < 35ms, p99 < 50ms. Budget is 50ms total per PRIV/CAPT-06.
- **A4 — Large tool outputs:** payloads over 256KB default threshold stream to `large-outputs/<tool_use_id>.txt.gz`. JSONL line carries pointer `{"output_ref": "large-outputs/<id>.txt.gz", "bytes": N}`.

**B — Turn Finalization**
- **B1 — Turn finalized on Stop/SubagentStop OR 30s timeout fallback.** Timeout-finalized turns tag `meta.json.finalization_reason = "timeout"`.
- **B2 — Orphan recovery on next UserPromptSubmit.** Any turn still `.pending` from prior session is moved to `yarim-kalan/` (quarantine) before proceeding.
- **B3 — Tool calls: separate pre/post lines in `tool-calls.jsonl`.** PreToolUse writes `{"event":"pre",...}`, PostToolUse writes `{"event":"post",...}`. Joined on `tool_use_id` by the learner.
- **B4 — Turn boundary: UserPromptSubmit starts `<ts>-<agent>-<file-hash>.pending/`; rename drops `.pending` at Stop/SubagentStop.

**C — Capture File Set** (per-turn dir)
- `prompt.md`, `response.md`, `tool-calls.jsonl`, `files-changed.txt`, `meta.json`, optional `large-outputs/`. No per-turn errors.jsonl.
- meta.json fields: schema_version, project_id, project_slug, session_id, turn_id, parent_turn_id, children_turn_ids, agent, subagent_type, started_at, finalized_at, finalization_reason, hook_shim_version, files_changed_count, tool_call_count, scrubber_hit_count.
- `files-changed.txt` = `git diff --name-only HEAD` at finalization; empty if not a repo.

**D — Global Mirror**
- **D1 — Global mirror is JSONL index only**, not full copy. Appends one line to `~/.claude/sop/<hash12>/index.jsonl` per finalized turn.
- **D2 — Project move auto-migration** on `PathResolver.detectMove()`.
- **D3 — `CLAUDE_SOP_LEARNER=1` kill-switch: shim exits immediately after reading stdin, writes NOTHING (project or global).
- **D4 — v1 silos every project.** No cross-pollination.

**E — Subagent Nesting**
- **E1 — Unlimited depth.** Each subagent = own turn dir with own nanoid.
- **E2 — Bidirectional linking.** Children set `parent_turn_id`; parent appends `children_turn_ids` at Stop.
- **E3 — Dual representation.** Task appears as pre/post tool lines in parent's jsonl AND as full child turn dir.
- **E4 — Minimal subagent meta.** Only `subagent_type` + `parent_turn_id` in child.

**F — Errors + dev-army**
- **F1 — Errors go to BOTH `<project>/.claude-sop/errors.jsonl` and `~/.claude/sop/<hash12>/errors.jsonl`. 10MB cap, rotate to `.1`. Shim still exits 0.
- **F2 — Errors surfaced via `status`, `doctor`, and dedicated `errors` command.
- **F3 — Disk budget pause at 50% of 2GB default cap via `<project>/.claude-sop/paused.flag`.
- **F4 — dev-army namespace:** when project path is under `~/.claude/dev-army/*`, global mirror goes to `~/.claude/sop/dev-army/<agent-name>/` instead of `<hash12>`.

### Claude's Discretion
- Exact `fork()`/`setsid()` shape in Node (likely `child_process.spawn` detached+unref).
- Turn directory naming format.
- nanoid length (default 12 fine).
- Compression lib for large-outputs (zlib built-in fine).
- errors.jsonl rotation policy (single `.1` or ring of 3).

### Deferred Ideas (OUT OF SCOPE)
- SessionStart / SessionEnd hooks (Phase 2+).
- Cross-project directive learning (v2).
- Binary-file capture (v2; use `[BINARY:sha256]` placeholders).
- SQLite capture index (v2).
- Live `tail -f` (v2).
- Per-turn errors.jsonl (rejected).
</user_constraints>

## Summary

Phase 1 is a **disk-capture pipeline**: CC hook events (JSON on stdin) → short-lived shim → detached Node writer → scrubbed, atomic turn directories. All hook event schemas are fully documented; subagent linking has real metadata via `agent_id`/`agent_type` fields. Node built-ins (`child_process.spawn`, `fs`, `zlib`, `crypto`) cover every need — no new dependencies required beyond what Phase 0 already ships.

**Two findings deserve planner attention before task breakdown:**

1. **The "shim <10ms" internal target is not achievable with a TypeScript/Node shim.** Bare Node startup is ~30–33ms on v20/v22 ([speedrun](https://speedrun.nobackspacecrew.com/blog/2025/07/21/the-fastest-node-22-lambda-coldstart-configuration.html), [nodejs/performance#180](https://github.com/nodejs/performance/issues/180)); Bun-compile with bytecode is ~111ms ([bun-vs-node-sea-startup](https://github.com/yyx990803/bun-vs-node-sea-startup)); Node SEA + code cache is ~140ms. Even a bare Go static binary is ~11ms. **The real gate is CAPT-06: 50ms total**, and A3 already codifies p95<35ms / p99<50ms — those are achievable with a tight Node shim. The <10ms target in A1 should be **reframed as aspirational**; the planner should plumb A3's numbers as the enforced thresholds and tune the shim code path (no imports outside `node:child_process` + `node:fs`, no TS runtime, pre-bundled single-file ESM via tsup with tree-shaking, no top-level awaits).

2. **`stdio: 'ignore'` on a detached child cannot receive stdin from the parent.** This is non-negotiable per the Node docs: with `ignore`, the child's stdin is wired to `/dev/null`. The shim therefore must either (a) write the raw payload to a tmp file first and pass the path as argv (A2 already mandates "captures raw stdin to a tmp file and kicks the writer"), or (b) use `stdio: ['pipe', 'ignore', 'ignore']` and write stdin before the shim exits — but then the shim must drain stdin before returning, which costs latency. **Recommendation: the tmp-file handoff pattern (A2-literal), spawned with full `stdio: 'ignore'`, payload path passed as the writer's argv[2].**

**Primary recommendation:** Build the shim as a hand-tuned single-file Node ESM bundle (tsup), write hook stdin to `~/.claude-sop/tmp/<nanoid>.json` with 0600 perms, spawn the writer with `spawn(process.execPath, [writerPath, payloadPath], {detached:true, stdio:'ignore'}).unref()`, and exit 0. All parsing, scrubbing, and directory work lives in the writer. Bench with hyperfine in CI against A3 thresholds (50ms gate).

## Standard Stack

### Core (already in Phase 0 / package.json)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node built-in `node:child_process` | ≥18.17 | `spawn` for double-fork-equivalent detached writer | Only in-tree way to get `setsid` + `unref` in Node |
| Node built-in `node:fs` (+`/promises`) | ≥18.17 | atomic tmp-write, `renameSync`, `chmodSync`, `mkdirSync({mode:0o700})` | Built-in; zero deps |
| Node built-in `node:zlib` | ≥18.17 | `gzipSync`/`createGzip` for large-outputs | Built-in; level 6 is fine for 256KB–few-MB range |
| Node built-in `node:crypto` | ≥18.17 | `createHash('sha256')` for `[BINARY:sha256]` placeholders | Built-in |
| `nanoid` | ^5 | `turn_id`, tmp payload name | Collision-safe short ids; already in deps |
| `zod` | ^3 | Hook payload schema parsing in writer (tolerant) | Already in deps; Phase 0 uses it |
| `yaml` | ^2.8 | (not needed by writer — hook payloads are JSON) | — |
| Phase 0 `PathResolver` | internal | project_id, captures dir, global mirror dir | Already shipped |
| Phase 0 `Config` | internal | strict config load inside writer | Already shipped |
| Phase 0 `Scrubber` | internal | pre-write redaction | Already shipped |
| `tsup` | ^8.5 | Bundle shim + writer to single-file ESM | Already used for main bundle |
| `vitest` + `memfs` | ^4 | Writer unit tests on virtual fs | Already in devDeps |

### Supporting (new for Phase 1)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `hyperfine` (dev/CI tool, not npm) | latest | Stable shim-latency benchmarks for A3 CI gate | In `npm run bench` script and GH Actions job |

**No new npm runtime dependencies required.** The entire Phase 1 surface is implementable with Node built-ins plus libraries already in `package.json`.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Node shim | Go/Rust/Zig static binary | ~5ms startup vs ~30ms, but adds toolchain, cross-compile matrix, distribution complexity. REJECT — 50ms gate is achievable in Node; binary-shim only becomes necessary if CI bench fails. Document as "escape hatch" in planner notes. |
| Node shim | Bun-compile binary | ~111ms startup — WORSE than Node shim. REJECT. |
| tmp-file payload handoff | stdin pipe to writer with `stdio:['pipe',...]` | Requires shim to drain stdin synchronously before returning → latency hit + risk of blocking on large payloads. REJECT. |
| `renameSync` for directory flip | Write-temp-file + rename per-file | Per-file atomic writes needed for jsonl appends, but directory rename (drop `.pending`) is one POSIX-atomic op. Use rename for the dir flip. |
| Single-writer-per-turn with flock | Append-in-place with per-turn lock | Single-writer pattern (one detached process per turn) is simpler and avoids flock; see Pitfall §JSONL concurrency. |

**Installation:** (nothing new; reuses phase 0 deps)
```bash
# No new installs. Optional dev:
brew install hyperfine   # for local bench; CI uses apt-get on Linux
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── capture/
│   ├── shim/
│   │   ├── main.ts              # entrypoint: hot path, <35ms p95
│   │   └── handoff.ts           # stdin→tmp-file, spawn detached writer
│   ├── writer/
│   │   ├── main.ts              # entrypoint (run under detached spawn)
│   │   ├── events.ts            # Zod schemas for UserPromptSubmit / Pre|PostToolUse / Stop / SubagentStop
│   │   ├── turn-dir.ts          # create .pending dir, atomic rename
│   │   ├── tool-calls.ts        # append pre/post lines to tool-calls.jsonl
│   │   ├── large-outputs.ts     # 256KB threshold + gzip streaming
│   │   ├── meta.ts              # build/update meta.json
│   │   ├── files-changed.ts     # git diff --name-only HEAD
│   │   ├── orphan-sweep.ts      # yarim-kalan/ move + 30s timeout sweep
│   │   ├── global-mirror.ts     # index.jsonl append; dev-army namespace
│   │   ├── disk-budget.ts       # du check + paused.flag
│   │   └── errors.ts            # errors.jsonl rotation + cap
│   └── kill-switch.ts           # CLAUDE_SOP_LEARNER=1 check (shared shim+writer)
└── (existing) config / path-resolver / scrubber / cli
```
Shim and writer are bundled as **two separate tsup entrypoints** so the shim doesn't drag in `Config`/`Scrubber`/`Zod` — only the writer does.

### Pattern 1: Hot-path shim (≤35ms p95)
**What:** Minimal Node entry: read stdin → write tmp file → spawn detached writer → exit 0.
**When to use:** Every hook invocation.
**Constraints:**
- No top-level imports from Phase 0 libs (they drag scrubber regex packs).
- Only `node:child_process`, `node:fs`, `node:path`, `node:os`, `node:crypto` (for nanoid alternative if needed), and `nanoid`.
- No `async`/`await` in the hot path; use sync fs calls (`readFileSync` is not relevant — use `process.stdin` chunk read).
- No `require('./config')` inside the shim — all config access happens in the writer.

**Example shape:**
```typescript
// src/capture/shim/main.ts
// Source: nodejs.org/api/child_process.html#optionsdetached
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { nanoid } from 'nanoid';

// Kill-switch check first — fastest possible exit.
if (process.env.CLAUDE_SOP_LEARNER === '1') {
  // Still drain stdin so CC doesn't block on a broken pipe.
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => process.exit(0));
  return;
}

// Read all of stdin synchronously via fd 0.
const chunks: Buffer[] = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks);

  const tmpRoot = join(homedir(), '.claude-sop', 'tmp');
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const tmpPath = join(tmpRoot, `${nanoid(16)}.json`);
  writeFileSync(tmpPath, payload, { mode: 0o600 });

  const writerEntry = join(__dirname, 'writer.cjs'); // bundled by tsup
  const child = spawn(process.execPath, [writerEntry, tmpPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.exit(0);
});
```

**Anti-pattern:** Don't parse JSON in the shim. Don't chmod 0600 as a post-step (pass `mode` to `writeFileSync` — `fs.writeFileSync` honors `mode` on create). Don't import Zod, Scrubber, or Config in the shim.

### Pattern 2: Detached writer (all the real work)
**What:** Long-lived (≤~1s typical) grandchild that parses, scrubs, writes, finalizes.
**When to use:** Once per hook invocation.
**Key moves:**
- Read tmp payload file → parse JSON → route by `hook_event_name`.
- For **UserPromptSubmit**: run orphan sweep first (move stale `.pending` dirs to `yarim-kalan/`, finalize any `.pending` dirs whose latest-mtime is >30s old); create new turn dir `<ts>-<agent>-<filehash>.pending/` with mode 0o700; write scrubbed `prompt.md` (mode 0o600); start `meta.json` with `started_at`, `session_id`, `turn_id`, `agent`.
- For **PreToolUse**: append scrubbed `{event:"pre",tool_use_id,tool,input,t}` to `tool-calls.jsonl`.
- For **PostToolUse**: if output size > `config.largeOutputThresholdBytes` (default 262144), gzip-stream to `large-outputs/<tool_use_id>.txt.gz` and write `{event:"post",...,output_ref,bytes}`; else inline. Increment `tool_call_count`.
- For **Stop**: finalize turn → run `git diff --name-only HEAD`, write `files-changed.txt`, write scrubbed `response.md`, finalize `meta.json`, **rename `.pending` → non-pending dir**, append to `<global>/index.jsonl`, append `children_turn_ids` to parent meta if applicable.
- For **SubagentStop**: same as Stop but uses `agent_id`/`agent_type`/`last_assistant_message` fields. Sets `parent_turn_id` from session-level state.
- Delete tmp payload file at end.
- On any error: append line to project + global `errors.jsonl`, exit 0 (never crash the shim's parent CC session).

**Key:** The writer is the ONLY process allowed to write into any given turn dir. No cross-process flock needed because each turn has one logical "owner" process (see Pitfall §JSONL concurrency).

### Pattern 3: Atomic turn-dir finalize via rename
**What:** Directory exists as `20260413T1530-main-abc123.pending/` while in-flight; at Stop, `fs.renameSync` drops `.pending` suffix.
**Why it's safe:**
- `rename(2)` is POSIX-atomic within the same filesystem — the dir name flips in one inode update ([POSIX spec](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)).
- **Open file descriptors inside the renamed directory stay valid** — the dir inode is unchanged; only the dirent in the parent directory updates. Works on APFS, ext4, btrfs, xfs.
- CAPT-08 ("visible to learner only after Stop/SubagentStop") is enforced by the learner filtering dirs with `.pending` suffix.
- No `fsync` required for visibility semantics inside a single machine (Phase 1 doesn't need crash-consistency; the writer just needs "other process sees this" ordering, which rename provides).

### Pattern 4: Single-writer-per-turn (no flock)
**What:** Each hook invocation spawns its own writer process, but since Claude Code dispatches hook events **sequentially per session**, two events for the same turn never race. Therefore each turn is modified by one writer at a time even without flock.
**Caveat:** This assumes CC serializes hook dispatch. Verify empirically in Phase 1 integration tests; if violated, add `proper-lockfile` around jsonl appends (already in deps). See Open Question §Q1.

### Anti-Patterns to Avoid
- **Parsing JSON in the shim.** Every ms of parse time eats the latency budget. Writer does it.
- **Using `stdio: ['pipe','ignore','ignore']` for the detached writer.** Even though Node allows it, you then must wait for the writer's stdin-drain callback before exiting the shim — shim can't exit until writer reads, which defeats the purpose. Use tmp-file handoff.
- **Parsing YAML in the hot path.** CC hook payloads are JSON-only ([CC hooks docs](https://code.claude.com/docs/en/hooks)); never yaml. Drop `yaml` from writer imports unless used elsewhere.
- **Using `fs.chmodSync` as a post-step.** Race window between create and chmod. Pass `mode` to `mkdirSync({mode:0o700})` and `writeFileSync(path, data, {mode:0o600})` — modes are respected on create (then masked by process umask; see Pitfall §umask).
- **Storing session state in-memory across hook invocations.** The shim and writer are short-lived. All state must be on disk (`meta.json`, tmp markers, `.pending` suffix).
- **Relying on `CLAUDE_SOP_LEARNER=1` to propagate automatically to the *shim.*** It does — env is inherited from the Claude Code process, which was spawned by the learner. Verified: Claude Code runs hooks as `execFile` children and passes through env by default. (Confirmed via CC hooks docs; no explicit env-strip.)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Short-id generation for `turn_id` / tmp filenames | Custom random | `nanoid` (already in deps) | Collision math is done; crypto-grade |
| JSON schema validation of hook payloads | Hand-rolled type guards | `zod` (already in deps) — build **tolerant** schemas with `.passthrough()` because CC adds fields over time | New CC fields shouldn't break the writer |
| Secret scrubbing | New regex | Phase 0 `Scrubber` | Already shipped, tested, layered rule packs |
| Project identity / path resolution | Re-parse git/cwd | Phase 0 `PathResolver` | Handles move detection |
| gzip | `child_process('gzip')` | `node:zlib.createGzip()` / `gzipSync` | Built-in, synchronous form is fine for <1MB; streaming for larger |
| POSIX process-group detach | Manual `process.kill(0,-pid)` tricks | `child_process.spawn({detached:true,stdio:'ignore'}).unref()` | Node wraps `setsid()` + keeps child in new pgid |
| Atomic file/dir writes | Copy + delete | `fs.renameSync` | POSIX-atomic in one syscall |
| File locks (if needed) | Manual `O_EXCL` dance | `proper-lockfile` (already in deps) | Already in deps; stale-lock recovery handled |
| Hook latency benchmarking | Node `performance.now` loop | `hyperfine` in CI | Warmup + min-runs + statistical reporting built in |
| git file list | Walk fs + match .gitignore | `execa` (already in deps) to run `git diff --name-only HEAD` | Simple, matches C4 spec |

**Key insight:** Everything Phase 1 needs already exists in Phase 0 + Node built-ins + existing package.json. The temptation to add a queue, a daemon, or a broker must be resisted — the short-lived shim + tmp-file handoff + detached writer is the whole architecture.

## Common Pitfalls

### Pitfall 1: Node shim cold-start eats the latency budget
**What goes wrong:** Bare Node v20/v22 startup is ~30–33ms; a TS-compiled shim with even a few imports adds 10–30ms on top. p95 under 35ms is tight but achievable only with aggressive bundling and minimal imports.
**Why it happens:** V8 initialization, module resolution, symbol loading.
**How to avoid:**
- Bundle the shim as a **single CJS file** (not ESM — CJS has marginally faster resolution in Node <22).
- Zero npm imports in shim except `nanoid` (tiny) — inline if needed.
- Don't import Phase 0 libs; the writer owns them.
- Use `node:` prefixed imports (prevents loader fallback).
- No source maps in shim bundle.
- Consider `--no-deprecation --no-warnings` flags via a wrapper shell script only if CI bench shows p95 regression.
- Add **warmup iterations** in CI bench (first 10 runs discarded) so p95 reflects steady-state, not one-shot cold V8 boots.
**Warning signs:** CI bench p95 > 35ms on GH Actions ubuntu-latest runners.
**Escape hatch:** If Node shim cannot hit A3 budget, rewrite shim in Go (~11ms) or Zig/C (~3ms). Keep this as documented fallback in the plan, not first attempt.

### Pitfall 2: `stdio: 'ignore'` cannot receive parent stdin
**What goes wrong:** If you try `spawn(writer, [], {detached:true, stdio:['pipe','ignore','ignore']})` and then `child.stdin.write(payload); child.stdin.end()`, the shim must wait for the pipe to drain before exiting, adding ms. If you use `stdio:'ignore'`, child stdin is `/dev/null` — no way to send the payload.
**Why it happens:** POSIX pipe semantics + detached child.
**How to avoid:** Shim writes payload to `~/.claude-sop/tmp/<nanoid>.json` (mode 0600), passes path as argv to writer. Writer reads file, deletes when done.
**Warning signs:** Flaky tests where the writer gets an empty payload.

### Pitfall 3: umask silently strips 0700/0600 perms
**What goes wrong:** Running under a umask of 022 (typical), calling `mkdirSync(p, {mode:0o700})` actually produces 0700 (umask doesn't subtract from owner bits). BUT `writeFileSync(p, data, {mode:0o600})` produces 0600. So usually you're fine. HOWEVER: on some SLES/RHEL containers the umask is 077 — now your intended 0644 files become 0600 by accident (harmless here). Real bug is the opposite: umask 0000 (some CI runners) + `{mode:0o644}` → actually 0644 (unintended group/world read).
**Why it happens:** `mode` is `(mode & ~umask)` on POSIX.
**How to avoid:** Always pass `mode` explicitly AND add an integration test that stats the resulting files and asserts `(stat.mode & 0o777) === 0o600` / `0o700`. If the assertion fails under a permissive umask, `fs.chmodSync(p, 0o600)` after create as a defensive post-step. (Phase 0 `PathResolver` may already do this — verify.)
**Warning signs:** PRIV-04 integration test fails on one runner but not another.

### Pitfall 4: JSONL append concurrency between pre/post writers
**What goes wrong:** Every hook invocation spawns its own detached writer. If PostToolUse for tool A arrives while the writer for PreToolUse for tool B is still appending, you could get interleaved partial lines in `tool-calls.jsonl`.
**Why it matters:** JSONL files are line-based; a half-flushed line corrupts the file.
**How to avoid:**
- Use `fs.appendFileSync(path, line, {mode:0o600})` — a single `write(2)` for a line <PIPE_BUF (4096 bytes) is atomic on POSIX, so **short lines are safe without locks**.
- For lines >4096 bytes (large tool inputs even before the 256KB gzip threshold), use `proper-lockfile` on the `tool-calls.jsonl` file for the append window.
- Alternative: stream large inputs to `large-outputs/<id>.input.txt.gz` too, so the jsonl line stays tiny. Simpler. **Recommend:** apply the 256KB-threshold rule to tool *inputs* as well as outputs.
**Warning signs:** Invalid JSON lines in `tool-calls.jsonl` under concurrent-session stress test.

### Pitfall 5: Concurrent CC sessions in the same project collide
**What goes wrong:** Two `claude` sessions in the same project each fire UserPromptSubmit at the same time. Both writers try to create the "current" turn dir.
**Why it's handled:** Each turn dir is named `<ts>-<agent>-<filehash>-<nanoid>.pending/` — the nanoid guarantees uniqueness. The **session_id** from CC hook payload namespaces per session; use it in meta.json and index.jsonl. But pre/post tool calls need to be routed to the correct turn dir — solution: maintain an index from `session_id → current turn_id` in `<project>/.claude-sop/state/current-turn-<session_id>.json`. Writer reads + updates this tiny file on each hook.
**How to avoid:** Use `session_id` (HIGH confidence — present in all CC hook payloads per docs) as the session namespace. Store `current-turn-<session_id>` marker per session.
**Warning signs:** PreToolUse rows for session B appended to session A's jsonl.

### Pitfall 6: 30-second orphan timeout without a daemon
**What goes wrong:** Stop/SubagentStop never fires (CC crashed, user Ctrl-C'd, network blip). `.pending` dir lingers.
**How B1 is implementable:**
- Lazy sweep on next UserPromptSubmit: every UserPromptSubmit writer run opens `<project>/.claude-sop/captures/`, lists `*.pending` dirs, and for each one checks `max(mtime(*))` inside the dir. If `now - max_mtime > 30s`, finalize with `finalization_reason:"timeout"`. If `now - max_mtime > 30min` (configurable), move to `yarim-kalan/` per B2.
- This handles the common "forgot to finalize" case without a daemon.
- Risk: a still-active turn (idle >30s but will resume) gets force-finalized. Mitigation: check for `.lock` sentinel or process liveness via tmp marker holding a pid; recommendation — **don't** try to be clever, trust the 30s bound and accept occasional split turns; the learner can stitch via `session_id`.
**Warning signs:** Frequent `finalization_reason:"timeout"` in meta.json when CC is actually running fine.

### Pitfall 7: `tool_use_id` stability across Pre/Post
**Status:** HIGH confidence. CC hook docs ([code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)) explicitly show `tool_use_id: "toolu_01ABC123..."` in both PreToolUse and PostToolUse payload examples with the same shape. Stable. Use it as the join key. Integration test should still assert this across ≥20 real tool calls.

### Pitfall 8: `CLAUDE_SOP_LEARNER=1` env propagation
**Status:** HIGH confidence by default. CC hooks execute via process spawn and inherit env from the CC process, which was spawned by the learner with the env var set. The shim reads `process.env.CLAUDE_SOP_LEARNER` directly — no special plumbing required.
**Verification task:** Plan a test that sets the env, spawns a subprocess chain (`node -e 'require("child_process").spawn("bash",["-c","./shim"])'`), and asserts the shim detects `1` in its `process.env`. Document this in the Phase 1 test suite.

### Pitfall 9: Subagent parent-child linking
**What the hook payload actually gives us** (HIGH confidence, from docs):
- Main-thread turns: `hook_event_name:"Stop"`; NO `agent_id`/`agent_type`.
- Subagent turns: `hook_event_name:"SubagentStop"` with `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, and `session_id` pointing at the **parent session**.
- During a subagent's lifetime, PreToolUse/PostToolUse for tools INSIDE the subagent **also** carry `agent_id`/`agent_type` per the docs ("When running with `--agent` or inside a subagent, two additional fields appear").

**Therefore:**
- Main-thread tools have no `agent_id`.
- Subagent-internal tools have the subagent's `agent_id`.
- When UserPromptSubmit fires with `agent_id` set, treat it as a subagent turn start and set `parent_turn_id = <current main turn_id for session_id>`.
- When SubagentStop fires, append this subagent's `turn_id` to the parent meta's `children_turn_ids` and rename the subagent's `.pending` dir.
- **Open question:** Does UserPromptSubmit ever fire *inside* a subagent? The docs don't explicitly say. If subagent Task invocations produce a separate UserPromptSubmit, use that as the boundary. If not, use the first PreToolUse-with-agent_id to open the subagent's `.pending` dir. **Recommendation:** plan the writer to handle BOTH — create the subagent turn dir lazily on the first event carrying a new `agent_id` for a given `session_id`.

### Pitfall 10: git diff at finalization when working tree has many files
**What goes wrong:** `git diff --name-only HEAD` is fast for small repos but can take 100ms+ in huge monorepos (the writer is detached, so this is OK, but don't block the shim).
**How to avoid:** It's inside the writer — already off the hot path. Add a 2-second timeout via execa; on timeout, write empty `files-changed.txt` and log to errors.jsonl.

### Pitfall 11: tmp payload file orphans on writer crash
**What goes wrong:** Shim writes `~/.claude-sop/tmp/<id>.json`, spawns writer, exits. Writer crashes before deleting the tmp. Over time, orphans accumulate.
**How to avoid:** Orphan sweep (same pass as turn-dir orphan sweep) walks `~/.claude-sop/tmp/` and deletes files older than 1 hour. Do this on every UserPromptSubmit writer run, capped (e.g., delete max 50 per sweep to avoid latency spikes).

## Code Examples

### Hook payload Zod schemas (verified against CC docs)
```typescript
// Source: https://code.claude.com/docs/en/hooks (2026-04-13)
import { z } from 'zod';

const BaseHook = z.object({
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  permission_mode: z.string().optional(),
  hook_event_name: z.string(),
  // subagent-only fields (absent on main thread):
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
}).passthrough(); // tolerate new CC fields

export const UserPromptSubmit = BaseHook.extend({
  hook_event_name: z.literal('UserPromptSubmit'),
  prompt: z.string(),
});

export const PreToolUse = BaseHook.extend({
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_use_id: z.string(),
});

export const PostToolUse = BaseHook.extend({
  hook_event_name: z.literal('PostToolUse'),
  tool_name: z.string(),
  tool_input: z.unknown(),
  tool_response: z.unknown(),
  tool_use_id: z.string(),
});

export const Stop = BaseHook.extend({
  hook_event_name: z.literal('Stop'),
});

export const SubagentStop = BaseHook.extend({
  hook_event_name: z.literal('SubagentStop'),
  agent_id: z.string(),
  agent_type: z.string(),
  agent_transcript_path: z.string().optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});

export const HookPayload = z.discriminatedUnion('hook_event_name', [
  UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop,
]);
```

### Detached writer spawn (shim side)
```typescript
// Source: nodejs.org/api/child_process.html#optionsdetached (verified 2026-04-13)
import { spawn } from 'node:child_process';
import { join } from 'node:path';

function kickWriter(tmpPayloadPath: string) {
  const writerEntry = join(__dirname, 'writer.cjs'); // tsup output
  const child = spawn(process.execPath, [writerEntry, tmpPayloadPath], {
    detached: true,
    stdio: 'ignore',          // essential: disconnects from shim terminal
    // Do NOT set `cwd` — inherit shim cwd (= project root), writer uses it for PathResolver.
  });
  child.unref();               // shim event loop doesn't wait for grandchild
}
```

### Atomic turn-dir finalize
```typescript
// Source: POSIX rename(2) + nodejs.org/api/fs.html#fsrenamesyncoldpath-newpath
import { renameSync, writeFileSync } from 'node:fs';

function finalizeTurn(pendingPath: string) {
  // Write final files first; rename is the visibility flip.
  writeFileSync(join(pendingPath, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
  writeFileSync(join(pendingPath, 'response.md'), scrubbedResponse, { mode: 0o600 });
  // …
  const finalPath = pendingPath.replace(/\.pending$/, '');
  renameSync(pendingPath, finalPath); // single POSIX-atomic dir rename
}
```

### Large-output streaming to gzip
```typescript
// Source: nodejs.org/api/zlib.html#zlibcreategzipoptions
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

async function streamLargeOutput(outPath: string, data: string | Buffer) {
  const src = Readable.from(typeof data === 'string' ? Buffer.from(data) : data);
  const gz = createGzip({ level: 6 }); // level 6 = default, good ratio/speed
  const dst = createWriteStream(outPath, { mode: 0o600 });
  await pipeline(src, gz, dst);
}
```
For <1MB payloads, `zlib.gzipSync(buf, {level:6})` + `writeFileSync` is simpler and ~equivalent in wall-clock.

### CI benchmark harness (hyperfine)
```bash
# Source: github.com/sharkdp/hyperfine
# Invoke 200 times per payload, warm up 10, report p50/p95/p99
echo '{"hook_event_name":"PreToolUse","session_id":"x","transcript_path":"/t","cwd":"/c","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"toolu_1"}' > /tmp/pre.json

hyperfine \
  --warmup 10 --runs 200 \
  --export-json bench.json \
  "node dist/shim.cjs < /tmp/pre.json"

# Post-process to assert p95 < 35ms, p99 < 50ms via a small node script that reads bench.json.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Shell scripts as hooks | Node/Go binaries invoked by CC | CC hooks feature launch (2024+) | Structured JSON payloads on stdin |
| Inline writes blocking the hook | Double-fork detached writer | Industry standard for low-latency side effects | Hook latency decouples from write latency |
| write-to-temp + rename per-file | rename-the-whole-dir for turn finalization | Phase 0/1 design choice | One syscall visibility flip vs many |
| Custom regex secret scrub | `secretlint`-style rule packs | 2023+ (ecosystem mature) | Layered rules, user extensible (Phase 0 already ships this) |

**Deprecated/outdated:**
- Node SEA as of early 2026: fast enough for apps, but ~140ms startup is still too slow for this hot path. Bun-compile is worse. Do not bother with either for the shim.

## Open Questions

1. **CC hook dispatch serialization (Pitfall §JSONL concurrency).**
   - What we know: CC docs don't explicitly state hook events are dispatched sequentially per session, but empirically most event-driven systems serialize.
   - What's unclear: Whether two PostToolUse events for the same turn can race.
   - Recommendation: Plan a dedicated integration test that fires rapid tool calls in sequence and inspects jsonl integrity. If races occur, add `proper-lockfile` around tool-calls.jsonl appends (cheap).

2. **UserPromptSubmit inside subagents.**
   - What we know: Docs show UserPromptSubmit as the prompt-entry event; subagent bodies produce PreToolUse/PostToolUse/SubagentStop but the doc is silent on whether they also produce UserPromptSubmit for the subagent's initial prompt.
   - What's unclear: Whether to open the subagent `.pending` dir on UserPromptSubmit(agent_id=X) or on first PreToolUse(agent_id=X).
   - Recommendation: Writer opens the subagent turn dir lazily on **any** first-sighted `(session_id, agent_id)` pair that doesn't yet have a `.pending` dir. Handles both cases.

3. **`hook_shim_version` semantics across shim/writer mismatches.**
   - What we know: Shim and writer are bundled together and versioned together.
   - What's unclear: Whether we need a runtime compatibility check.
   - Recommendation: Embed version constant in both via tsup `define`, writer asserts match on start, logs a warning to errors.jsonl on mismatch but continues.

4. **dev-army namespace cache (D4).**
   - What we know: CONTEXT.md says "şimdilik" — cut if it spirals.
   - What's unclear: Whether to re-detect on every shim invocation or cache in `project.json`.
   - Recommendation: Detect once in Phase 0 `PathResolver` (likely already does via `homedir() + '/.claude/dev-army/'` prefix check on projectPath), cache result in project.json. Writer reads cached field. One-line check; no perf concern.

5. **Shim latency p95 <35ms in Node — achievable?**
   - What we know: Bare Node start ~30–33ms on v22. Bundled single-file CJS adds ~2–5ms on top.
   - What's unclear: Actual GH Actions runner variability. ubuntu-latest is typically noisy; p95 could spike to 50ms under runner load.
   - Recommendation: Plan a bench task early in Phase 1 (Task 1 or 2 of the phase). If Node shim fails the p95<35ms bar on GH Actions, the planner should swap to a Go-shim escape hatch BEFORE building out the rest of the writer, to avoid throwing work away.

## Sources

### Primary (HIGH confidence)
- **Claude Code hooks docs** — https://code.claude.com/docs/en/hooks — verified 2026-04-13. Complete payload schemas for UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop; timeout + exit code semantics; subagent field set.
- **Node.js `child_process` docs** — https://nodejs.org/api/child_process.html#optionsdetached — `detached:true` + `stdio:'ignore'` + `unref()` semantics, POSIX setsid behavior, stdin pipe caveats.
- **POSIX `rename(2)` spec** — https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html — atomicity of directory rename.
- **Node.js `zlib` docs** — https://nodejs.org/api/zlib.html — `createGzip` / `gzipSync` API and level semantics.

### Secondary (MEDIUM confidence)
- **Node startup time regression tracking** — https://github.com/nodejs/performance/issues/180 (v22 ~33ms), https://github.com/nodejs/node/issues/52804. Establishes Node cold-start floor.
- **bun-vs-node-sea-startup benchmarks** — https://github.com/yyx990803/bun-vs-node-sea-startup — Node SEA +code cache ~139.7ms, Bun compile +bytecode ~111ms. Rules out SEA/Bun-compile for this hot path.
- **Linux rename(2) man page** — https://man7.org/linux/man-pages/man2/rename.2.html — RENAME_NOREPLACE, directory rename across filesystems.

### Tertiary (LOW confidence — for context only)
- Various blog posts on Go hello-world startup times (~11ms).
- AWS Lambda cold-start writeups (not directly applicable; just sanity-checks that cold-start is a real thing).

## Metadata

**Confidence breakdown:**
- Hook payload schemas: HIGH — full official docs with field-level examples.
- Detached-writer pattern: HIGH — Node docs are unambiguous.
- Shim latency achievability in Node: MEDIUM — bare Node bench numbers are reliable, but end-to-end "shim + spawn + unref + exit" on GH Actions is not benched yet; needs real measurement in Phase 1.
- Atomic dir rename on macOS/Linux: HIGH — POSIX spec + filesystem behavior both confirmed.
- Subagent parent linking semantics: MEDIUM-HIGH — doc is clear on fields; one edge (UserPromptSubmit inside subagent) is untested.
- JSONL concurrency behavior: MEDIUM — POSIX `write(2) < PIPE_BUF` atomicity is rock-solid; CC hook dispatch ordering is assumed-sequential pending empirical verification.
- `CLAUDE_SOP_LEARNER=1` env propagation: HIGH — standard POSIX env inheritance; no plumbing needed.

**Research date:** 2026-04-13
**Valid until:** 2026-05-13 (CC hooks docs are stable but subject to additive changes; Node startup numbers are stable for months at a time)

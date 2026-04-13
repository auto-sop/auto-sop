# Architecture Research — claude-sop

**Domain:** Claude Code plugin (hooks + background learner)
**Confidence:** MEDIUM-HIGH

---

## 1. Component Decomposition

```
+--------------------------------------------------------------+
|                        CLI (bin/claude-sop)                  |
|   install | uninstall | status | learn-now | show | doctor   |
+------+--------------+-------------+-------------+------------+
       |              |             |             |
       v              v             v             v
   Installer     SchedulerMgr   LearnerRunner   StatusReporter
       |              |             |             |
       |              |             v             |
       |              |         Indexer <---------+
       |              |             ^
       |              |             |
       |              |        CaptureStore  (filesystem schema)
       |              |             ^
       |              |        CaptureWriter
       |              |             ^
       |              |         Scrubber
       |              |             ^
       |              |         HookShim  (bin/claude-sop-hook)
       v              v
   CLAUDE.md       launchd/
   ManagedSection  systemd unit
```

### Final Component List (12)

| # | Component | Responsibility |
|---|-----------|----------------|
| 1 | **CLI** | Arg parsing, subcommand dispatch, exit codes |
| 2 | **Installer** | Write hooks config, call SchedulerMgr, seed dirs, patch `.gitignore`, init CLAUDE.md managed section |
| 3 | **PathResolver** | Compute project-id, resolve project vs global dirs |
| 4 | **HookShim** (`claude-sop-hook`) | Ultra-thin entry invoked by Claude Code; reads stdin JSON, double-forks CaptureWriter, exits 0 in <50ms |
| 5 | **CaptureWriter** | Normalize hook payload, run Scrubber, compute files-changed, append to capture dir atomically |
| 6 | **Scrubber** | Regex-based redaction with pluggable rule packs + entropy filter |
| 7 | **CaptureStore** | Filesystem schema owner; atomic writes, directory conventions, lockfiles |
| 8 | **Indexer** | Maintain `index.jsonl` / `manifest.json`, incremental updates |
| 9 | **LearnerRunner** | Read recent captures via Indexer, call `claude` CLI, parse directives, invoke ManagedSectionEditor |
| 10 | **ManagedSectionEditor** | Read/write the `<!-- claude-sop:managed -->` block in CLAUDE.md with conflict detection and backups |
| 11 | **SchedulerMgr** | Install/remove launchd plist (macOS) or systemd --user unit (Linux), with cron fallback |
| 12 | **Config** | Load/save `~/.claude-sop/config.json`, env overrides, API keys via keychain |

---

## 2. Data Flows

### 2a. Install — `npx claude-sop install`
```
user -> CLI(install)
   -> PathResolver.resolve(cwd)   # project-id, project dir, global dir
   -> Config.ensure()
   -> Installer.run()
        -> ensure <proj>/.claude-sop/ and ~/.claude/sop/<pid>/
        -> patch <proj>/.gitignore  (add .claude-sop/)
        -> write hook entries (plugin hooks.json OR settings.json)
             pointing to `claude-sop-hook <event>`
        -> ManagedSectionEditor.ensure(<proj>/CLAUDE.md)
        -> SchedulerMgr.install()
             macOS  -> ~/Library/LaunchAgents/sh.claude-sop.learner.plist
             Linux  -> ~/.config/systemd/user/claude-sop-learner.timer+service
             fallback -> cron
        -> print next steps
```

### 2b. Capture — UserPromptSubmit
```
user types prompt
  -> Claude Code fires UserPromptSubmit hook
  -> spawns: claude-sop-hook UserPromptSubmit  (stdin = JSON event)
  -> HookShim:
       read stdin (bounded 5 MB)
       write raw event to <captureDir>/.inbox/<uuid>.json (atomic rename)
       fork-detach CaptureWriter
       exit 0  (target: <50ms wall time)
  -> CaptureWriter (background):
       load inbox file
       determine turn dir: captures/<sessionId>/<turnId>/
       Scrubber.run(prompt text)
       write prompt.md atomically
       update meta.json
       delete inbox file
       Indexer.notify(turnDir)
```

### 2c. Capture — Tool call (Edit/Write)
```
Claude calls Edit -> PreToolUse hook
  -> HookShim -> inbox -> CaptureWriter:
       append JSONL line to tool-calls.jsonl (phase=pre)
       record pending tool_use_id
tool executes -> PostToolUse hook
  -> append JSONL line (phase=post) keyed by tool_use_id
  -> if Edit/Write/MultiEdit: parse path, append to files-changed.txt
  -> update meta.json counters
Stop / SubagentStop
  -> finalize response.md, meta.json, remove .pending marker
  -> Indexer.commit(turnDir)
```

**Key principle:** the turn is the atomic unit. Turns are only visible to the Indexer after `Stop`/`SubagentStop` (prevents learner from reading half-written turns).

### 2d. Learn — hourly scheduler tick
```
launchd/systemd fires -> `claude-sop learn-now --from-scheduler`
  -> LearnerRunner.run()
       flock(learner.lock, LOCK_EX|LOCK_NB)  [exit 0 if held]
       Indexer.queryNewSince(lastRunTs)
       build learner prompt (bounded tokens)
       spawn: `claude -p <prompt>` (timeout 600s)
       parse JSON: proposed directives + rationale
       dedupe against existing managed section
       ManagedSectionEditor.apply(<proj>/CLAUDE.md, directives)
         -> hash-check prior managed section
         -> write .tmp -> atomic rename
         -> backup .bak in global history dir
       update state.json { lastRunTs, lastHash }
       release lock
```

### 2e. Status — `npx claude-sop status`
```
CLI(status)
  -> read <global>/state.json
  -> Indexer.summary() (turns total, last 24h, pending inbox)
  -> SchedulerMgr.query() (launchctl list / systemctl --user status)
  -> ManagedSectionEditor.stat(<proj>/CLAUDE.md)
  -> print table: paths, hook wiring, scheduler state, last run, directive count
```

### 2f. Uninstall — `npx claude-sop uninstall [--purge]`
```
SchedulerMgr.remove()       (launchctl unload + rm plist)
Installer.unpatchSettings() (remove hook entries; preserve others)
ManagedSectionEditor.clear()
if --purge: rm -rf <proj>/.claude-sop/ and ~/.claude/sop/<pid>/
```

---

## 3. Hook Event → Capture File Mapping

```
<captureRoot>/
  .inbox/                   # staging: raw hook payloads
    <uuid>.json
  sessions/
    <sessionId>/
      <turnId>/
        .pending            # marker; removed on finalize
        prompt.md           # UserPromptSubmit (scrubbed)
        response.md         # Stop / SubagentStop
        tool-calls.jsonl    # PreToolUse + PostToolUse merged by tool_use_id
        files-changed.txt   # from Edit/Write/MultiEdit Post events
        meta.json           # session, timings, counts
      index.jsonl           # per-session append-only turn index
  index.jsonl               # global append-only turn index
  state/
    learner.lock
    state.json
```

| Hook Event | File(s) Written | Notes |
|---|---|---|
| `UserPromptSubmit` | `prompt.md`, creates turn dir with `.pending` | First event in a turn |
| `PreToolUse` | append `tool-calls.jsonl` (phase=pre) | Keyed by tool_use_id |
| `PostToolUse` | append `tool-calls.jsonl` (phase=post); update `files-changed.txt` | Edit/Write/MultiEdit only for files-changed |
| `Stop` | `response.md`, finalize `meta.json`, remove `.pending`, append `index.jsonl` | Main-agent turn end |
| `SubagentStop` | same as Stop in subagent turn dir (parent linked via meta) | Nested |
| `SessionStart`/`SessionEnd` | `session.meta.json` at session level | Lifecycle |

**`meta.json`:**
```json
{
  "sessionId": "...",
  "turnId": "...",
  "parentTurnId": null,
  "agent": "main" | "subagent:<name>",
  "model": "...",
  "startedAt": 1712900000,
  "finishedAt": 1712900042,
  "toolCallCount": 7,
  "filesChanged": 3,
  "tokens": { "in": 1234, "out": 5678 },
  "scrubberHits": 0,
  "schema": 1
}
```

---

## 4. Storage Strategy

**Project-primary, global-secondary.**

| Data | Location | Why |
|---|---|---|
| Captures (truth) | `<proj>/.claude-sop/captures/` | Local; developer can `rm -rf` easily; privacy-first |
| Captures mirror | pointer only (not duplicated bytes) | Global dir just has `project.json` → project root path |
| Index (source) | `<proj>/.claude-sop/captures/index.jsonl` | — |
| Index (cache) | `~/.claude/sop/<pid>/index.jsonl` (optional) | Cross-project learner queries |
| Learned directives | `<proj>/CLAUDE.md` managed section | Where Claude Code reads them |
| Directive backups | `~/.claude/sop/<pid>/managed-history/` | Out of repo |
| Learner state | `~/.claude/sop/<pid>/state/state.json` | Survives project rm |
| Learner lock | `~/.claude/sop/<pid>/state/learner.lock` | Global; scheduler-accessible |
| Config (model, rule packs) | `~/.claude-sop/config.json` | User-scoped |
| Secrets (API keys) | Keychain / libsecret; fallback to env | Never in config.json |
| Rule packs (scrubber) | `node_modules/claude-sop/rules/` + `~/.claude-sop/rules/` overrides | Layered |

**.gitignore:** Installer appends `/.claude-sop/` to project `.gitignore`. CLAUDE.md remains tracked.

---

## 5. Project Identity

```
1. git remote get-url origin  -> normalize -> sha256[:12]
2. git rev-parse --show-toplevel -> abs path -> sha256[:12]
3. cwd absolute path -> sha256[:12]
```

Paired with a human-readable slug: `~/.claude/sop/<slug>-<hash>/` e.g. `claude-sop-a1b2c3d4e5f6`. Slug from repo name or `basename(cwd)`. Store both in `project.json` at install time.

**Non-git projects:** fall back to path hash. Moving the directory creates a new identity; provide `claude-sop migrate --from <old>` later if needed.

---

## 6. Concurrency

| Concern | Strategy |
|---|---|
| Parallel HookShim invocations | Each writes unique `<uuid>.json` to `.inbox/`. No contention. |
| Parallel CaptureWriter runs | `mkdir` lock on `sessions/<sid>/<tid>/.writer.lock`. Append-only writes use `O_APPEND` (atomic <PIPE_BUF 4KB). Larger writes use temp+rename. |
| Turn finalization race | Finalizer drains pending inbox entries tagged with turnId BEFORE removing `.pending`. |
| Learner reads while hooks write | Learner only reads turns without `.pending` marker and only entries in `index.jsonl` (append-only, committed at finalize). Reader-writer separation by convention. |
| Learner vs learner | `flock(learner.lock, LOCK_EX\|LOCK_NB)` — second invocation exits 0 immediately. |
| Learner writes CLAUDE.md while user editing | Atomic rename. Sha256 check: if managed section hash differs from last-known, treat as user-edit conflict (see failure modes). Keep `.bak` in history dir. |
| Subagent turns nested in parent turn | Subagent gets own `<turnId>` with `parentTurnId` in meta. Independent dirs. |
| Inbox drain ordering | Filenames are uuid v7 (timestamp-prefixed) → chronological sort. |

**Principle:** favor atomic rename + append-only logs + directory markers over inter-process locks. Locks only around learner run and CLAUDE.md write.

---

## 7. Failure Modes

| Failure | Detection | Strategy |
|---|---|---|
| HookShim crashes | — | Wraps body in try/catch; ALWAYS exits 0; logs to `hook-errors.log`. Wall-time cap 200ms. Never blocks Claude Code. |
| HookShim slow | wall time > threshold | Double-forks CaptureWriter; main shim returns before real work. |
| Disk full | EIO / ENOSPC | Log and drop event. Size budget caps `.claude-sop/` at N MB; auto-prune oldest turns. |
| Scrubber false-negative | user report | Layered: baseline pack + custom pack. `claude-sop scrub --recheck` re-runs over existing captures. `claude-sop nuke-captures` one-liner. Document best-effort nature. |
| Learner `claude` CLI hangs | timeout | 600s timeout; kill process group. Next tick retries. |
| Learner auth/rate-limit fail | non-zero exit | Record lastError in state.json, back off, exit 0 so scheduler keeps us registered. |
| User edited managed section | hash mismatch | Save user version to `conflict-<ts>.md`; merge-and-dedupe OR skip + warn (configurable). |
| Scheduler install fails | non-zero `launchctl load` | Report but don't abort. Hook capture still works. Offer `--scheduler-only`. Cron fallback. |
| `claude-sop-hook` binary missing | Claude Code hook errors | Installer writes absolute resolved path; uninstall unpatches settings. Doctor detects stale entries. |
| CLAUDE.md missing | — | ManagedSectionEditor creates it with only the managed block. |
| Duplicate managed markers | parse error | Refuse write; log conflict; status reports. User fixes manually. |
| Hook event schema change | unknown fields | Store raw payload verbatim in `raw.json` alongside parsed files. Schema version in meta.json. |

---

## 8. Build Order DAG

```
Tier 0 (parallel, no deps):
  PathResolver | Scrubber (baseline pack) | Config

Tier 1 (depend on Tier 0):
  CaptureStore | ManagedSectionEditor | SchedulerMgr

Tier 2:
  CaptureWriter (CaptureStore + Scrubber)
  Indexer       (CaptureStore)

Tier 3:
  HookShim      (CaptureWriter)
  Installer     (SchedulerMgr + ManagedSectionEditor + CaptureStore)
  LearnerRunner (Indexer + ManagedSectionEditor + Config)

Tier 4:
  CLI (all above)

Tier 5:
  Doctor, rule-pack loader, cross-platform smoke tests
```

**Natural phase mapping (roadmap hint):**

1. **Phase A — Foundations:** PathResolver, Config, Scrubber, CaptureStore. Pure libs, unit-testable, no Claude Code needed.
2. **Phase B — Capture path:** CaptureWriter, HookShim, Indexer. Ends with manual hook install showing turn directories appear.
3. **Phase C — Managed section + Learner (offline):** ManagedSectionEditor, LearnerRunner with mock `claude` CLI. Verify directive write-back end-to-end.
4. **Phase D — Scheduler + Installer + CLI:** SchedulerMgr, Installer, CLI. First working `npx claude-sop install`.
5. **Phase E — Real learner, cross-platform, hardening:** real `claude` CLI integration, macOS+Linux schedulers, conflict handling, doctor, rule packs v2.

---

## Confidence Notes

- **HIGH:** component decomposition, data flows, storage, concurrency primitives (atomic rename, flock, append-only JSONL are standard POSIX).
- **MEDIUM:** exact Claude Code hook event names and payloads. Architecture is event-name-agnostic; only HookShim's dispatch table would change if schema drifts.
- **MEDIUM:** launchd/systemd unit authoring details. Cron fallback is safety net.
- **LOW / open:** whether `claude` CLI supports clean `-p` non-interactive JSON-out mode. Flag for Phase C spike. LearnerRunner abstracts "the LLM call" so architecture survives either way.

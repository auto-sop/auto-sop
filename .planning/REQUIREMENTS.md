# Requirements: claude-sop

**Defined:** 2026-04-13
**Core Value:** Claude Code never makes the same mistake twice — captured history becomes enforced project rules automatically, without the user manually writing CLAUDE.md entries.

## v1 Requirements

### Install / Distribution

- [ ] **INST-01**: User can install claude-sop into a project by running `npx claude-sop install` from the project root
- [ ] **INST-02**: Install is idempotent — running `npx claude-sop install` twice does not duplicate hooks, schedulers, or CLAUDE.md managed sections
- [ ] **INST-03**: Install wires Claude Code hooks without destructively stomping existing user hooks or other plugin hooks
- [ ] **INST-04**: Install auto-appends `.claude-sop/` to the project `.gitignore` (creates the file if missing) so captures are never committed
- [ ] **INST-05**: Install ensures `CLAUDE.md` exists at the project root and contains an empty claude-sop managed section with sentinel markers (`<!-- claude-sop:begin -->` / `<!-- claude-sop:end -->`)
- [ ] **INST-06**: User can cleanly uninstall via `npx claude-sop uninstall`, removing hooks, the scheduler, and managed-section markers while preserving captures by default
- [ ] **INST-07**: Install has NO npm `postinstall` side effects — all state-changing work happens only when the user runs `install` explicitly
- [ ] **INST-08**: Install and runtime require Node ≥18.17 and run on macOS (Intel + Apple Silicon) and Linux; Windows is explicitly unsupported in v1

### Capture

- [ ] **CAPT-01**: Plugin captures every `UserPromptSubmit` event (user prompt text, session id, turn id, timestamp)
- [ ] **CAPT-02**: Plugin captures every `PreToolUse` event (tool name, inputs, tool_use_id) for all tools including Read, Edit, Write, Bash, Task, Grep, Glob
- [ ] **CAPT-03**: Plugin captures every `PostToolUse` event (tool output, success/error, duration, file changes if any)
- [ ] **CAPT-04**: Plugin captures `Stop` and `SubagentStop` events, producing the assistant's response text for each turn
- [ ] **CAPT-05**: Capture writes land in `<project>/.claude-sop/captures/{timestamp}-{agent-name}-{file-changed}-{short-hash}/` with a stable directory schema (prompt.md, response.md, tool-calls.jsonl, files-changed.txt, meta.json)
- [ ] **CAPT-06**: Capture hooks exit in under 50ms of wall-clock time and NEVER block the user's Claude Code session
- [ ] **CAPT-07**: Capture hooks NEVER exit non-zero and never emit to stdout — failures are logged to an error file and the hook exits 0
- [ ] **CAPT-08**: Turns are visible to the learner only after `Stop`/`SubagentStop` fires (prevents reading half-written turns)
- [ ] **CAPT-09**: Subagent Task calls are captured with full input (prompt, subagent type) and full output (result), linked to the parent turn
- [ ] **CAPT-10**: Captures are mirrored/pointed-to from `~/.claude/sop/<project-id>/` so a cross-project learner view is possible

### Privacy / Scrubbing

- [ ] **PRIV-01**: Secret scrubber runs BEFORE any capture content is written to disk (not after)
- [ ] **PRIV-02**: Scrubber detects and redacts Anthropic API keys (`sk-ant-*`), AWS access keys, GitHub tokens, generic `KEY=VALUE` env patterns, and high-entropy unprefixed secrets
- [ ] **PRIV-03**: Scrubber is layered — baseline regex pack + user-overridable rule pack at `~/.claude-sop/rules/`
- [ ] **PRIV-04**: Capture files are written with `0600` permissions and capture directories with `0700`
- [ ] **PRIV-05**: Zero network egress from the plugin itself — only the `claude` CLI spawned by the learner may make network calls
- [ ] **PRIV-06**: User can run `npx claude-sop purge` to nuke all captures (project + global) in a single command
- [ ] **PRIV-07**: Plugin disables capture entirely when the `CLAUDE_SOP_LEARNER=1` env var is set, preventing learner→hook→learner infinite loops

### Scheduler / Learner

- [ ] **SCHED-01**: Install registers an hourly scheduled job using launchd on macOS and a systemd user unit on Linux (cron as fallback)
- [ ] **SCHED-02**: Scheduler runs even when no Claude Code session is active
- [ ] **SCHED-03**: Only one learner runs at a time — overlapping ticks are prevented via `flock` on a lock file
- [ ] **SCHED-04**: Scheduler uses absolute binary paths and survives machine reboots
- [ ] **SCHED-05**: Uninstall removes the scheduler unit cleanly with no zombie processes or stale plist/unit files
- [ ] **LEARN-01**: Hourly learner reads new captures since the last run and analyzes them for mistake patterns
- [ ] **LEARN-02**: Learner's default model invocation uses the user's existing `claude` CLI login — no Anthropic API key required
- [ ] **LEARN-03**: Learner optionally uses a user-configured model via a user-supplied API key (model name selected at install or via `npx claude-sop config set model <name>`)
- [ ] **LEARN-04**: Learner requires evidence from at least 3 separate sessions before proposing a directive (prevents single-sample hallucination)
- [ ] **LEARN-05**: Learner output is strict JSON against a schema — non-conforming output is rejected
- [ ] **LEARN-06**: Learner wraps capture content in `<capture>` tags marked as untrusted to resist prompt injection via tool output
- [ ] **LEARN-07**: Learner has a 600-second timeout; hangs are killed and logged without blocking the next tick
- [ ] **LEARN-08**: Learner defaults to dry-run when run manually via `npx claude-sop learn-now --dry-run`; scheduled runs apply directives

### CLAUDE.md Management

- [ ] **MD-01**: Learner appends corrective directives only inside the managed section (`<!-- claude-sop:begin -->` / `<!-- claude-sop:end -->`) — content outside the markers is never modified
- [ ] **MD-02**: Each directive entry includes a timestamp, a plain-language rule, and an evidence pointer to the source capture(s)
- [ ] **MD-03**: ManagedSectionEditor performs atomic writes via temp-file + rename; never partial writes
- [ ] **MD-04**: Before writing, the editor hashes the current managed section; if it differs from the last-known hash, the user's edits are preserved (backup to `~/.claude/sop/<pid>/managed-history/conflict-<ts>.md`) and the learner skips this run with a warning in status
- [ ] **MD-05**: ManagedSectionEditor skips writes entirely during active `git rebase` / `git merge` to avoid corrupting conflict markers
- [ ] **MD-06**: Directives are deduplicated against existing managed-section content (no repeat rules)
- [ ] **MD-07**: Directives have a TTL and the managed section is capped at a configurable max (default ~25 active directives)
- [ ] **MD-08**: User can run `npx claude-sop revert` to roll back the most recent managed-section change from backup

### CLI / Inspection

- [ ] **CLI-01**: `npx claude-sop status` prints a table with project id, paths, hook wiring state, scheduler state, last learner run, pending captures, and directive count
- [ ] **CLI-02**: `npx claude-sop recent [--since 1h]` lists recent captured turns
- [ ] **CLI-03**: `npx claude-sop show <session-or-turn-id>` prints the contents of a specific capture
- [ ] **CLI-04**: `npx claude-sop doctor` runs a health check: hook wiring correct, scheduler installed, CLAUDE.md markers present, scrubber rules loadable, disk space available
- [ ] **CLI-05**: `npx claude-sop pause` temporarily disables capture+learner without uninstalling; `npx claude-sop resume` re-enables
- [ ] **CLI-06**: All commands return non-zero exit codes on failure and print actionable error messages

## v2 Requirements

### Cross-Project Learning

- **XPROJ-01**: Learner can synthesize directives across multiple projects into a global `~/.claude/CLAUDE.md` managed section
- **XPROJ-02**: User can opt a project in/out of cross-project learning contribution

### Advanced Detectors

- **DETECT-01**: Beyond the 6 v1 deterministic detectors, add LLM-assisted rule phrasing and pattern recognition
- **DETECT-02**: Lesson decay / usefulness tracking (directives that never fire get archived)

### Storage

- **STORE-01**: Optional lazy SQLite query cache built from the JSONL index for fast `recent`/`show` on large capture sets

### UX

- **UX-01**: `npx claude-sop tail` — live capture viewer
- **UX-02**: TUI dashboard (blessed/ink) for browsing captures and directives

## Out of Scope

| Feature | Reason |
|---|---|
| Cloud sync / hosted backend | Privacy-first — zero network egress is a core property |
| Team sharing of directives | Single-developer scope for v1; teams come later |
| Real-time mistake detection during a running session | Hourly batch is sufficient and avoids blocking hooks |
| Auto-fixing source code | Learner only writes CLAUDE.md; fixes are for the next agent run |
| Windows native support | macOS + Linux only in v1; Windows via WSL |
| GUI / web dashboard | CLI + `/sop:status` slash command only |
| Multi-model capture | Only Claude Code captures matter; other LLM tools out of scope |
| Editing files other than CLAUDE.md | Scope discipline — CLAUDE.md is the single authoritative surface |
| LLM-as-judge evaluation of captures | v1 uses deterministic rule-based detectors only; LLM analysis is a v2 differentiator |
| Encrypted storage at rest | Filesystem perms (0600/0700) + XDG cache location are sufficient for v1; encryption is a v2 consideration |

## Traceability

*Populated during roadmap creation.*

| Requirement | Phase | Status |
|---|---|---|
| INST-01 | — | Pending |
| INST-02 | — | Pending |
| INST-03 | — | Pending |
| INST-04 | — | Pending |
| INST-05 | — | Pending |
| INST-06 | — | Pending |
| INST-07 | — | Pending |
| INST-08 | — | Pending |
| CAPT-01 | — | Pending |
| CAPT-02 | — | Pending |
| CAPT-03 | — | Pending |
| CAPT-04 | — | Pending |
| CAPT-05 | — | Pending |
| CAPT-06 | — | Pending |
| CAPT-07 | — | Pending |
| CAPT-08 | — | Pending |
| CAPT-09 | — | Pending |
| CAPT-10 | — | Pending |
| PRIV-01 | — | Pending |
| PRIV-02 | — | Pending |
| PRIV-03 | — | Pending |
| PRIV-04 | — | Pending |
| PRIV-05 | — | Pending |
| PRIV-06 | — | Pending |
| PRIV-07 | — | Pending |
| SCHED-01 | — | Pending |
| SCHED-02 | — | Pending |
| SCHED-03 | — | Pending |
| SCHED-04 | — | Pending |
| SCHED-05 | — | Pending |
| LEARN-01 | — | Pending |
| LEARN-02 | — | Pending |
| LEARN-03 | — | Pending |
| LEARN-04 | — | Pending |
| LEARN-05 | — | Pending |
| LEARN-06 | — | Pending |
| LEARN-07 | — | Pending |
| LEARN-08 | — | Pending |
| MD-01 | — | Pending |
| MD-02 | — | Pending |
| MD-03 | — | Pending |
| MD-04 | — | Pending |
| MD-05 | — | Pending |
| MD-06 | — | Pending |
| MD-07 | — | Pending |
| MD-08 | — | Pending |
| CLI-01 | — | Pending |
| CLI-02 | — | Pending |
| CLI-03 | — | Pending |
| CLI-04 | — | Pending |
| CLI-05 | — | Pending |
| CLI-06 | — | Pending |

**Coverage:**
- v1 requirements: 51 total
- Mapped to phases: 0 (populated by roadmapper)
- Unmapped: 51 ⚠️ (expected — roadmap pending)

---
*Requirements defined: 2026-04-13*
*Last updated: 2026-04-13 after initial definition*

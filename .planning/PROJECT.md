# claude-sop

## What This Is

A Claude Code plugin, distributed via `npx claude-sop install`, that captures every agent and subagent interaction in a project (user prompts, assistant responses, subagent Task I/O, and all tool calls with their inputs and outputs) and uses an hourly background learner to detect recurring mistakes and automatically append corrective directives to the project's `CLAUDE.md`. Built for any Claude Code user who wants their agents to stop repeating the same mistakes.

## Core Value

Claude Code never makes the same mistake twice — captured history becomes enforced project rules automatically, without the user manually writing CLAUDE.md entries.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Plugin installs via `npx claude-sop install` and wires Claude Code hooks into the project's `settings.json`
- [ ] Hooks capture user prompts, assistant responses, subagent Task I/O, and all tool calls (Read/Edit/Write/Bash/etc.) with full inputs and outputs
- [ ] Each capture is written to `<project>/.claude-sop/captures/{timestamp}-{agent-name}-{file-changed}-{short-hash}/` with structured files
- [ ] Captures are mirrored/aggregated to `~/.claude/sop/<project-id>/` for cross-project learning
- [ ] Secret scrubber redacts API keys, tokens, and env var values on capture (regex-based, offline)
- [ ] `.claude-sop/` and `~/.claude/sop/` are gitignored by default (auto-added on install)
- [ ] An hourly learner runs automatically via OS scheduler (launchd on macOS, systemd user unit on Linux) and defaults to using the `claude` CLI (no API key required)
- [ ] Learner is optionally configurable to use a different model via user-supplied API key (model selected at install/config time)
- [ ] Learner detects mistake patterns: "user corrected X" events in captured history, and flags recurrences across sessions
- [ ] Learner auto-appends corrective directives to project `CLAUDE.md` inside a managed section (`<!-- claude-sop:begin --> / <!-- claude-sop:end -->`) with timestamps and evidence pointers to source captures
- [ ] Managed section writes preserve user edits outside the markers and handle edits inside the markers without clobbering
- [ ] Plugin is uninstallable cleanly via `npx claude-sop uninstall` (removes hooks, stops scheduler, leaves captures)
- [ ] Plugin ships with a `/sop:status` slash command (or equivalent) so users can see capture count, learner status, and recent directives

### Out of Scope

- Sending captures to a hosted cloud service — privacy-first, everything stays local
- Real-time mistake detection during a running session — hourly batch is sufficient
- Multi-user team sharing of learned directives — single-developer scope for v1
- Automatic fixing of source code — learner only writes to CLAUDE.md; fixes are for the agents to apply on next run
- Windows-native support in v1 — macOS and Linux only (Windows via WSL)
- GUI/dashboard — CLI + `/sop:status` slash command only

## Context

- **Ecosystem:** Claude Code CLI with its hooks system (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`) configured in `settings.json`. Plugin packaging is an emerging convention in the Claude Code community.
- **Distribution target:** npm registry → `npx claude-sop install`. Users run one command and it wires everything up.
- **Privacy stance:** Zero telemetry, zero remote calls by default. Captures live in the user's filesystem only. Secret scrubbing is a non-negotiable default.
- **Learner auth model:** Piggyback on the user's existing Claude Code login — do NOT require an Anthropic API key. Optional secondary model for users who want it (e.g., a cheaper/faster model for the learning pass).
- **Why this exists:** Claude Code repeats the same mistakes across sessions. A fix made on Monday gets re-broken Wednesday. CLAUDE.md is the fix, but writing it manually has friction. This plugin closes the loop automatically.
- **Similar tools for inspiration:** Langfuse, Helicone, OpenLLMetry, Braintrust — AI observability tools. None target Claude Code specifically, and none write back corrective rules.

## Constraints

- **Tech stack**: Node.js (plugin is an npm package); must run on macOS and Linux without additional runtimes beyond Node 18+
- **Auth**: Learner must work with the user's existing Claude Code CLI login — no API key required in the default path
- **Privacy**: Zero network calls except what the `claude` CLI itself makes; captures never leave the machine
- **Compatibility**: Must coexist with existing `settings.json` hooks configured by the user or other plugins — merge, don't clobber
- **Scheduler**: No user-facing cron editing; plugin manages its own launchd/systemd unit transparently
- **Distribution**: Single `npx claude-sop install` command does full setup; uninstall must be equally clean
- **Performance**: Capture hooks must not add perceptible latency to the user's Claude Code session (<50ms overhead per hook invocation)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Capture via Claude Code hooks (settings.json) | Official, supported, no CLI wrapping required | — Pending |
| Dual storage (per-project + global aggregate) | Per-project captures travel with the repo (gitignored); global aggregate enables cross-project learning | — Pending |
| Hourly learner cadence | Batch processing is simpler than real-time; 1h strikes balance between freshness and resource cost | — Pending |
| Default learner = `claude` CLI, no API key | Users already auth'd via Claude Code — zero friction install | — Pending |
| Managed section markers in CLAUDE.md | Preserves user edits outside the markers; well-understood convention (e.g., `# BEGIN MANAGED BY X`) | — Pending |
| Secret scrubbing on by default | Captured tool I/O will contain env var values, tokens — must redact before writing to disk | — Pending |
| npm package via `npx` | No global install needed; always runs latest | — Pending |
| macOS + Linux only for v1 | launchd/systemd are first-class; Windows can use WSL | — Pending |

---
*Last updated: 2026-04-13 after initialization*

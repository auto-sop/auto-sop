# Roadmap: claude-sop

**Created:** 2026-04-13
**Depth:** standard
**Phases:** 6
**Coverage:** 51/51 v1 requirements mapped

## Phases

- [ ] **Phase 0: Distribution Decision + Foundations** — Resolve hybrid distribution model, build pure-logic foundations (PathResolver, Config, Scrubber) with scrubber passing secret-corpus gate.
- [ ] **Phase 1: Capture Foundation** — Hook shim, capture writer, and turn-directory store produce scrubbed, finalized captures on disk with <50ms hook latency and fail-open semantics.
- [ ] **Phase 2: Installer + Scheduler + CLI Skeleton** — First working `npx claude-sop install` wires hooks, registers hourly launchd/systemd scheduler, and exposes inspection/control CLI end-to-end.
- [ ] **Phase 3: Learner (Offline then `claude` CLI)** — Hourly learner reads captures, runs deterministic detectors with evidence threshold N=3, emits strict-JSON directive proposals, injection-resistant.
- [ ] **Phase 4: ManagedSectionEditor** — Atomic, hash-checked, git-aware writer appends learner directives to CLAUDE.md managed section without ever clobbering user edits; revertible.
- [ ] **Phase 5: Inspection CLI + Packaging Hardening** — `recent`/`show` inspection commands land; publish-ready packaging (provenance, publint, attw, CC version matrix, docs, "looks-done" checklist).

## Phase Details

### Phase 0: Distribution Decision + Foundations
**Goal:** Resolve the hybrid (npm CLI + plugin bundle + scheduler) distribution shape and land the pure-logic foundations (paths, config, scrubber) that everything downstream depends on.
**Depends on:** Nothing (first phase)
**Requirements:** INST-07, INST-08, PRIV-01, PRIV-02, PRIV-03, PRIV-05
**Success Criteria** (what must be TRUE):
  1. Distribution model is written down as an accepted ADR: `npx claude-sop install` copies a Claude Code plugin bundle AND registers an OS scheduler; unresolved sub-questions resolved.
  2. Scrubber (pure library) redacts `sk-ant-*`, AWS keys, GitHub tokens, `KEY=VALUE` env patterns, and high-entropy blobs at >95% recall against a fixture corpus — before any write path exists.
  3. Scrubber is layered: baseline regex pack plus user-overridable rule pack loaded from `~/.claude-sop/rules/`.
  4. Plugin declares Node ≥18.17 engines and refuses to run on Windows; CI proves macOS + Linux matrix green.
  5. Package contains zero `postinstall` lifecycle script and zero outbound network calls from any code path exercised by unit tests.
**Plans:** TBD

### Phase 1: Capture Foundation
**Goal:** Every Claude Code turn — prompts, tool calls, subagent Task I/O, responses — lands on disk as a scrubbed, finalized, atomically-visible capture directory without perceptibly slowing the user's session.
**Depends on:** Phase 0 (uses Scrubber + PathResolver + Config)
**Requirements:** CAPT-01, CAPT-02, CAPT-03, CAPT-04, CAPT-05, CAPT-06, CAPT-07, CAPT-08, CAPT-09, CAPT-10, PRIV-04, PRIV-07
**Success Criteria** (what must be TRUE):
  1. After a real Claude Code session, `<project>/.claude-sop/captures/{timestamp}-{agent}-{file}-{hash}/` contains `prompt.md`, `response.md`, `tool-calls.jsonl`, `files-changed.txt`, and `meta.json` for every completed turn — and nothing for in-flight turns.
  2. Every captured file is mode `0600` and every capture directory is mode `0700`; scrubbed content contains zero matches for the Phase 0 secret corpus.
  3. Hook shim completes in under 50ms wall-clock (measured in CI), always exits 0, never writes to stdout, and logs failures to an error file.
  4. Subagent `Task` invocations appear as captures linked to their parent turn with both input and output preserved.
  5. Captures written in `<project>/.claude-sop/` are discoverable (pointer or mirror) under `~/.claude/sop/<project-id>/`, and capture is fully suppressed when `CLAUDE_SOP_LEARNER=1` is set in the environment.
**Plans:** TBD

### Phase 2: Installer + Scheduler + CLI Skeleton
**Goal:** A user running `npx claude-sop install` in a project gets hooks wired, an hourly OS scheduler registered, a gitignored capture dir, an empty managed section in CLAUDE.md, and a working CLI for status/health/pause — all idempotent, all cleanly uninstallable.
**Depends on:** Phase 1 (installer wires Phase 1 hooks; CLI reads Phase 1 captures)
**Requirements:** INST-01, INST-02, INST-03, INST-04, INST-05, INST-06, SCHED-01, SCHED-02, SCHED-03, SCHED-04, SCHED-05, PRIV-06, CLI-01, CLI-04, CLI-05, CLI-06
**Success Criteria** (what must be TRUE):
  1. User runs `npx claude-sop install` in a fresh project and afterwards: hooks are live in the project's Claude Code configuration (non-destructively merged with any existing hooks), `.claude-sop/` is in `.gitignore`, and `CLAUDE.md` contains empty `<!-- claude-sop:begin -->` / `<!-- claude-sop:end -->` markers.
  2. Running `npx claude-sop install` a second time is a no-op: no duplicate hooks, no duplicate scheduler units, no duplicate managed-section markers.
  3. After install, an hourly scheduler job is registered via launchd (macOS) or systemd user unit (Linux, cron fallback) using absolute binary paths, survives reboot, and runs even with no Claude Code session active; concurrent ticks are blocked by `flock`.
  4. `npx claude-sop status` prints a table with project id, paths, hook wiring state, scheduler state, last learner run, pending captures, and directive count; `npx claude-sop doctor` runs a full health check; `pause`/`resume`/`purge` behave as specified; all commands return non-zero on failure with actionable errors.
  5. `npx claude-sop uninstall` removes hooks, the scheduler unit (no zombies, no stale plists), and managed-section markers while preserving captures by default.
**Plans:** TBD

### Phase 3: Learner (Offline then `claude` CLI)
**Goal:** Every hour, a learner reads new captures, runs deterministic detectors with evidence-threshold discipline, and emits strict-JSON directive proposals grounded in at least 3 separate sessions — without requiring an Anthropic API key by default and without being exploitable via prompt injection in captured tool output.
**Depends on:** Phase 1 (reads captures), Phase 2 (runs under scheduler)
**Requirements:** LEARN-01, LEARN-02, LEARN-03, LEARN-04, LEARN-05, LEARN-06, LEARN-07, LEARN-08
**Success Criteria** (what must be TRUE):
  1. Learner runs on its hourly tick, reads only captures created since the previous run, and emits directive proposals whose content is valid against a strict JSON schema (non-conforming model output is rejected and logged).
  2. Default learner invocation uses the user's existing `claude` CLI login with no Anthropic API key configured; an alternate model can be selected via `npx claude-sop config set model <name>` plus a user-supplied key.
  3. A directive is only proposed when at least 3 distinct sessions contain evidence of the same mistake pattern; single-instance findings are never surfaced.
  4. Captured tool output is wrapped in `<capture>` tags marked untrusted, and injected instructions inside captured content never influence the learner's directive output (verified by a fixture suite).
  5. `npx claude-sop learn-now --dry-run` prints proposed directives without writing; scheduled runs apply them. Runs exceeding 600s are killed and logged without blocking the next tick.
**Plans:** TBD

### Phase 4: ManagedSectionEditor
**Goal:** Directive proposals from the learner land inside the CLAUDE.md managed section through an atomic, hash-checked, git-aware writer that is impossible to use as a user-edit-clobbering footgun — and that the user can always revert.
**Depends on:** Phase 3 (consumes learner proposals)
**Requirements:** MD-01, MD-02, MD-03, MD-04, MD-05, MD-06, MD-07, MD-08
**Success Criteria** (what must be TRUE):
  1. After a learner run, new directives appear only between `<!-- claude-sop:begin -->` and `<!-- claude-sop:end -->`; all content outside the markers is byte-identical to before the run (verified by a golden-file suite).
  2. Each directive has a timestamp, a plain-language rule, and an evidence pointer back to source capture IDs; duplicates against existing managed content are skipped; the section is capped at the configured max (default ~25) with TTL pruning.
  3. Writes are atomic (temp-file + rename) — no intermediate state is ever observable; if the pre-write hash of the managed section differs from the last-known hash, the run is aborted, the user's edits are backed up to `~/.claude/sop/<pid>/managed-history/conflict-<ts>.md`, and the skip is surfaced in `status`.
  4. Writes are silently skipped during an active `git rebase` or `git merge`, never corrupting conflict markers.
  5. `npx claude-sop revert` rolls back the most recent managed-section change from backup and the change is reflected in `status`.
**Plans:** TBD

### Phase 5: Inspection CLI + Packaging Hardening
**Goal:** Users can inspect captured turns from the CLI, and the package is ready for `npm publish` with provenance, type-correctness, and a Claude Code version matrix proving the happy path end-to-end.
**Depends on:** Phases 1–4 (ships the complete product)
**Requirements:** CLI-02, CLI-03
**Success Criteria** (what must be TRUE):
  1. `npx claude-sop recent [--since 1h]` lists recent captured turns with session/turn id, agent, timestamp, and changed files.
  2. `npx claude-sop show <session-or-turn-id>` prints the full contents of the requested capture (prompt, response, tool-calls) with scrubbed content.
  3. Package publishes with `--provenance`; `publint` and `@arethetypeswrong/cli` pass in CI; dual ESM+CJS entry points resolve correctly in both module systems.
  4. End-to-end smoke test passes against a matrix of supported Claude Code versions: install → run a scripted session → verify captures → trigger learner → verify managed-section update → uninstall clean.
  5. A "looks-done-but-isn't" release checklist (≥20 items: no postinstall, no network egress, hook latency budget, scrubber recall, idempotency, reboot survival, etc.) is enforced in CI before a tag can be published.
**Plans:** TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Distribution Decision + Foundations | 0/0 | Not started | - |
| 1. Capture Foundation | 0/0 | Not started | - |
| 2. Installer + Scheduler + CLI Skeleton | 0/0 | Not started | - |
| 3. Learner | 0/0 | Not started | - |
| 4. ManagedSectionEditor | 0/0 | Not started | - |
| 5. Inspection CLI + Packaging Hardening | 0/0 | Not started | - |

## Coverage Validation

- v1 requirements total: 51
- Mapped: 51
- Orphans: 0
- Duplicates: 0

| Phase | Requirement Count | IDs |
|---|---|---|
| 0 | 6 | INST-07, INST-08, PRIV-01, PRIV-02, PRIV-03, PRIV-05 |
| 1 | 12 | CAPT-01..10, PRIV-04, PRIV-07 |
| 2 | 16 | INST-01..06, SCHED-01..05, PRIV-06, CLI-01, CLI-04, CLI-05, CLI-06 |
| 3 | 8 | LEARN-01..08 |
| 4 | 8 | MD-01..08 |
| 5 | 2 | CLI-02, CLI-03 |

---
*Roadmap created: 2026-04-13*

# Project Research Summary

**Project:** claude-sop
**Domain:** Claude Code extension — local-first hook-based I/O capture + hourly self-improving CLAUDE.md learner
**Researched:** 2026-04-13
**Confidence:** MEDIUM-HIGH

---

## Executive Summary

claude-sop sits in unclaimed territory. Every observability competitor (Langfuse, Helicone, LangSmith, Braintrust) is cloud-first, team-oriented, and SDK-coupled; every CLAUDE.md management tool is a passive editor. Nobody closes the loop — "observe what the agent did wrong, then auto-amend the agent's own instructions." That loop is the whole product, and research supports building it as a solo-dev, local-first, zero-network, filesystem-only tool on top of Claude Code's native hooks.

Recommended shape: TypeScript package built with `tsup` (dual ESM+CJS), `commander@14` CLI, `execa@9` for spawning `claude`, `proper-lockfile` for CLAUDE.md RMW, `nanoid@5` for capture IDs, `vitest` + `memfs`, custom layered secret scrubber running BEFORE anything hits disk, launchd plist / systemd user unit written directly (NO node-cron). The learner is deliberately unambitious in v1: 6 deterministic rule-based detectors, evidence threshold N=3, dry-run by default, fenced managed block in CLAUDE.md.

The dominant risks are not technical difficulty — they are trust-destruction events: a leaked secret, a hook stalling the agent loop, the learner fabricating directives, or the CLAUDE.md writer clobbering user edits. Each has a named prevention pattern in PITFALLS.md that must ship in v0.1.

---

## 🚨 CRITICAL OPEN DECISION — Distribution Model

**STACK.md and PITFALLS.md recommend opposite distribution shapes. Must resolve before any code.**

| Angle | STACK.md says | PITFALLS.md says |
|---|---|---|
| **Shape** | Standalone npm package (`npx claude-sop install`) | Claude Code plugin (`hooks/hooks.json`) |
| **Why** | Plugins cannot run install-time code, cannot register OS schedulers, cannot be invoked via `npx`. Hourly learner must run when no CC session is active. | Patching `~/.claude/settings.json` is fragile: stomps user config, destroys ordering, duplicates entries on reinstall. Plugins avoid merge-conflict category entirely. Plugins also get `${CLAUDE_PLUGIN_DATA}`. |

### Likely resolution: HYBRID

An npm-distributed CLI (`npx claude-sop install`) that at install time:
1. Copies a Claude Code plugin bundle into the user's plugins directory (hooks live in `hooks/hooks.json`, NOT in `settings.json`)
2. Registers an OS launchd/systemd scheduler (which plugins alone cannot do)
3. Ensures a CLAUDE.md managed block exists

**Unresolved sub-questions for discuss-phase:**
1. Where does the plugin bundle live on disk? Marketplace or sideload?
2. Does CC auto-load plugins placed in a known user dir?
3. How does uninstall reliably remove BOTH plugin bundle AND scheduler?
4. How does scheduler locate the plugin's learner entrypoint after a plugin update wipes `${CLAUDE_PLUGIN_ROOT}`?

---

## Key Findings

### Recommended Stack

TypeScript ^5.6 + tsup ^8.5 → dual ESM+CJS, Node ≥18.17, publish as `claude-sop` on npm.

**Core:**
- `commander@14` — CLI (~40KB, sync parsing)
- `execa@9` — spawn `claude` binary
- `nanoid@5` — 8-char filesystem-safe IDs
- `proper-lockfile@4` — cross-process mutex
- `zod@3` — hook JSON validation
- `vitest@4` + `memfs` — tests
- `picocolors`, `fast-glob`, `p-queue` — utilities
- **Secret scrubber:** custom layered engine (secretlint as pattern source, not runtime)
- **Scheduler:** launchd plist / systemd user unit authored directly (NOT node-cron/bree/agenda)

**Explicitly rejected:** jest, ts-node, chalk, uuid, remark/unified, inquirer, dotenv, Bun, `postinstall` scripts, node-windows.

### Expected Features

**Table stakes (must have):**
- 7 hook events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`
- Append-only JSONL with schema versioning, pre-persistence redaction, 0600 perms
- Idempotent install/uninstall
- Hourly learner via launchd/systemd (runs when no CC session is active)
- Fenced, diffable, revertible CLAUDE.md managed block
- Dry-run + `pause` kill switch + `purge`
- `status`, `recent`, `show <session>`, `errors`
- Non-blocking hooks (<20ms budget), fail-open on every error
- 100% local, zero network egress

**Differentiators:**
- Auto-learning loop writing to CLAUDE.md (no competitor does this)
- Lesson provenance links back to source captures
- Deterministic rule-based detectors (not LLM-as-judge) for v1
- Optional LLM-assisted rule phrasing via local `claude` CLI

**Explicit anti-features:** cloud sync, team dashboards, web UI, cost tracking, A/B experiments, eval datasets, semantic search, auto-editing files other than CLAUDE.md, LLM-as-judge, Windows, multi-model capture.

### Architecture Approach

12 components in 6 tiers. **Single turn is the atomic unit**: turns become visible to Indexer only after `Stop`/`SubagentStop`. Favor atomic rename + append-only logs + directory markers over locks; locks only around learner runs and CLAUDE.md writes.

Major components: CLI, Installer, HookShim (<50ms, double-forks writer), CaptureWriter, Scrubber, CaptureStore, Indexer, LearnerRunner, ManagedSectionEditor, SchedulerMgr, PathResolver, Config.

**Storage:** project-primary (`<proj>/.claude-sop/captures/`), global-secondary (`~/.claude/sop/<project-id>/` for state, backups, pointers).

### Critical Pitfalls (top 8)

1. **Sync hooks block agent loop** → `"async": true`, hook exit <20ms, no shell-out. Phase 1.
2. **Secret leakage before scrubbing** → scrub-on-write, layered (path + regex + kv + Shannon entropy), fail closed, `chmod 700`, >95% recall in CI. Phase 1 gate.
3. **Hook errors crash sessions** → ERR trap → exit 0 always, absolute binary paths, `claude-sop disable` panic button. Phase 1.
4. **Learner hallucinates directives** → evidence threshold N=3, contradiction check, strict JSON schema, dry-run default, directive cap ~25. Phase 3 gate.
5. **CLAUDE.md corruption** → atomic rename, marker validation, hash-check, abort on divergence, skip during rebase/merge, golden-file suite. Phase 4.
6. **Scheduler zombies/unreliability** → explicit install (no postinstall), `StartInterval` not `StartCalendarInterval` (DST), `flock` overlap prevention, self-heal. Phase 2.
7. **Prompt injection via captured tool output** → `<capture>` tags marked untrusted, strict directive schema, allow-list rejecting shell metachars. Phase 3.
8. **Privacy leakage via backups** → store under `~/Library/Caches/` (Time Machine excluded), `$XDG_CACHE_HOME` on Linux, retention + size caps. Phase 1 + 5.

---

## Implications for Roadmap

### Hard constraints

1. Scrubber must work BEFORE first byte of capture hits disk → Phase 1 gating deliverable
2. Capture schema must be frozen BEFORE learner detectors are built → otherwise detectors get rewritten twice
3. Distribution decision must be resolved BEFORE Phase 1 begins → determines state location, installer wiring, test harness shape

### Suggested Phases (6)

**Phase 0 — Distribution decision + Foundations**
- Resolve plugin/standalone/hybrid; build PathResolver, Config, Scrubber (pure libs)
- Gate: Scrubber passes detect-secrets corpus at >95% recall
- Addresses: distribution open-decision, Pitfalls #2, #18

**Phase 1 — Capture foundation**
- CaptureStore, CaptureWriter, HookShim, Indexer
- Turn-directory schema with `.pending` markers; atomic JSONL; HookShim <20ms via double-fork; Indexer only surfaces finalized turns
- Pitfalls: #1, #2, #3, #8, #11, #18, #19
- Research flag: HIGH (verify CC hook payload shapes with zod at ingest)

**Phase 2 — Scheduler + Installer + CLI skeleton**
- SchedulerMgr, Installer, CLI
- First working `npx claude-sop install`
- launchd plist + systemd user unit + cron fallback; `install|uninstall|status|doctor|disable|pause`; idempotent hook wiring; `.gitignore` patching
- Pitfalls: #6, #16, #17, #22, #23
- Research flag: HIGH (launchd/systemd authoring empirical validation)

**Phase 3 — Learner (offline first, then real `claude` CLI)**
- 6 deterministic detectors: tool-error-repeat, read-before-edit, edit-revert-edit, hallucinated-path, same-bash-repeated, claimed-success-but-errored
- Evidence threshold N=3, contradiction checker, strict JSON schema, `CLAUDE_SOP_LEARNER=1` loop prevention, directive TTL, dry-run default, `proposals.md` workflow
- Pitfalls: #4, #7, #10, #12, #13

**Phase 4 — ManagedSectionEditor + end-to-end**
- Fenced block reader/writer with marker discipline, atomic rename, hash-check with user-edit abort, git-state awareness, backups, golden-file tests, `rebuild-claude-md` recovery
- Isolated phase because one bug = permanent trust loss
- Pitfalls: #5, #20

**Phase 5 — Packaging, distribution, hardening**
- `npm publish --provenance`, `publint` + `@arethetypeswrong/cli` CI gates, CC version matrix, NO postinstall side effects, docs, 20-item "looks done but isn't" checklist
- Pitfalls: #14, #15, #21

### Phase Ordering Rationale

- Phase 0 first — distribution model blocks everything; Scrubber is pure logic
- Capture before scheduler — schedulerless capture is still useful; reverse is not
- Scheduler + installer + CLI together — tightly coupled (CLI is installer's UX; doctor queries scheduler state)
- Learner offline before real CLI — mock-LLM iteration is deterministic and cheap
- ManagedSectionEditor as its own phase — completely different failure modes from learner reasoning; mixing hides testing gaps
- Packaging last — no value polishing the shell before contents work

### Research Flags

- Phase 0: verify plugin sideloading and `${CLAUDE_PLUGIN_DATA}` writability from detached scheduler
- Phase 1: re-check hook payload shapes (tool_use_id pairing, Stop vs SubagentStop dispatch)
- Phase 2: empirically verify `launchctl bootstrap gui/$UID`, systemd `Persistent=true` post-wake behavior
- Phase 3: post-dogfooding spike after ~1 week to refine detector list

---

## Confidence Assessment

| Area | Confidence | Notes |
|---|---|---|
| Stack | HIGH | Package versions verified against live npm registry; hooks schema verified against official docs |
| Features | MEDIUM-HIGH | Capture HIGH; learner feature set MEDIUM — no direct prior art |
| Architecture | MEDIUM-HIGH | Data flows HIGH (POSIX primitives); MEDIUM on exact scheduler unit authoring |
| Pitfalls | HIGH | Grounded in current CC hooks + plugins reference |

**Overall:** MEDIUM-HIGH with one CRITICAL open decision (distribution model).

### Gaps

- Distribution model (the big one) — resolve in discuss phase
- `${CLAUDE_PLUGIN_ROOT}` wipe semantics on plugin update
- `claude -p --output-format json` exact shape — Phase 3 spike
- Lesson decay tracking — needs weeks of longitudinal data, deferred v1.x
- Detector set finalization — dogfooding-driven after 1 week
- Subagent nesting 2+ deep — Phase 1 spike

---

## Sources

**Primary (HIGH):** code.claude.com/docs/en/hooks, code.claude.com/docs/en/plugins, code.claude.com/docs/en/settings, npm registry (all verified 2026-04-13)

**Secondary (MEDIUM):** Langfuse/Helicone/LangSmith/Braintrust comparisons, disler/claude-code-hooks-multi-agent-observability, Reflexion (arXiv 2303.11366), Voyager, ClaudeMDEditor, Vibe Rules, detect-secrets corpus, Time Machine xattr, systemd enable-linger, syncthing/rclone unit patterns

**Tertiary (LOW):** lesson decay feasibility (extrapolated), `launchctl bootstrap` macOS 12+ syntax (needs empirical validation), plugin version-compat signaling (no convention)

---

*Research completed: 2026-04-13*
*Ready for roadmap: YES — pending Phase 0 distribution-model decision*

# Roadmap: claude-sop

**Created:** 2026-04-13
**Last updated:** 2026-04-17
**Depth:** standard
**Phases:** 8 (Phase 7 added for smart directive targeting)
**Coverage:** 61/61 v1 requirements mapped

## Phases

- [x] **Phase 0: Distribution Decision + Foundations** — Resolve hybrid distribution model, build pure-logic foundations (PathResolver, Config, Scrubber). _(v1 — shipped 2026-04-13)_
- [x] **Phase 1: Capture Foundation** — Hook shim, capture writer, turn-directory store. <50ms hook latency, fail-open. _(v2 — shipped 2026-04-13, hardened v4-v8)_
- [x] **Phase 2: Installer + Scheduler + CLI Skeleton** — `npx claude-sop install`, hourly launchd/systemd, status/doctor/pause CLI. _(v3 — shipped 2026-04-13, hotfixes v4-v8, launchd reliability v12)_
- [~] **Phase 3: Learner (Offline then `claude` CLI)** — Rule-based detectors (N≥3 evidence) + LLM-driven directive generation via `claude -p`. _(v9 MVP batch, v13 detectors+schema+injection, v14 LLM default ON → 85% done. Remaining: I6 hard-kill, I7 learn-now verb → v17)_
- [~] **Phase 4: ManagedSectionEditor** — Atomic, hash-checked, git-aware CLAUDE.md writer, never clobbers user edits, revertible. _(v10+v11 light editor + statusline, v16 hardening in progress — E1-E7 → Phase 4 completes with v16)_
- [ ] **Phase 5: Inspection CLI + Packaging Hardening** — `recent`/`show` verbs + npm publish --provenance + publint + attw + CC version matrix + docs + "looks-done" checklist. _(→ v17-v18)_
- [ ] **Phase 6: SaaS Platform + Monetization** — Clerk auth + Supabase + Stripe + Vercel dashboard. **Separate repo `claude-sop-cloud/`.** CLI gains thin sync module. _(→ v19-v23)_
- [ ] **Phase 7: Smart Directive Targeting** — Scope-aware directive placement: universal rules → CLAUDE.md (steering), context-specific → Claude Code Skills (on-demand). Prevents context bloat at scale. _(→ v24-v26, after 1-2 months of dogfood identifies real pollution patterns)_

### Key discovery: Recall gate NOT needed
Claude Code natively reads `<project>/CLAUDE.md` into system context at session start. Directives written by the learner to the managed section are automatically visible to Claude in the next session. No separate recall-gate binary or UserPromptSubmit hook injection is required. This eliminates the R1 backlog item and simplifies the Phase 3→4 bridge.

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
**Requirements:** INST-01, INST-02, INST-03, INST-04, INST-05, INST-06, SCHED-01, SCHED-02, SCHED-03, SCHED-04, SCHED-05, PRIV-06, CLI-01, CLI-04, CLI-05, CLI-06, LIC-01, LIC-02
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

### Phase 6: SaaS Platform + Monetization (REVISED 2026-04-17)
**Goal:** Turn the plugin into a commercial SaaS freemium product with a web dashboard, encrypted cloud sync, and subscription billing — while keeping all LLM analysis LOCAL (free via Claude Max).

**Stack decision (confirmed):**
- **Auth:** Clerk (JWT, <10K MAU free tier)
- **DB + API:** Supabase (Postgres + RLS + Edge Functions)
- **Billing:** Stripe (existing account, Checkout + Customer Portal)
- **Frontend:** Next.js on Vercel (free hobby tier)
- **Encryption:** Client-side AES-256, key derived from Clerk user_id + project_id (server never sees plaintext)

**Business model (confirmed):**
- **Free tier (15 days):** Full local + full dashboard access. After 15 days: dashboard read-only (shows stale data, nudges to subscribe), local CLAUDE.md continues working forever.
- **Paid tier:** Live dashboard sync, cross-project analytics, directive history/trends, team sharing.
- **Key insight:** LLM analysis stays local ($0 provider cost). Server only stores directives + stats. Revenue = dashboard visibility + management.

**Cloud data policy (confirmed):**
- Directives + recap summary sync to cloud (JSON, ~50 KB/project/month)
- Raw captures NEVER leave the machine (privacy)
- Client-side encryption: AES-256, key = hash(clerk_user_id + project_id). Server stores encrypted blobs only.

**Architecture:**
```
LOCAL (free forever):
  hooks → capture → learner → claude -p ($0) → directives → CLAUDE.md
  ↓ (encrypted JSON, directives + stats only)
CLOUD (15 days free → paid):
  Clerk auth → Supabase DB → Dashboard (Next.js/Vercel)
  Stripe billing → subscription gate on dashboard API
```

**Depends on:** Phase 5 (publishable package)
**Requirements:** LIC-03..10 (revised to match new stack)

**Repository structure (decided 2026-04-17):**
SaaS work lives in a **SEPARATE repository/directory**, NOT this project.

- `~/Developer/claude-sop/` — **THIS repo.** The CLI plugin, learner, capture pipeline, CLAUDE.md editor. Open-source/semi-OSS friendly, runs locally.
- `~/Developer/claude-sop-cloud/` — **NEW repo.** Backend API (Supabase Edge Functions), frontend dashboard (Next.js), billing webhooks. Private, monetization layer.

The CLI in this repo gains a thin `sync` module that talks to the cloud repo's public API. The two repos version and deploy independently.

**Planned versions:**
  - v19: `claude-sop-cloud/` repo bootstrap — Supabase schema + Clerk auth + Stripe billing scaffolding. No CLI integration yet.
  - v20: CLI `sync` module (THIS repo) — local directives → AES-256 encrypt → POST to cloud API.
  - v21: Dashboard frontend in `claude-sop-cloud/` — Next.js + Vercel, cross-project view.
  - v22: CLI `login`/`logout` verbs (THIS repo) — Clerk browser popup auth, JWT stored in `secrets.enc`.
  - v23: Obfuscation + Node SEA binary (THIS repo) — optional, anti-piracy hardening.

**Success Criteria** (revised):
  1. User runs `claude-sop login` → browser popup → Clerk auth → JWT stored locally in `secrets.enc`.
  2. Every learner tick: directives + recap stats encrypted client-side (AES-256) and synced to Supabase via Edge Function. Sync failure is non-blocking (offline grace 7 days).
  3. Dashboard at `app.claude-sop.com` shows: all projects, active directives, directive history timeline, agent stats. Clerk auth required. Stripe subscription gates live data after 15-day trial.
  4. Trial countdown: 15 days from first `claude-sop login`. Expired trial → dashboard read-only (stale data), local CLAUDE.md continues working, `status` shows "trial expired — subscribe at <url>".
  5. `claude-sop status` shows subscription state (trial days remaining, active/expired, last sync time, offline grace). Stripe Customer Portal link for self-service billing.
  6. Encrypted sync: server stores AES-256 encrypted blobs only. Supabase RLS ensures user can only read own data. No PII in server logs.
**Plans:** TBD (v19-v23)

### Phase 7: Smart Directive Targeting
**Goal:** Prevent CLAUDE.md context bloat at scale by routing directives to the right surface — universal rules stay in CLAUDE.md (always in system prompt), context-specific rules become Claude Code Skills (on-demand, loaded only when relevant).

**Problem this solves:**
- CLAUDE.md is a "steering file" — loaded into EVERY Claude Code session's system prompt
- Directives accumulate over months (even with v16 TTL cap at 25)
- Narrow directives (e.g. "for hero carousel, use transform-only animations") waste context when user is editing backend code
- Dolu context prompt following'i zayıflatır (frontier model weakness)

**Solution:**
LLM classifier tags each proposal's scope:
- `universal` → CLAUDE.md managed section (current behavior)
- `skill:<skill_name>` → separate skill markdown file, invoked on-demand via Claude Code's Skill tool or slash command
- `file:<glob>` → context-specific, injected only when target files are in the conversation

**Planned versions:**
  - v24: Scope classification in directive schema (Zod extension) + LLM prompt update to request scope
  - v25: Skill file generation — write `~/.claude/skills/<project>-<skill>.md` per scope, update plugin manifest
  - v26: CLAUDE.md vs Skills split + migration tool for existing directives

**Depends on:** Phase 4 (hardened editor must exist), 1-2 months of real dogfood data to identify pollution patterns.

**Success Criteria:**
  1. LLM proposal includes `scope` field (universal | skill:<name> | file:<glob>), validated by Zod.
  2. `claude-sop recap --run` routes directives: universal → CLAUDE.md, skill-scoped → `~/.claude/skills/`, file-scoped → metadata for future file-aware injection.
  3. `CLAUDE.md` managed section stays compact (<15 directives typical) even for power users with months of history.
  4. Claude Code Skill files are invokable via `/claude-sop:<skill-name>` slash commands.
  5. Migration: existing CLAUDE.md directives (pre-v24) are analyzed and optionally split into skills by `claude-sop migrate-directives --classify`.
**Plans:** TBD (v24-v26)

_Credit for this design insight: İbrahim Işkın (2026-04-17). Ibrahim pointed out that steering files grow unbounded and that Claude Code's Skills mechanism is the right home for context-specific knowledge._

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Distribution Decision + Foundations | 1/1 | **COMPLETE** | v1 |
| 1. Capture Foundation | 1/1 | **COMPLETE** | v2, v4-v8 |
| 2. Installer + Scheduler + CLI | 2/2 | **COMPLETE** | v3, v4-v8, v12 |
| 3. Learner | 2/3 | **85% — LLM shipped, hard-kill + learn-now verb remain** | v9, v13, v14 done; I6+I7 → v17 |
| 4. ManagedSectionEditor | 1/2 | **In progress — hardening underway** | v10-v11 done; v16 E1-E7 in flight |
| 5. Inspection CLI + Packaging | 0/2 | Not started | v17, v18 |
| 6. SaaS Platform + Monetization | 0/5 | Not started (separate repo) | v19-v23 |
| 7. Smart Directive Targeting | 0/3 | Not started | v24-v26 |

## Execution History

| Version | Commit | What shipped |
|---------|--------|--------------|
| v1 | `e77b13f` | Phase 0: ADR, PathResolver, Config, Scrubber, recall gate corpus |
| v2 | `998335d` | Phase 1: hook shim, detached writer, turn directories, bidirectional subagent linking |
| v3 | `18d43a1` | Phase 2: installer, launchd scheduler, CLI skeleton |
| v4 | `b5a08ca` | Hotfix: CLI ESM bin + plugin bundle + smoke test |
| v5 | `ad5fbbb` | Hotfix: plugin bundle layout + learner stub |
| v6 | `a22c0e6` | Hotfix: shim shebang + marketplace schema + stub polarity + doctor logic |
| v7 | `3e8a5b5` | Hotfix: stage writer.cjs into plugin bundle + e2e capture smoke |
| v8 | `2700dde` | Hotfix: bundle ALL writer runtime deps + isolated e2e smoke |
| v9 | `aed0da7` | Phase 3 MVP: project registry, cursor, turn scanner, recap.log, recap verb |
| v10 | `e9b1b61` | Phase 4 light: ManagedSectionEditor, sample directive, statusline, test cleanup |
| v11 | `555fb39` | Hotfix: statusline parser reads real Claude Code settings.json structure |
| v12 | `84b180b` | Hotfix: launchd bootstrap + warmup kickstart + doctor effective check |
| v13 | `860434d` | Phase 3: first detectors — repeated bash failure + edit match fail + strict schema |
| v14 | _(in progress)_ | Phase 3: LLM-driven directive generation — claude -p default ON, $0 cost |
| v15 | _(queued)_ | Bug fix sprint — B1-B8 cleaned (legacy markers, flaky tests, import.meta, etc.) |

## Remaining Backlog (39 items — 8 bugs move to v15, I1-I4 done in v13)

### v14 (in progress) — LLM intelligence
- ~~**I1** First detector~~ ✅ shipped v13
- ~~**I2** Second detector~~ ✅ shipped v13
- ~~**I3** Strict JSON schema~~ ✅ shipped v13
- ~~**I4** Prompt injection resistance~~ ✅ shipped v13
- **I5** LLM-driven directive generation (`claude -p` default ON) — LEARN-01, LEARN-02 ← **v14 in progress**
- **I6** 600s hard kill on learner — LEARN-08
- **I7** `claude-sop learn-now --dry-run` verb — LEARN-07
- ~~R1 Recall gate~~ — **NOT NEEDED** (Claude Code reads CLAUDE.md natively)

### Editor hardening (v15) — Phase 4 completion
- **E1** Hash-checked write (abort on drift, conflict backup) — MD-03
- **E2** Git-aware (skip during rebase/merge) — MD-04
- **E3** `claude-sop revert` command — MD-05
- **E4** Duplicate directive detection — MD-06
- **E5** TTL pruning + max 25 directive cap — MD-07
- **E6** Evidence pointer per directive (source_capture_ids) — MD-02
- **E7** Golden-file test suite — MD-08

### Bug fix sprint (v16)
- **B1** Remove installer's legacy `<!-- claude-sop:begin -->` markers (conflicts with v10 markers)
- **B2** Smoke test flaky perf (500ms → 600-800ms limit)
- **B3** `import.meta` tsup CJS warning fix
- **B4** Idempotency: directive timestamp → last turn finalized_at (not wall-clock minute)
- **B5** Statusline: native stdin JSON parse from Claude Code
- **B6** dev-army cwd attribution (`DEV_ARMY_TARGET_PROJECT` env var)
- **B7** Rename `CLAUDE_SOP_LEARNER` env var (confusing dual meaning)

### Inspection CLI (v17) — Phase 5 partial
- **C1** `claude-sop recent [--since 1h]` — CLI-02
- **C2** `claude-sop show <id>` — CLI-03

### Packaging + launch (v18) — Phase 5 completion
- **P1** npm publish --provenance
- **P2** publint + @arethetypeswrong/cli CI gate
- **P3** Claude Code version matrix E2E test
- **P4** "Looks-done-but-isn't" checklist (>=20 items)
- **P5** Dual ESM+CJS entry point validation
- **P6** README polish + demo GIF/video

### SaaS / monetization (v19-v22) — Phase 6
- **S1** License API backend (external server, ed25519)
- **S2** License client (embedded pubkey verify)
- **S3** Trial countdown (14 days, tamper-resistant)
- **S4** Subscription gate
- **S5** Offline grace (7 days)
- **S6** Obfuscation pipeline
- **S7** Node SEA binary
- **S8** Pricing page + billing
- **S9** Website / landing page

### dev-army improvements (parallel)
- **D1** Commander default to dispatch-and-wait.sh
- **D2** dispatch-task.sh stderr fix → formal commit + review
- **D3** Agent-poll inbox watcher stability

### Smart Directive Targeting (v24-v26) — NEW Phase 7
- **SD1** Scope classification field in DirectiveProposal Zod schema
- **SD2** LLM prompt update — ask Claude to label each directive's scope
- **SD3** Skill file generator (`~/.claude/skills/<project>-<skill>.md`)
- **SD4** CLAUDE.md vs Skills routing in directive-builder
- **SD5** Migration tool: `claude-sop migrate-directives --classify` for existing CLAUDE.md directives

### Cross-cutting (parallel)
- **X1** Linux CI matrix (systemd + cron)
- **X2** Multi-project cross-project pattern detection
- **X3** User directive feedback (like/reject)
- **X4** ADR finalize (sideload vs marketplace)
- **X5** Plugin distribution → Claude Code marketplace
- **X6** I8 — LLM skip if turns_new=0 (avoid wasteful analysis on idle ticks)

## Coverage Validation

- v1 requirements total: 61
- Mapped: 61
- Orphans: 0
- Duplicates: 0

| Phase | Requirement Count | IDs |
|---|---|---|
| 0 | 6 | INST-07, INST-08, PRIV-01, PRIV-02, PRIV-03, PRIV-05 |
| 1 | 12 | CAPT-01..10, PRIV-04, PRIV-07 |
| 2 | 18 | INST-01..06, SCHED-01..05, PRIV-06, CLI-01, CLI-04, CLI-05, CLI-06, LIC-01, LIC-02 |
| 3 | 8 | LEARN-01..08 |
| 4 | 8 | MD-01..08 |
| 5 | 2 | CLI-02, CLI-03 |
| 6 | 8 | LIC-03..10 |

---
*Roadmap created: 2026-04-13*
*Last updated: 2026-04-16 — v12 shipped, backlog assembled, recall gate eliminated*

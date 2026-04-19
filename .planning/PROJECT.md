# auto-sop

> _(repo currently named `claude-sop`, renaming to `auto-sop` in v18 — see PLAN-v18)_

## What This Is

An **open-core developer tool** that makes Claude Code self-improving. The CLI is open source (Apache 2.0) and free forever for solo use; the optional cloud platform (`auto-sop-cloud`, separate repo) is a paid subscription that unlocks team features.

It captures every Claude Code agent and subagent interaction in a project (user prompts, assistant responses, subagent Task I/O, all tool calls with inputs and outputs), then uses an hourly background learner to detect recurring mistakes via deterministic detectors AND LLM analysis (free via the user's Claude Max subscription, no API key needed). Real, evidence-backed directives are appended to the project's `CLAUDE.md` inside a managed, hardened, drift-detecting, git-aware, revertible section.

Distribution: `npx auto-sop install` (npm CLI) AND a Claude Code Marketplace plugin entry. Same binary, two install paths.

## Core Value

**Claude Code never makes the same mistake twice** — captured turn history becomes enforced project rules automatically, with zero manual CLAUDE.md upkeep.

## Business Model — Open Core (decided 2026-04-19)

| Tier | What you get | Price | Gate |
|------|--------------|-------|------|
| **Free** (forever) | 1 project, unlimited directives, full local capture + LLM analysis, hourly scheduler, hardened CLAUDE.md editor, all CLI inspection verbs (recent/show/learn-now/revert) | $0 | 1-project soft cap |
| **Pro** | Unlimited projects, opt-in encrypted cloud sync, web dashboard with savings metrics, curated directive packs (framework/language), cross-project pattern detection, team sharing | $12/mo or $99/yr | None for these features |
| **Trial** | Full Pro for 14 days OR until first Pro feature touch (whichever comes first) | $0, **no credit card** | Triggered by attempting 2nd project, browsing packs, enabling cloud sync |

**Soft-gate UX (critical):** When trial ends, the user is NOT locked out and NOTHING is deleted. They simply cannot add NEW projects beyond their first one. Existing learnings keep working forever. This is the **Notion model** (free tier limits creation, never destroys existing value). Avoids the "value retracted" psychological backlash of traditional trial-then-paywall.

**Reference:** RTK AI (`rtk-ai.app`, `github.com/rtk-ai/rtk`) — exact same playbook, MIT/Apache CLI + paid cloud team analytics ($15/dev/mo). Proven model used by GitLab, Sentry, Grafana, Mattermost, Plausible, PostHog.

## Repository Structure

| Repo | License | Purpose |
|---|---|---|
| `auto-sop/auto-sop` (this repo, was `ugurgokdere/claude-sop`) | **Apache 2.0** | CLI, capture pipeline, learner, ManagedSectionEditor. Open source — adoption magnet. |
| `auto-sop/auto-sop-cloud` (v23, NEW, private) | Proprietary | Supabase + Clerk + Stripe + Next.js dashboard. Closed source — monetization layer. |

The two repos version and deploy independently. CLI gains a thin `sync` module in v24 that POSTs encrypted directive blobs to the cloud API. Cloud never sees raw captures.

## Requirements

### Validated (shipped + dogfood-confirmed)

- ✅ Captures fire on every Claude Code hook event with <50ms overhead (Phase 1)
- ✅ Secret scrubber redacts at >95% recall (Phase 0, audited)
- ✅ Hourly learner via launchd/systemd auto-bootstrapped at install (Phase 2 + v12)
- ✅ Rule-based detectors with N≥3 evidence threshold + Zod schema + `<capture untrusted>` injection resistance (v13)
- ✅ LLM-driven directive generation via `claude -p`, default ON, $0 cost via Claude Max (v14)
- ✅ ManagedSectionEditor: atomic, hash-checked, git-aware, revertible, TTL pruning, evidence pointers, golden-file tested (v16)
- ✅ Multi-project: project registry, per-project cursor, isolated capture/state/messages (v9)
- ✅ Inspection CLI: `recent`, `show`, `learn-now`, `revert` (v17)
- ✅ Directive preservation across uninstall/install (v17 I9)
- ✅ Real-world dogfood: 92+ turns analyzed, 6 actionable directives in production CLAUDE.md (wrbeautiful-shopify-theme)

### Active (in flight or planned)

**Publish readiness (v18):**
- [x] Rename to `auto-sop` (npm + repo + binary + envs + dirs, with claude-sop backward compat)
- [x] Apache 2.0 LICENSE
- [x] `.github/workflows/publish.yml` with `npm publish --provenance`
- [x] `release-check.sh` 28-item gate
- [x] `publint` + `@arethetypeswrong/cli` CI
- [ ] README rewrite + demo GIF + architecture diagram
- [x] Auto-bump version on every commit (fix v14-v17 drift)

**Native Windows (v20-v22):**
- [ ] Task Scheduler backend (`schtasks.exe`)
- [ ] `.cmd` shim wrappers
- [ ] NTFS ACL-based permissions
- [ ] Windows CI matrix
- [ ] LLM mode validated on Windows (`claude -p` works)

**Distribution & Packaging (v22-v23):**
- [ ] Node SEA single-executable binary (macOS arm64/x64, Linux x64)
- [ ] GitHub Release artifacts (attach binaries to `v*` tags)
- [ ] Homebrew tap (`auto-sop/homebrew-tap`) with formula pointing to GitHub Release binaries
- [ ] Homebrew-core PR (after tap is stable, requires review)
- [ ] launchd notification branding: `sh` → `auto-sop` (via SEA binary)

**SaaS launch (v23-v27):**
- [ ] `auto-sop-cloud/` repo bootstrap (Supabase + Clerk + Stripe)
- [ ] CLI `sync` module (encrypted directive push)
- [ ] Dashboard frontend (Next.js + Vercel)
- [ ] CLI `login`/`logout`/`account` verbs
- [ ] Obfuscation + Node SEA binary (cross-platform)
- [ ] **Freemium gate (F-series):**
  - [ ] F1 — 1-project enforcement on free tier
  - [ ] F2 — Trial state machine (started_at, triggered_by, ended_at)
  - [ ] F3 — Soft-gate UX ("add project blocked", existing keeps working)
  - [ ] F4 — Curated directive packs (Pro-only, framework/language)
  - [ ] F5 — Cross-project pattern detection (Pro-only)

**Smart Directive Targeting (v28-v30):**
- [ ] Scope classification (universal/skill/file)
- [ ] Skill file generation (`~/.claude/skills/<project>-<skill>.md`)
- [ ] Migration tool for existing CLAUDE.md directives

**Metrics & Social Proof (v31-v33) — NEW:**
- [ ] M1 — Directive-fire detection (UserPromptSubmit hook detects directive relevance)
- [ ] M2 — Token/time savings tracker (`claude -p` JSON output usage diff)
- [ ] M3 — "Errors prevented this month" counter (directive-prevented Bash failure detection)
- [ ] M4 — Landing page side-by-side demo (RTK-style: with vs without auto-sop)
- [ ] M5 — Dashboard widget (Pro): viral monthly savings graph
- [ ] M6 — `auto-sop stats` CLI verb (local metrics, no cloud needed)

### Out of Scope

- **Auto-fixing source code** — learner only writes to CLAUDE.md; agents apply directives on next run
- **Real-time mistake detection mid-session** — hourly batch is sufficient; mid-session value is marginal vs complexity
- **Multi-user team in v1** — Pro tier is per-seat individual; team features (shared dashboards, RBAC) are Phase 8+
- **Cross-project pattern detection on Free tier** — only ONE project in free, so impossible by definition; this becomes the natural Pro upsell
- **Sending raw captures to cloud** — Pro cloud sync is directive metadata only, encrypted client-side. Captures stay on the user's machine forever.
- **Auto-publishing v0.1.0 in v18** — pipeline ready but actual tag/publish waits until v22 (after Native Windows) so first public release is cross-platform from day one

## Context

- **Ecosystem:** Claude Code CLI with hooks system (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`) configured in project `.claude/settings.json`. Plugin packaging via Claude Code Marketplace.
- **Distribution:** npm registry (`auto-sop` package) → `npx auto-sop install`. Same npm tarball powers Claude Code Marketplace listing.
- **Privacy stance:** Zero telemetry by default. Free tier: zero network egress. Pro tier: opt-in encrypted sync (AES-256, key derived from Clerk user_id × project_id, server stores encrypted blobs only).
- **Learner auth model:** Free + Pro both default to `claude -p` using user's Claude Max subscription — $0 cost to operator. Optional API key for users who want a different model.
- **Why this exists:** Claude Code repeats the same mistakes across sessions. A fix made on Monday gets re-broken Wednesday. CLAUDE.md is the fix, but writing it manually has friction. This plugin closes the loop automatically.
- **Validation moment (2026-04-17):** First real LLM-generated directives appeared in CLAUDE.md after analyzing 59 dogfood turns. 6 directives, all actionable, evidence-backed, project-specific. Product promise demonstrably delivered.
- **Similar tools / inspiration:**
  - **RTK** (`rtk-ai.app`) — closest model match: open CLI + paid cloud, "compress CLI outputs for AI". $15/dev/mo, free for OSS. Side-by-side proof on landing page.
  - **Langfuse, Helicone, Braintrust** — AI observability, more general, none target Claude Code specifically and none write back corrective rules.
  - **GitLab, Sentry, Grafana, Mattermost, Plausible, PostHog** — open core monetization model proof points.

## Constraints

- **Tech stack:** Node.js ≥18.17 (plugin is an npm package). v22 adds native Windows; v1 is macOS + Linux.
- **Auth:** Learner default uses user's existing Claude Code CLI login — **no Anthropic API key required**. This is a non-negotiable adoption requirement.
- **Privacy:** Zero network egress in free tier. In Pro: opt-in only, encrypted client-side, raw captures NEVER sync.
- **Licensing:** CLI is Apache 2.0 (open). Pro tier uses Clerk JWT + Stripe subscription gate, NOT custom ed25519 (simpler, ecosystem-standard).
- **Compatibility:** Must coexist with existing `.claude/settings.json` hooks configured by user or other plugins — merge, don't clobber. Validated in Phase 2.
- **Scheduler:** No user-facing cron editing; plugin manages launchd/systemd/Task Scheduler unit transparently. Bootstrap + warmup kickstart on install (v12).
- **Distribution:** Single `npx auto-sop install` command does full setup; uninstall is equally clean and preserves directive history (v17 I9).
- **Performance:** Capture hooks must not add perceptible latency (<50ms hook overhead, audited via `bench-shim` CI).

## Key Decisions

| Decision | Rationale | Status |
|----------|-----------|--------|
| Capture via Claude Code hooks (settings.json) | Official, supported, no CLI wrapping required | ✅ shipped (Phase 1) |
| Dual storage (per-project + global aggregate) | Per-project travels with repo (gitignored); global enables cross-project learning (v22+) | ✅ shipped (Phase 1) |
| Hourly learner cadence | Batch is simpler than real-time; 1h balances freshness vs cost | ✅ shipped (Phase 2) |
| LLM via `claude -p` (Claude Max) by default | Zero API cost for operator; user already authenticated; $0 marginal cost per directive | ✅ shipped (v14) |
| Managed section markers in CLAUDE.md | Preserves user edits outside markers; hash-checked drift detection inside | ✅ shipped (v10, hardened v16) |
| Secret scrubbing on by default | Captured tool I/O will contain secrets; non-negotiable redaction | ✅ shipped (Phase 0, >95% recall) |
| npm package via `npx` | No global install needed; always runs latest | ✅ shipped (Phase 2) |
| **Open core model: CLI Apache 2.0 + Cloud closed proprietary** | Open CLI drives adoption, closed cloud monetizes. RTK-validated. | 🟨 v18 (license file) + v23 (cloud repo) |
| **Freemium with 1-project soft cap (Notion-style)** | Avoids "value retracted" trap of trial-then-paywall; respects existing learnings | 🟨 planned v23-v27 |
| **No credit card on trial** | Friction kills conversion at <$15 ARPU; trial is risk-free | 🟨 planned v23-v27 |
| **Trial triggered by Pro feature touch, not by install** | Engages users at moment of need; trial countdown means something | 🟨 planned v23-v27 |
| **Side-by-side proof metrics (RTK-style)** | "47 errors prevented this month" sells better than feature lists | 🟨 planned v31+ |
| Native Windows BEFORE SaaS launch | Selling subscription to Windows users then refusing CLI is unacceptable | 🟨 planned v20-v22 |
| macOS + Linux only for v1 dogfood | launchd/systemd ship first; Windows in Phase 6 | ✅ current state |
| ed25519 license server REMOVED | Replaced by Clerk JWT + Supabase RLS — simpler, ecosystem-standard | ✅ decided 2026-04-17 |
| 14-day trial REPLACED with feature-touch + 14-day | Better engagement model; user-driven not time-driven | ✅ decided 2026-04-19 |
| "Recall gate" REMOVED from scope | Claude Code natively reads CLAUDE.md → no UserPromptSubmit injection needed | ✅ discovered v13 dogfood |

## Current State Summary (2026-04-19)

- **7 of 8 planned phases shipped or in flight**
- **21 versions released** (v1-v21), version 0.0.21 in package.json
- **Phase 0-4 complete**, Phase 5 95% — v17 (CLI), v18 (publish), v19 (org migration), v20 (directive fix), v21 (templates + CI)
- **Phase 6 NEW** (Native Windows) — inserted before SaaS for moral/commercial reasons
- **Phase 9 NEW** (Metrics & Social Proof) — RTK-inspired, lansman öncesi kritik
- **2 active dogfood projects**: wrbeautiful-shopify-theme (92 turns, 6 LLM directives), sahibinden-scraper (16 turns)
- **Zero known production bugs** as of v20
- **1012+ unit tests** all green
- **Real LLM directives in production CLAUDE.md** since 2026-04-17

## Phase Map (current as of 2026-04-19)

```
Phase 0  Foundations                  ✅ shipped v1
Phase 1  Capture                      ✅ shipped v2 + v4-v8 hardening
Phase 2  Installer/Scheduler/CLI      ✅ shipped v3 + v12 launchd reliability
Phase 3  Learner                      ✅ 100% — v9, v13, v14, v17 (LLM + detectors + hard-kill + learn-now)
Phase 4  ManagedSectionEditor         ✅ 100% — v10, v11, v16 (hardened)
Phase 5  Inspection + Packaging       🟨 95% — v17 (CLI), v18 (publish), v19 (org), v20 (directive fix), v21 (templates + CI)
Phase 6  Native Windows (NEW)         ⬜ v20-v22, blocks SaaS
Phase 7  SaaS Platform                ⬜ v23-v27 (separate repo `auto-sop-cloud`)
Phase 8  Smart Directive Targeting    ⬜ v28-v30 (İbrahim's insight)
Phase 9  Metrics & Social Proof (NEW) ⬜ v31-v33 (RTK-style, lansman öncesi)
```

---
### Go Public Prep

- [x] GitHub community files (ISSUE_TEMPLATE, PR template, SECURITY.md, FUNDING.yml, CODEOWNERS)
- [x] CI stability (TypeScript strict mode fixes, flaky test retries, cross-platform test guards)
- [ ] README demo GIF + architecture diagram
- [ ] First npm publish (blocked on Windows support decision)

---
*Last updated: 2026-04-19 after v21 GitHub templates + CI fixes + PROJECT.md update*

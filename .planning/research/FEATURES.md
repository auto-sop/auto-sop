# Feature Research

**Domain:** Claude Code plugin — local-first agent I/O capture + self-improving CLAUDE.md learner
**Researched:** 2026-04-13
**Confidence:** MEDIUM-HIGH (capture/storage HIGH from Langfuse/Helicone/hooks docs; learner features MEDIUM — adapted from Reflexion/Voyager prior art; CLAUDE.md management MEDIUM from Cursor rules/Vibe Rules ecosystem)

## Scope Recap

claude-sop is a Claude Code plugin installed via npm that:
1. Captures every hook event (prompts, tool calls, responses, subagent I/O) to local append-only storage
2. Runs a background "learner" hourly that reads recent captures and auto-appends/edits CLAUDE.md with lessons learned to prevent repeated mistakes
3. Single-dev, local-first, privacy-first, no cloud, no DB server, macOS + Linux only

Everything below is filtered through that lens. Features that make sense for team SaaS observability (Langfuse, LangSmith) are intentionally excluded from table stakes unless they also matter for a solo dev inspecting their own history.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing these = plugin feels broken or useless. User will uninstall.

#### Capture (maps to Claude Code hook events)

| Feature | Why Expected | Complexity | Notes / Hook Mapping |
|---------|--------------|------------|----------------------|
| Capture user prompt text | Can't analyze mistakes without inputs | LOW | `UserPromptSubmit` |
| Capture final assistant response / turn end | Output is half the trace | LOW | `Stop` |
| Capture every tool call (name + input + output) | Tool failures are the #1 mistake signal | LOW-MED | `PreToolUse` + `PostToolUse`, pair by tool_use_id |
| Capture subagent lifecycle | Subagents fail silently; users need to see them | LOW | `SubagentStop` (Stop auto-converts for subagents) |
| Capture session boundaries | Needed for grouping and time-bounded analysis | LOW | `SessionStart`, `SessionEnd` |
| Timestamps (start + duration) on every event | Any trace viewer has them | LOW | Wall-clock ms from hook payload |
| Working directory / project scope tagging | User has multiple projects; captures must not cross-contaminate | LOW | Read `cwd` from hook JSON; per-project storage root |
| Tool error / exit status flag | The whole point is "learn from mistakes" | LOW | PostToolUse `tool_response` already has success/error |
| Non-blocking hook handlers (<50ms budget) | Slow hooks = laggy Claude Code = uninstall | MEDIUM | Hook writes to a fifo/append-only file; heavy work happens out-of-band |
| Graceful degradation if storage is unwritable | A broken plugin must not break Claude Code | LOW | Fail-open, never raise from a hook |

#### Storage / Indexing

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Append-only JSONL event log per session | Simplest durable format, no DB server, human-inspectable | LOW | One file per session under `~/.claude-sop/sessions/{project}/{session_id}.jsonl` |
| Per-project storage isolation | Users don't want project A's lessons polluting project B | LOW | Hash or slug of `cwd` as partition key |
| Session index file (sessionId → path, start, end, project) | `sop recent` needs O(1) listing without scanning all files | LOW | Small `sessions.index.jsonl` |
| Size / retention cap | Disk fills up; users expect a limit | LOW-MED | Configurable max bytes + age, rotate oldest |
| Schema versioning on every record | Format will evolve; must be forward-compatible | LOW | `v` field on each JSONL line |

*Note on databases:* Prior art (OpenClaw issue #7783) shows the canonical pattern is **JSONL as ground truth + optional SQLite cache built lazily for queries**. For v1, JSONL alone is enough. SQLite indexing is deferred to v1.x unless query latency becomes painful.

#### Learner

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Runs on a schedule (hourly) without user action | Core value prop — auto-learning | MEDIUM | launchd (macOS) / systemd user timer (Linux). Fallback: run opportunistically on `Stop` hook if lock file stale. |
| Only processes NEW events since last run | Idempotence + cost control | LOW | Watermark file storing last processed timestamp |
| Writes proposed lessons to CLAUDE.md in a **fenced, clearly-marked section** | User must be able to see/diff/revert | LOW | `<!-- SOP:BEGIN managed -->` ... `<!-- SOP:END managed -->`. Never touch outside these markers. |
| Never clobbers user-authored content | Trust is destroyed on first accidental overwrite | MEDIUM | Only edit inside sentinels; refuse if sentinels absent or file modified externally during run (hash check) |
| Dry-run / preview mode | Users will not trust auto-edits without it | LOW | `sop learn --dry-run` prints diff, doesn't write |
| Kill switch / pause | If learner goes rogue user needs an off button | LOW | `sop pause` writes a lockfile learner respects |

#### Install / Uninstall UX

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Single-command install | Ecosystem norm (husky, prettier) | LOW | `npx claude-sop init` registers hooks in `~/.claude/settings.json` |
| Idempotent install | Re-running must not duplicate hook entries | LOW | Detect existing sop hook entries by marker comment |
| Clean uninstall that removes hooks + (optionally) data | Users will try it and judge you on this | LOW | `npx claude-sop uninstall` unregisters hooks, prompts about data |
| Does not edit global config silently | Prior-art pain point (husky v4 criticism) | LOW | Print exactly what files will be edited, show diff, require confirm on first run |
| Works without `sudo` | This is a user-space tool | LOW | Install into `~/.claude/` and `~/.claude-sop/` only |

#### Status / Query UX

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| `sop status` | Is it on? is it capturing? when did learner last run? | LOW | Reads state files, prints one screen |
| `sop recent [N]` | Show last N sessions with duration, tool-call count, error count | LOW | Reads session index |
| `sop show <session>` | Inspect one trace | LOW | Pretty-prints JSONL |
| `sop tail` | Live stream while Claude Code runs | LOW-MED | `tail -f` on current session JSONL |
| `sop errors [--since 1h]` | Fast path to "what broke recently" | LOW | Filters JSONL by error flag |
| `/sop:status` slash command inside Claude Code | Discoverable from inside the tool itself | LOW | Ship as a slash command file in the plugin |

#### Privacy

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| 100% local, zero network egress by default | This is the whole sales pitch | LOW | No telemetry, no auto-update phone home |
| Redaction of common secrets before write | Env files, API keys, tokens regularly appear in prompts/outputs | MEDIUM | Regex pack for AWS keys, GH tokens, Anthropic keys, JWTs, `.env` style `KEY=value` lines. Run at write time. |
| User-configurable redaction patterns | Every user has something extra to hide | LOW | `~/.claude-sop/redact.yml` with additional regexes |
| `sop purge [--session X | --all | --older-than 7d]` | GDPR instinct even for local data | LOW | Deletes JSONL files and rebuilds index |
| File perms 0600 on all captures | Basic hygiene on shared machines | LOW | umask enforced at write |
| Redaction is pre-persistence (not post-query) | Once written, it leaks — redact before disk | LOW | Critical ordering note for implementation |

---

### Differentiators (Competitive Advantage)

These are what make claude-sop worth installing over "just use Langfuse locally."

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Zero-config hook registration for Claude Code** | Langfuse/Helicone require SDK wiring; claude-sop "just works" after `npx init` | LOW | Possible only because Claude Code has a native hooks system (21 lifecycle events as of 2026-03) |
| **Auto-learning loop writes CLAUDE.md** | None of Langfuse/Helicone/LangSmith/Braintrust close the loop back into the agent. They observe, they don't teach. | HIGH | The whole reason this project exists. See "Learner realism" below. |
| **Fenced, user-auditable CLAUDE.md edits** | Prior art (ClaudeMDEditor, Vibe Rules) just edits; we fence + diff + revert | MEDIUM | `sop revert` moves learner block to a backup and restores previous |
| **Lesson provenance linking** | Every auto-added rule links back to the session/event that inspired it | MEDIUM | `<!-- sop:source=session_abc#event_42 -->` next to each rule so user can verify |
| **Mistake taxonomy over raw logs** | Users don't want to grep JSONL; they want "here are the 3 recurring failure modes this week" | MEDIUM | Rule-based classifier (see below) generates buckets |
| **Local-first by construction** | "Privacy" in competitors means "we promise not to look." Here, bytes never leave the machine. | LOW | Enforced by not shipping any network code at all in v1 |
| **No DB dependency** | Competitors require Postgres/Clickhouse (Langfuse) or a proxy (Helicone). We require… nothing. | LOW | Pure filesystem |
| **Learner dry-run + opt-in apply** | First-run safety converts skeptics | LOW | Makes auto-editing CLAUDE.md politically acceptable |
| **Works offline entirely** | Devs on planes, in SCIFs, on air-gapped networks can still use it | LOW | Falls out for free from local-first |

#### Learner realism — what v1 can actually detect from logs alone

This is where research matters most. The Reflexion / Voyager literature shows self-refining agents work, **but only with execution feedback signals** (environment errors, test failures, compile errors). Pure "read the logs and intuit wisdom" is the fantasy zone. Grounded v1 categories:

| Mistake category | Detectable from logs alone? | How |
|------------------|----------------------------|-----|
| Tool called with wrong arg shape | YES (HIGH confidence) | PostToolUse returns a schema/validation error string |
| File edited then immediately re-edited to revert | YES | Pair consecutive Edit tool calls on same path with inverse diffs |
| Same bash command run repeatedly | YES | N-gram repeat detection on tool_input |
| Read-before-edit violations | YES | Edit on path not preceded by Read |
| Command failed with non-zero exit, retried unchanged | YES | Compare two consecutive failing PostToolUse on same input |
| Agent claimed success when tool errored | YES | Stop event text vs last PostToolUse error flag |
| Hallucinated file paths | YES | Read tool → "file not found" error |
| Forgot project convention (e.g., "we use pnpm not npm") | PARTIAL | Only if it caused a tool error; otherwise invisible |
| Wrote buggy logic that compiles but is wrong | NO — fantasy | Requires test execution; out of scope for log-only learner |
| Poor code style / architectural taste | NO — fantasy | Requires judgment; defer or use LLM-as-judge with user review |

**v1 learner rule:** Start with **deterministic rule-based detectors** for the YES rows. Emit candidate lessons as plain text. Optionally pass candidates through Claude Code itself (via a CLI call) to phrase them as CLAUDE.md rules. **Do NOT** attempt open-ended "LLM reads all logs and philosophizes."

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Deterministic mistake detectors (above table, YES rows) | Reliable, debuggable, no LLM cost | MEDIUM | ~6-10 detectors cover most daily pain |
| LLM-assisted rule phrasing (optional) | Turns raw detection into natural CLAUDE.md prose | LOW | Uses local Claude Code CLI, no extra auth |
| Dedupe: don't add a lesson if semantically-equivalent rule already in CLAUDE.md | Otherwise CLAUDE.md grows unboundedly | MEDIUM | Normalize + fuzzy match against existing managed block |
| Lesson decay / usefulness tracking | Old rules may be wrong; track if the rule prevented re-occurrence | HIGH | **Defer to v1.x** — needs longitudinal data |

---

### Anti-Features (Explicitly NOT Building in v1)

Each excluded with an explicit reason.

| Feature | Why Users Request It | Why We Refuse (v1) | Alternative |
|---------|---------------------|-------------------|-------------|
| **Cloud sync / hosted dashboard** | "I want to see my traces from another machine" | Destroys the local-first promise; adds auth, storage, billing, security surface; 10x project scope | Use `sop export` to tarball and copy yourself |
| **Team sharing / multi-user** | "My team wants the same learned rules" | Requires merge semantics on CLAUDE.md, identity, access control — an entirely different product | Check CLAUDE.md into git; team shares via git |
| **Web dashboard / TUI grid viewer** | Competitors have pretty UIs | v1 is CLI + JSONL; UIs are 3x the code and drift from the data | `sop show` pretty-prints; jq works on JSONL |
| **Cost / token tracking** | Observability tools all have it | Claude Code doesn't expose per-call token counts reliably via hooks; adds API-coupling; not the product's point | Out of scope; users who want this install Helicone |
| **A/B testing / prompt experiments** | Langfuse, Braintrust feature | Requires multiple prompt variants and ground truth; the plugin has no ground truth source | Braintrust/Langfuse do this better; don't compete |
| **Eval datasets / regression tests** | LangSmith core | Same — requires curated test sets; out of scope | Keep focused on passive capture + learning |
| **Semantic search over traces (embeddings)** | "Find sessions where I struggled with X" | Needs embedding model, vector index, ongoing compute. Deterministic grep + rule taxonomy covers 80% at 0% cost. | `sop errors`, `grep`, v1.x SQLite FTS |
| **Real-time streaming dashboard** | Cool demo | Solves a problem the solo dev doesn't have | `sop tail` |
| **Auto-editing files other than CLAUDE.md** | "Why not fix my code too?" | CLAUDE.md is reversible and human-readable; source code edits are not the learner's job | ARCHITECT-style agents do that separately |
| **LLM-as-judge across all traces** | "Grade my agent's work" | Expensive, subjective, and the quality-gate agents (YODA, ANALYZER) already cover this post-commit | Leave it to dedicated review agents |
| **Windows support** | "I use Windows" | Scope creep; hook path semantics, launchd/systemd not available | Document macOS + Linux only in v1; WSL works implicitly |
| **Multi-model support (GPT/Gemini captures)** | "I use other agents too" | Entire value chain is coupled to Claude Code hooks. Other CLIs have different event models. | Different product |
| **Automatic PR-style "here's a fix" generation** | "Just fix it for me" | Requires test execution + code understanding; crosses from observer to actor | ARCHITECT / COMMANDER already do this in dev-army |
| **Real-time blocking hook enforcement** | "Stop me from committing bad code" | Hooks that block degrade Claude Code responsiveness and anger users fast | Learner nudges CLAUDE.md, doesn't block |
| **Encrypted-at-rest storage** | "Paranoid security" | FileVault / LUKS already provide this; in-app crypto adds key management without real value on a personal machine | Rely on OS disk encryption; document the assumption |

---

## Feature Dependencies

```
CAPTURE LAYER
  Hook registration (install)
      └─requires─> JSONL writer
                      └─requires─> Per-project storage partitioning
                                       └─requires─> cwd from hook payload
  Redaction
      └─must-run-before─> JSONL writer  (ordering, not dep)

STORAGE LAYER
  Session index
      └─requires─> JSONL writer
  Retention / purge
      └─requires─> Session index

QUERY LAYER (sop CLI)
  sop status     ──requires──> state files (no JSONL read)
  sop recent     ──requires──> Session index
  sop show       ──requires──> JSONL writer format stable
  sop errors     ──requires──> error flag on PostToolUse captures
  sop tail       ──requires──> JSONL writer (append-only guarantee)

LEARNER LAYER
  Scheduler (launchd/systemd)
      └─requires─> state dir + lockfile
  Deterministic detectors
      └─requires─> Stable JSONL schema + error flags
  CLAUDE.md fenced edit
      └─requires─> Lesson dedupe
          └─requires─> Existing managed-block parser
  LLM-assisted rule phrasing (optional)
      └─requires─> Claude Code CLI present on PATH
  Dry-run / revert
      └─requires─> Backup of managed block before every write

INSTALL / UX
  npx claude-sop init
      └─requires─> Idempotent hook registration
      └─enables──> All of the above

CROSS-CUTTING
  Kill switch (sop pause)
      └─blocks──> Learner only (capture continues — capture is cheap + safe)
```

### Dependency Notes

- **Redaction must run before JSONL write, not after.** Once on disk it's leaked. This is an ordering invariant, not a feature dependency, but it's the highest-risk correctness constraint in the project.
- **Schema versioning enables everything downstream.** Without a `v` field on each record, any schema change breaks every historical query. Must ship in v1 day 1.
- **Learner requires stable capture schema.** Don't start on learner detectors until capture schema is frozen — otherwise detectors get rewritten twice.
- **CLAUDE.md fenced-edit requires dedupe.** Without dedupe the managed block grows monotonically forever and users will rip it out.
- **Install being idempotent gates everything.** A broken install UX kills adoption before any other feature is evaluated.

---

## MVP Definition

### Launch With (v1.0)

Absolute minimum to validate "auto-capture + auto-CLAUDE.md-learning is useful."

- [ ] `npx claude-sop init` — idempotent hook registration into `~/.claude/settings.json`
- [ ] `npx claude-sop uninstall` — clean removal
- [ ] Capture of `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`
- [ ] Append-only JSONL writer with schema version, per-project partitioning, 0600 perms
- [ ] Pre-persistence regex redaction for secrets (AWS/GH/Anthropic/JWT/`.env` patterns)
- [ ] Session index file + retention cap
- [ ] `sop status`, `sop recent`, `sop show <session>`, `sop errors`, `sop purge`
- [ ] `/sop:status` slash command
- [ ] Hourly learner via launchd (macOS) + systemd user timer (Linux)
- [ ] 4-6 deterministic mistake detectors: tool-error-repeat, read-before-edit-violation, edit-revert-edit, hallucinated-path, same-bash-repeated, claimed-success-but-errored
- [ ] Fenced CLAUDE.md managed-block writer with dedupe + hash-check safety
- [ ] `sop learn --dry-run` and `sop pause`
- [ ] Failure modes: every hook handler fails-open, never raises

### Add After Validation (v1.x)

- [ ] SQLite query cache built from JSONL (only if `sop` commands feel slow on real user data)
- [ ] LLM-assisted rule phrasing via Claude Code CLI (only if deterministic detectors feel too blunt)
- [ ] Lesson decay / usefulness tracking (needs weeks of data)
- [ ] `sop tail` live viewer
- [ ] User-configurable redaction pack (`~/.claude-sop/redact.yml`)
- [ ] `sop export <session> > file.tar.gz` for sharing with self on another machine
- [ ] Additional detectors based on real observed v1 mistakes (let data drive)

### Future Consideration (v2+)

- [ ] Multi-project aggregated learning (rules that apply across projects go to `~/.claude/CLAUDE.md` global)
- [ ] Optional SQLite FTS for semantic-ish search
- [ ] Pluggable detector API for users to write their own
- [ ] Possibly: opt-in, anonymous, aggregate-only "most common mistakes across all installs" telemetry — only if community asks for it repeatedly and trust is earned

---

## Feature Prioritization Matrix

| Feature | User Value | Impl Cost | Priority |
|---------|------------|-----------|----------|
| Hook capture of all 7 core events | HIGH | LOW | P1 |
| JSONL writer + redaction | HIGH | MEDIUM | P1 |
| Idempotent install/uninstall | HIGH | LOW | P1 |
| Fenced CLAUDE.md writer | HIGH | MEDIUM | P1 |
| Deterministic mistake detectors (v1 set) | HIGH | MEDIUM | P1 |
| Hourly scheduler | HIGH | MEDIUM | P1 |
| `sop status` / `recent` / `show` / `errors` | HIGH | LOW | P1 |
| Dry-run + pause + purge | HIGH | LOW | P1 |
| Per-project partitioning | HIGH | LOW | P1 |
| Schema versioning | MEDIUM (latent) | LOW | P1 |
| LLM-assisted rule phrasing | MEDIUM | LOW | P2 |
| `sop tail` | MEDIUM | LOW | P2 |
| SQLite cache | LOW (until data big) | MEDIUM | P2 |
| Custom redaction pack | MEDIUM | LOW | P2 |
| Lesson decay tracking | MEDIUM | HIGH | P3 |
| Pluggable detector SDK | LOW | HIGH | P3 |
| Cloud anything | LOW | HIGH | ANTI |
| Web dashboard | LOW | HIGH | ANTI |
| Cost tracking | LOW | MEDIUM | ANTI |

**Priority key:** P1 = launch blocker · P2 = v1.x · P3 = v2+ · ANTI = explicitly excluded

---

## Competitor Feature Analysis

| Feature | Langfuse | Helicone | LangSmith | Braintrust | ClaudeMDEditor / Vibe Rules | **claude-sop** |
|---------|----------|----------|-----------|------------|-----------------------------|----------------|
| Captures prompts+responses | YES (SDK) | YES (proxy) | YES (SDK, LC-coupled) | YES (SDK) | NO | YES (native hooks, zero SDK) |
| Captures tool calls | YES | PARTIAL | YES | YES | NO | YES (Pre+PostToolUse) |
| Cost / token tracking | YES | YES (core) | YES | YES | NO | NO (anti-feature) |
| Cloud dashboard | YES | YES | YES | YES | YES (web app) | NO (anti-feature) |
| Local-only mode | Self-host (Postgres) | Self-host (proxy) | NO | NO | NO (cloud app) | YES (filesystem only) |
| Redaction before persist | Optional | Optional | Optional | Optional | N/A | YES (default on) |
| Auto-learns and edits agent config | NO | NO | NO | NO | Manual edit UI only | **YES — unique** |
| Feedback loop to CLAUDE.md | NO | NO | NO | NO | Manual only | **YES — unique** |
| Claude Code native integration | NO | NO | NO | NO | Partial (file editor) | YES (hooks) |
| Requires DB | Postgres + Clickhouse | Redis + Postgres | Cloud | Cloud | Cloud | **None** |
| Install complexity | HIGH | MEDIUM | MEDIUM | MEDIUM | LOW | LOW (single `npx`) |

**Strategic read:** Every serious observability tool is built for teams/production and assumes cloud. Every CLAUDE.md-management tool is a passive editor. The niche "solo dev + local + auto-learning feedback loop into Claude Code" is empty. claude-sop does not compete with Langfuse — it occupies unclaimed space.

---

## Sources

- [Langfuse alternatives comparison 2026 - Braintrust](https://www.braintrust.dev/articles/langfuse-alternatives-2026)
- [7 best LLM tracing tools for multi-agent AI systems 2026 - Braintrust](https://www.braintrust.dev/articles/best-llm-tracing-tools-2026)
- [Complete Guide to LLM Observability Platforms - Helicone](https://www.helicone.ai/blog/the-complete-guide-to-LLM-observability-platforms)
- [Langfuse Observability Overview](https://langfuse.com/docs/observability/overview)
- [8 AI Observability Platforms Compared - Softcery](https://softcery.com/lab/top-8-observability-platforms-for-ai-agents-in-2025)
- [Claude Code Hooks reference (official)](https://code.claude.com/docs/en/hooks)
- [Claude Code Hooks Reference: All 12 Events 2026 - Pixelmojo](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Claude Code Hooks multi-agent observability - disler/GitHub](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- [Claude Code Hooks Complete Guide March 2026](https://smartscope.blog/en/generative-ai/claude/claude-code-hooks-guide/)
- [Reflexion: Language Agents with Verbal Reinforcement Learning (arXiv 2303.11366)](https://arxiv.org/pdf/2303.11366)
- [Voyager: Open-Ended Embodied Agent with LLMs](https://voyager.minedojo.org/)
- [Voyager-Style Skill Library for Agents - autogen issue #98](https://github.com/microsoft/autogen/issues/98)
- [Self-Reflection in LLM Agents (arXiv 2405.06682)](https://arxiv.org/pdf/2405.06682)
- [Complete Guide to AI Agent Memory Files: CLAUDE.md, AGENTS.md, and Beyond](https://medium.com/data-science-collective/the-complete-guide-to-ai-agent-memory-files-claude-md-agents-md-and-beyond-49ea0df5c5a9)
- [cursorrules vs CLAUDE.md vs Copilot Instructions](https://www.agentrulegen.com/guides/cursorrules-vs-claude-md)
- [Vibe Rules — Unify Your AI Agent Skills](https://viberules.app/en)
- [ClaudeMDEditor](https://www.claudemdeditor.com/)
- [LLM Logging Without PII: Observability Patterns - OptyxStack](https://optyxstack.com/security-compliance/llm-logging-without-pii-observability-patterns)
- [OpenClaw issue #7783 — JSONL → SQLite ingestion pattern](https://github.com/openclaw/openclaw/issues/7783)
- [Git Hooks with Husky and lint-staged: Complete 2025 Setup - dev.to](https://dev.to/_d7eb1c1703182e3ce1782/git-hooks-with-husky-and-lint-staged-the-complete-setup-guide-for-2025-53ji)
- [lint-staged on npm](https://www.npmjs.com/package/lint-staged)

### Confidence notes

- **HIGH** on competitor capture feature sets and Claude Code hook events — cross-verified across multiple sources and official docs.
- **HIGH** on learner detectability table YES rows — these are mechanical pattern matches on already-structured hook payloads.
- **MEDIUM** on CLAUDE.md auto-edit safety patterns — Vibe Rules and ClaudeMDEditor exist but neither publishes detailed conflict-resolution semantics; fenced-block approach is inferred from general code-generation tool practice.
- **MEDIUM** on learner scheduling approach — launchd/systemd user timers are standard but no direct prior art for "hourly CLAUDE.md learner" exists.
- **LOW** on lesson decay tracking feasibility — pure extrapolation from Reflexion's reward signals; flagged as deferred for a reason.

---
*Feature research for: claude-sop — local-first Claude Code capture & learner plugin*
*Researched: 2026-04-13*

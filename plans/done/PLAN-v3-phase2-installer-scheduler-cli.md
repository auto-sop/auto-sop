# Phase 2: Installer + Scheduler + CLI Skeleton — Commander Execution Plan

## Overview

Ships `npx claude-sop install` end-to-end: hooks wired non-destructively into `<project>/.claude/settings.json`, hourly OS scheduler registered (launchd / systemd user unit / cron fallback), `.claude-sop/` gitignored, empty `<!-- claude-sop:begin -->` / `<!-- claude-sop:end -->` markers in `CLAUDE.md`, encrypted `secrets.enc` with license API key + trial-start timestamp, and a working CLI (install, uninstall, status, doctor, pause, resume, purge, errors). Re-install is a no-op; uninstall is clean. Phase 2 does NOT run the learner (Phase 3), does NOT touch the managed-section content (Phase 4), and does NOT validate the license against a backend (Phase 6).

**This is the dogfood unlock.** After Phase 2 commits, the user can run `npx claude-sop install` inside `~/.claude/dev-army/<agent>/` and see captures flow + scheduler tick + status report real state.

## Architecture Decisions (from CONTEXT + RESEARCH)

- **G1 RESOLVED — plugin bundle ships at `dist/plugin/`** inside the npm package, copied to `~/.claude-sop/marketplace/claude-sop/` on install, registered via `extraKnownMarketplaces` in `~/.claude/settings.json`. **Mutual exclusion:** `npx install` writes project-local hooks ONLY and does NOT set `enabledPlugins`. Marketplace users install via `/plugin install` instead. No user gets both code paths.
- **G2 hook merge:** `jsonc-parser` edit-preserving merge into `<project>/.claude/settings.json`. claude-sop hooks tagged with `id: "claude-sop"` for idempotent re-install. User hooks first, claude-sop last.
- **G3 upgrade:** `~/.claude-sop/version.txt` + `semver` compare. Same version = no-op. Newer = in-place upgrade. Older = refuse with error.
- **G4 license:** Interactive prompt via `node:readline/promises`, test key `123` accepted explicitly. `--license <key>` flag for non-interactive. Stored encrypted via Phase 0 secrets.enc. Trial-start timestamp written once and preserved across re-install.
- **H1 scheduler:** `~/Library/LaunchAgents/com.claude-sop.learner.plist` (macOS, `launchctl bootstrap gui/$UID`); `~/.config/systemd/user/claude-sop-learner.{timer,service}` (Linux, `systemctl --user enable --now` + `loginctl enable-linger`).
- **H2 wrapper:** `~/.claude-sop/bin/tick.sh` is a thin POSIX `exec` into Node with absolute paths baked at install time. Sets `CLAUDE_SOP_LEARNER=1` (Phase 1 kill-switch).
- **H3 cron fallback:** Detected via `systemctl --user is-system-running` probe (2s timeout). Cron entry tagged with `# claude-sop:managed` markers for safe removal. Install does NOT abort; prints yellow warning.
- **H4 locking:** macOS has NO `flock(1)`. Per-project lock via `proper-lockfile` in Node, NOT shell. `tick.sh` does no locking.
- **I1 flat verbs.** I2 human default + global `--json` flag. I3 status fields per CONTEXT. I4 rich exit codes 0 (ok) / 1 (generic) / 2 (misuse) / 3 (precondition).
- **J1 default uninstall preserves captures; `--purge` wipes everything.** J2 managed-section backup to `~/.claude/sop/<hash12>/managed-history/uninstall-<ts>.md` before strip. J3 best-effort with summary. J4 deletes `secrets.enc` on uninstall.
- **New deps to add:** `jsonc-parser`, `picocolors`, `semver`. Everything else (`commander`, `execa`, `zod`, `proper-lockfile`, `yaml`) already in package.json.
- **main.ts frozen after 02-01.** Wave 2 plans use `src/cli/verbs/index.ts` thin barrel — each adds 1 import + 1 register line at sentinel comments. No collisions.
- **Idempotent install order:** `version.txt` is written LAST so partial installs are re-runnable.
- **Zero-network test mandate:** all tests use Phase 0 stub harness; scheduler tests mock `execa` (no real launchctl/systemctl/crontab in CI).

## Implementation Tasks

### Wave 1 — Foundations (4 plans, fully parallel)

**1. ARCHITECT: Plan 02-01 — Deps + atomic write + CLI skeleton (FREEZES main.ts)**
Ref: `.planning/phases/02-installer-scheduler-cli/02-01-PLAN.md`
Files: `src/atomic/`, `src/cli/exit-codes.ts`, `src/cli/errors.ts`, `src/cli/prompt.ts`, `src/cli/output/`, `src/cli/verbs/index.ts` (with `@@VERBS_IMPORTS@@` and `@@VERBS_REGISTER@@` sentinels), `src/cli/main.ts` (FROZEN after this plan), `src/cli.ts`, `package.json` (adds jsonc-parser, picocolors, semver)
Requirements: commander@14 root with `--json` global flag, exit code mapper (0/1/2/3), human + JSON output helpers via picocolors, atomic write (temp + fsync + rename), verbs barrel infrastructure.
Acceptance: `npx claude-sop --help` runs; verbs barrel sentinels in place; main.ts has `// FROZEN after plan 02-01` stamp; no Wave 2 plan touches it.

**2. ARCHITECT: Plan 02-02 — Installer libraries**
Ref: `.planning/phases/02-installer-scheduler-cli/02-02-PLAN.md`
Files: `src/installer/{hook-entries,merge-settings,marketplace-register,version,managed-section,gitignore,index}.ts`
Requirements: jsonc-parser-based merge into `<project>/.claude/settings.json` preserving comments + user hooks order; hook entries tagged `id: "claude-sop"` for idempotency; `extraKnownMarketplaces` registration in `~/.claude/settings.json` (mutual-exclusion: NOT `enabledPlugins`); `version.txt` semver compare; managed-section create/strip with byte-exact preservation outside markers; `.gitignore` append for `.claude-sop/`.
Acceptance: All libraries unit-testable in isolation against fixture settings.json files.

**3. ARCHITECT: Plan 02-03 — Scheduler layer**
Ref: `.planning/phases/02-installer-scheduler-cli/02-03-PLAN.md`
Files: `src/scheduler/{types,detect,tick-wrapper,macos-launchd,linux-systemd,linux-cron,index}.ts`
Requirements: Platform detect via `systemctl --user is-system-running` (2s timeout, 'running|degraded|starting|initializing|maintenance' regex); launchd plist, systemd timer+service, cron entry templates from RESEARCH.md verbatim; tick.sh renderer with absolute paths baked in + `CLAUDE_SOP_LEARNER=1`; dispatcher selecting backend; **no `flock` in tick.sh** (asserted in tests). All execa calls mocked in unit tests.
Acceptance: All three backends render correct unit/plist/cron text against fixtures; dispatcher picks correct backend per platform.

**4. ARCHITECT: Plan 02-04 — License storage**
Ref: `.planning/phases/02-installer-scheduler-cli/02-04-PLAN.md`
Files: `src/license/{schema,storage,trial,index}.ts`
Requirements: Extends Phase 0 secrets.enc with zod schema v1 (license.kind, license.key, trial.started_at). Storage layer preserves trial.started_at across re-install (LIC-02 critical). Trial countdown classifier returns `dev-key | trial(N days) | expired`.
Acceptance: Re-install preserves original trial timestamp byte-exact; test key `123` round-trips.

### Wave 2 — CLI verbs (4 plans, parallel via verbs/index.ts barrel)

**5. ARCHITECT: Plan 02-05 — `install` verb + plugin bundle copier**
Ref: `.planning/phases/02-installer-scheduler-cli/02-05-PLAN.md`
Files: `src/cli/verbs/install.ts`, `src/installer/{plugin-bundle,orchestrator}.ts` + ONE LINE re-register at `verbs/index.ts` sentinels
Requirements: 9-step orchestrator with `version.txt` written LAST (idempotent re-runnability). Steps: probe install lock → ensure ~/.claude-sop dirs → copy `dist/plugin/` → `~/.claude-sop/marketplace/claude-sop/` (recursive `fs.cp`) → register `extraKnownMarketplaces` → write project-local hooks via merge → write tick.sh → register scheduler → ensure managed-section markers → ensure .gitignore → write secrets.enc with license + trial-start → write version.txt. Install lock via `proper-lockfile`. **main.ts NEVER touched.**
Acceptance: install verb dispatches, all 9 steps run in correct order, idempotent re-run is a no-op.

**6. ARCHITECT: Plan 02-06 — `uninstall` + `purge` verbs**
Ref: `.planning/phases/02-installer-scheduler-cli/02-06-PLAN.md`
Files: `src/cli/verbs/{uninstall,purge}.ts`, `src/installer/uninstall-orchestrator.ts` + TWO LINES at verbs/index.ts sentinels
Requirements: Best-effort orchestrator: bootout scheduler unit, strip managed-section markers (with byte-exact backup to `~/.claude/sop/<hash12>/managed-history/uninstall-<ts>.md` BEFORE strip), remove project hooks by `id: "claude-sop"`, remove tick.sh + plugin bundle copy, delete `secrets.enc`, delete `version.txt`. Default preserves captures. `--purge` wipes captures + global per-project dir + secrets.enc. Errors collected into summary; exit 0 if zero failures, 1 otherwise.
Acceptance: e2e uninstall leaves byte-identical CLAUDE.md outside markers; --purge wipes everything; partial-failure scenarios produce summary not crash.

**7. ARCHITECT: Plan 02-07 — `status` + `doctor` verbs**
Ref: `.planning/phases/02-installer-scheduler-cli/02-07-PLAN.md`
Files: `src/cli/verbs/{status,doctor}.ts`, `src/status/collector.ts` + TWO LINES at verbs/index.ts sentinels
Requirements: status collector returns all I3 fields (project id+slug+path, hook wiring state, scheduler state, last learner run, pending capture count, directive count, license state, last-24h error count, disk usage). Stable JSON schema for `--json`. Human output is colorized table via picocolors. doctor runs full health check + tails last 10 error lines + exits 3 on precondition failure.
Acceptance: status against fixture install reports correct state; doctor exit codes correct.

**8. ARCHITECT: Plan 02-08 — `pause` / `resume` / `errors` verbs**
Ref: `.planning/phases/02-installer-scheduler-cli/02-08-PLAN.md`
Files: `src/cli/verbs/{pause,resume,errors}.ts` + THREE LINES at verbs/index.ts sentinels
Requirements: pause/resume flip `<project>/.claude-sop/paused.flag`. errors verb tails project + global errors.jsonl with `--tail`, `--since`, `--global` flags.
Acceptance: pause/resume round-trip works; errors prints last N lines with filtering.

### Wave 3 — End-to-end integration

**9. ARCHITECT: Plan 02-09 — End-to-end integration suite**
Ref: `.planning/phases/02-installer-scheduler-cli/02-09-PLAN.md`
Files: `test/integration/phase2-e2e.test.ts`, `test/integration/helpers.ts`, `test/integration/fixtures/plugin-bundle/`
Requirements: Temp HOME fixture, plugin-bundle fixture, stub `SchedulerBackend` (no real launchctl/systemctl/crontab calls). Goal-backward assertions for every Phase 2 ROADMAP success criterion: INST-01..06, SCHED-01..05, PRIV-06, CLI-01/04/05/06, LIC-01/02. Re-install idempotency byte-hashes verified. .pending readers-must-ignore not relevant here. **Asserts `tick.sh` content does NOT contain `flock`.**
Acceptance: Full e2e suite green; traceability table maps each assertion to its requirement ID.

## Quality Gates (MANDATORY — in order)

**10. YODA: Code review** — TypeScript strict mode, error handling consistent, no main.ts edits after 02-01, jsonc-parser merge correct, no shell flock anywhere.

**11. APEX: Security review** — secrets.enc never logged, license key never appears in errors.jsonl, no path traversal in installer, no shell injection in execa calls, mutual-exclusion enforced (npm path never sets enabledPlugins), atomic writes for settings.json + CLAUDE.md, zero-network mandate honored.

**12. ANALYZER: Code improvement review** — Blocks on D/F. Readability, performance, no duplication across verbs.

(No PRISM — Phase 2 has zero UI work.)

## Finalize

**13. ARCHITECT: Commit all changes**
Only after YODA + APEX + ANALYZER all PASS. Commit message: `feat(phase2): installer + scheduler + CLI skeleton — npx claude-sop install end-to-end`.

## Acceptance Criteria (goal-backward from ROADMAP Phase 2)

- [ ] **INST-01..02:** `npx claude-sop install` in fresh project produces hooks + scheduler + gitignore + CLAUDE.md markers + secrets.enc; re-running is a no-op (byte-hash identical state)
- [ ] **INST-03:** Hook merge non-destructively preserves user hooks, with claude-sop hooks tagged `id: "claude-sop"` and ordered last
- [ ] **INST-04:** `.claude-sop/` appended to project `.gitignore` (file created if missing)
- [ ] **INST-05:** `CLAUDE.md` exists with empty `<!-- claude-sop:begin -->` / `<!-- claude-sop:end -->` markers
- [ ] **INST-06:** `npx claude-sop uninstall` removes hooks + scheduler + markers; preserves captures by default; `--purge` wipes all
- [ ] **SCHED-01..04:** Hourly scheduler registered via launchd (macOS) / systemd user unit (Linux) / cron fallback; absolute paths; `loginctl enable-linger` set on Linux for logout-survival; per-project lock via `proper-lockfile`
- [ ] **SCHED-05:** Uninstall removes scheduler unit cleanly with no zombie processes
- [ ] **PRIV-06:** `npx claude-sop purge` wipes project + global captures
- [ ] **CLI-01:** `status` prints all I3 fields in human + JSON modes
- [ ] **CLI-04:** `doctor` runs health checklist; exit code 3 on precondition failure
- [ ] **CLI-05:** `pause` / `resume` round-trip works
- [ ] **CLI-06:** All commands return rich exit codes (0/1/2/3) with actionable error messages
- [ ] **LIC-01:** `install` prompts for license key, accepts test key `123`, stores encrypted in `~/.claude-sop/secrets.enc`
- [ ] **LIC-02:** Trial-start timestamp recorded on first install, preserved byte-exact across re-install
- [ ] **G1 mutual exclusion:** npm install path NEVER sets `enabledPlugins`
- [ ] **No shell flock anywhere** (tick.sh content asserted clean)
- [ ] All unit + e2e tests pass (100%); zero-network mandate honored
- [ ] All quality gates approved (YODA + APEX + ANALYZER)

## Notes for Commander

- **Depends on Phase 1 commit.** Wait until `PLAN-v2-phase1-capture-foundation.md` finishes and is moved to `plans/done/`. Phase 2 references `dist/capture/shim.cjs` and `dist/capture/writer.cjs` (Phase 1 outputs) in installer hook entry generation.
- **Wave 1 = 4 plans truly parallel.** Wave 2 = 4 plans parallel via `src/cli/verbs/index.ts` barrel pattern (each adds 1 import + 1 register line at distinct sentinels — clean 3-way merge).
- **main.ts frozen after 02-01.** Same Phase 1 lesson applied.
- **Plugin bundle asset note:** Plan 02-05 needs a `dist/plugin/` source to copy from. If Phase 1 doesn't ship one, ARCHITECT creates a minimal `plugin/` source directory + tsup config to emit `dist/plugin/hooks/hooks.json` per the template in 02-RESEARCH.md.
- **No live OS state mutation in tests.** All `launchctl` / `systemctl` / `crontab` calls go through a stubbed `SchedulerBackend` interface in tests.

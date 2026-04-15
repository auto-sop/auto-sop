# STATE: claude-sop

**Last updated:** 2026-04-15

## Project Reference

- **Name:** claude-sop
- **Core Value:** Claude Code never makes the same mistake twice — captured history becomes enforced project rules automatically.
- **Current Focus:** v12 hotfix — launchd install reliability + doctor effective check

## Current Position

- **Phase 0:** COMPLETE ✓ — scrubber, atomic writes, privacy foundation (v1)
- **Phase 1:** COMPLETE ✓ — hook shim + detached writer + turn-directory capture store (v2 + hotfixes v4-v8)
- **Phase 2:** MOSTLY COMPLETE — installer, scheduler, CLI skeleton (v3, v4-v8 hotfixes); **v12 closes SCHED-04 gap** (launchd natural fire never worked)
- **Phase 3 MVP:** SHIPPED ✓ — observable learner, no detectors yet (v9)
- **Phase 4-light:** SHIPPED ✓ — ManagedSectionEditor + sample directive + statusline + test cleanup (v10); statusline parser hotfix (v11)
- **v12:** IN FLIGHT — launchd install reliability (bootstrap + warmup kickstart) + doctor `scheduler effective` check
- **Next after v12:** recall gate (v13) or backlog cleanup (TBD)
- **Progress:** `[#####--]` 4.5/7 phases complete (Phase 2 closes with v12)

## Performance Metrics

- Phases complete: 4/7 (Phase 2 pending v12 close)
- Sessions: 12 (init+research+roadmap, Phase 0 context + SaaS pivot, Phase 0 plan+execute, Phase 1+2 joint context, Phase 2 execution, v4-v8 hotfixes, Phase 3 v9, Phase 4-light v10, v11 statusline hotfix, v12 launchd hotfix, dogfood validation)

## Accumulated Context

### Key Decisions

- Hybrid distribution model (npm CLI + Claude Code Marketplace plugin entry) — to be formalized as ADR in Phase 0.
- 7-phase decomposition (Phase 6 added for License & Distribution Security after SaaS pivot).
- Commercial SaaS freemium: 14-day trial → subscription via license API key; test key `123`.
- Anti-RE defense layers 1+2+3 accepted (obfuscation + Node SEA binary + ed25519-signed responses); layers 4+5 rejected.
- Network egress policy: zero except license validation.
- Scrubber is a Phase 0 gating deliverable — must work before any capture write path exists.
- ManagedSectionEditor isolated as its own phase (one bug = permanent trust loss).

### Accumulated Lessons (v9-v12)

- v11: Statusline parser — fourth test-false-positive class bug. Simplified fixtures lie; real launchctl output format must be used in mocks.
- v10: dispatch-task.sh stderr fix — dev-army infrastructure hotfix, not claude-sop itself.
- v12: `launchctl bootstrap` alone is insufficient — `kickstart -k` warmup fire at install time is critical to prove the scheduler works immediately. `StartInterval` replaced with `StartCalendarInterval { Minute: 0 }` for predictable, sleep/wake-robust hourly fires. Doctor `scheduler registered` (file-exists check) replaced with `scheduler effective` (parses `launchctl print` for actual runs count).
- Dogfood validation completed with real army run in `wrbeautiful-shopify-theme`.

### Open Questions / Todos

- Phase 3 spike: `claude -p --output-format json` exact shape; detector set finalization after ~1 week of dogfooding.
- Linux systemd hardening: similar `OnCalendar=hourly` + `Persistent=true` fix for systemd (separate plan, v13 or v14).

### Blockers

None.

## Session Continuity

- **Last session:** 2026-04-15
- **Next action:** v12 hotfix — Wave 2 (tests for install/doctor), then quality gates, then commit
- **Resume hint:** v12 fixes launchd install reliability: 5-step install (bootout → write → bootstrap → enable → kickstart), StartCalendarInterval replaces StartInterval, doctor `scheduler effective` check parses launchctl print for actual runs. Uninstall already used bootout. Integration smoke test needs CLAUDE_SOP_LABEL env var for test isolation (added in v12).

---
*State initialized: 2026-04-13*

# STATE: claude-sop

**Last updated:** 2026-04-13

## Project Reference

- **Name:** claude-sop
- **Core Value:** Claude Code never makes the same mistake twice — captured history becomes enforced project rules automatically.
- **Current Focus:** Roadmap approved; awaiting Phase 0 planning.

## Current Position

- **Phase:** 0 (Distribution Decision + Foundations) — context captured, ready to plan
- **Plan:** none
- **Status:** Phase 0 CONTEXT.md committed; SaaS pivot ripples applied (PROJECT/REQUIREMENTS/ROADMAP); ready for `/gsd:plan-phase 0`
- **Progress:** `[-------]` 0/7 phases complete

## Performance Metrics

- Phases complete: 0/7
- v1 requirements complete: 0/61
- Sessions: 2 (init+research+roadmap, Phase 0 context + SaaS pivot)

## Accumulated Context

### Key Decisions

- Hybrid distribution model (npm CLI + Claude Code Marketplace plugin entry) — to be formalized as ADR in Phase 0.
- 7-phase decomposition (Phase 6 added for License & Distribution Security after SaaS pivot).
- Commercial SaaS freemium: 14-day trial → subscription via license API key; test key `123`.
- Anti-RE defense layers 1+2+3 accepted (obfuscation + Node SEA binary + ed25519-signed responses); layers 4+5 rejected.
- Network egress policy: zero except license validation.
- Scrubber is a Phase 0 gating deliverable — must work before any capture write path exists.
- ManagedSectionEditor isolated as its own phase (one bug = permanent trust loss).

### Open Questions / Todos

- Phase 0 ADR: plugin bundle location, sideload vs marketplace, `${CLAUDE_PLUGIN_ROOT}` wipe semantics on plugin update, uninstall coverage of both plugin + scheduler, scheduler→learner entrypoint resolution.
- Phase 1 spike: re-verify CC hook payload shapes (tool_use_id pairing, Stop vs SubagentStop dispatch, subagent nesting 2+ deep).
- Phase 2 spike: empirical `launchctl bootstrap gui/$UID` and systemd `Persistent=true` post-wake behavior.
- Phase 3 spike: `claude -p --output-format json` exact shape; detector set finalization after ~1 week of dogfooding.

### Blockers

None.

## Session Continuity

- **Last session:** 2026-04-13T08:36:48.907Z
- **Next action:** `/gsd:plan-phase 0` to decompose Phase 0 into executable plans
- **Resume hint:** Start with distribution-model ADR; then PathResolver + Config + Scrubber as pure libs with fixture-driven tests. Config must accommodate encrypted license storage (Phase 6 implements license client).

---
*State initialized: 2026-04-13*

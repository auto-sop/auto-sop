# STATE: claude-sop

**Last updated:** 2026-04-13

## Project Reference

- **Name:** claude-sop
- **Core Value:** Claude Code never makes the same mistake twice — captured history becomes enforced project rules automatically.
- **Current Focus:** Roadmap approved; awaiting Phase 0 planning.

## Current Position

- **Phase:** 0 COMPLETE ✓ — Distribution ADR + PathResolver + Config + Scrubber + recall gate shipped
- **Next phase:** 1 (Capture Foundation) — not started
- **Plan:** none (Phase 0 plan moved to `plans/done/`)
- **Status:** Ready for `/gsd:discuss-phase 1`
- **Progress:** `[#------]` 1/7 phases complete

## Performance Metrics

- Phases complete: 1/7
- v1 requirements complete: 6/61 (INST-07, INST-08, PRIV-01, PRIV-02, PRIV-03, PRIV-05)
- Sessions: 3 (init+research+roadmap, Phase 0 context + SaaS pivot, Phase 0 plan+execute)

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

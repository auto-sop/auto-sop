# STATE: claude-sop

**Last updated:** 2026-04-13

## Project Reference

- **Name:** claude-sop
- **Core Value:** Claude Code never makes the same mistake twice — captured history becomes enforced project rules automatically.
- **Current Focus:** Roadmap approved; awaiting Phase 0 planning.

## Current Position

- **Phase:** 0 (Distribution Decision + Foundations) — not started
- **Plan:** none
- **Status:** Roadmap created; ready for `/gsd:plan-phase 0`
- **Progress:** `[------]` 0/6 phases complete

## Performance Metrics

- Phases complete: 0/6
- v1 requirements complete: 0/51
- Sessions: 1 (initialization + research + roadmap)

## Accumulated Context

### Key Decisions

- Hybrid distribution model (npm CLI + Claude Code plugin bundle + OS scheduler) — to be formalized as ADR in Phase 0.
- 6-phase decomposition derived from natural requirement clusters and research ordering constraints.
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

- **Last session:** Initialization → Research → Requirements → Roadmap (2026-04-13)
- **Next action:** `/gsd:plan-phase 0` to decompose Phase 0 into executable plans
- **Resume hint:** Start with distribution-model ADR; then PathResolver + Config + Scrubber as pure libs with fixture-driven tests.

---
*State initialized: 2026-04-13*

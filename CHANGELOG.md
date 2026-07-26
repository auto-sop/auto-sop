# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.1.32] - 2026-07-26

### Fixed
- Dormant-project directives are now preserved correctly across reactivation. Directive
  staleness is measured in project-activity time (idle periods are subtracted from directive
  age) instead of wall-clock time, so returning to a project after weeks no longer prunes its
  learned directives on the tick after you resume. Proven directives also keep their tier
  across long idle periods.

### Note
- Projects that were already idle for longer than the directive TTL BEFORE upgrading to this
  version may have already lost directives under the previous one-tick limitation; this release
  prevents future loss but cannot recover directives that were already pruned.

## [0.1.31] - 2026-07-23

### Fixed
- Directives are no longer pruned during a tick where the project has had no new Claude Code
  sessions for longer than the potential-directive TTL. Note: once activity resumes, the idle
  period still counts toward directive age, so long-idle directives may age out on a subsequent
  tick. Caps and tombstone eviction continue to apply.

## [0.1.0] - 2026-05-03

### Added
- First public release
- Passive capture via Claude Code hooks (<50ms overhead)
- Rule-based + LLM pattern detection
- Automatic CLAUDE.md managed section with hash-checking
- 16 CLI commands (install, status, learn-now, stats, doctor, etc.)
- Free tier: 1 project, unlimited directives, forever
- Pro tier: unlimited projects, priority support

[Unreleased]: https://github.com/auto-sop/auto-sop/compare/v0.1.32...HEAD
[0.1.32]: https://github.com/auto-sop/auto-sop/compare/v0.1.31...v0.1.32
[0.1.31]: https://github.com/auto-sop/auto-sop/compare/v0.1.0...v0.1.31
[0.1.0]: https://github.com/auto-sop/auto-sop/releases/tag/v0.1.0

# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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

[Unreleased]: https://github.com/auto-sop/auto-sop/compare/v0.1.31...HEAD
[0.1.31]: https://github.com/auto-sop/auto-sop/compare/v0.1.0...v0.1.31
[0.1.0]: https://github.com/auto-sop/auto-sop/releases/tag/v0.1.0

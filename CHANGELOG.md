# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.1.37] - 2026-10-18

### Fixed
- Capture no longer degrades a project that several Claude Code sessions are working at the
  same time, such as a multi-agent army with one agent per terminal pane. When an army's
  environment is detected (`DEV_ARMY_PROJECT_NAME` or `DEV_ARMY_HOME` is set), auto-sop
  switches to a lighter capture mode. It still records every turn's prompt, final response,
  changed files and subagent results, and stops recording individual tool calls, which were 87%
  of hook events in the benchmark workload. Measured with nine concurrent sessions on one machine:
  - hook latency p50 (the time Claude Code waits): 154.7 ms before this release, 44.1 ms now.
    Run side by side in one sitting, full mode measured 95.0 ms against 44.1 ms (−54%).
  - capture writer processes spawned: 621 → 81 (−87%); 51% fewer processes in total.
- A single Claude Code session is unchanged: it still captures in full, with the same p50 /
  p95 of 33.6 / 35.5 ms, and writes byte-identical capture files.

### Added
- Lightweight turns are labelled. Their `meta.json` carries `"capture_mode": "lightweight"`
  and `auto-sop show` reports the mode for a turn or a session, so a turn with no recorded
  tool calls is not mistaken for a quiet one.

### Note
- Before this release, auto-sop had to be removed from any project driven by a multi-agent
  army. On 2026-10-18 it was removed from seventeen Claude settings files, deliberately and on
  measurement, to get a nine-agent army running at all. From 0.1.37 on it can stay installed.
- Versions 0.1.33, 0.1.34, 0.1.35 and 0.1.36 were never published and never will be. npm goes
  straight from 0.1.32 to 0.1.37. The patch version is bumped automatically on every commit,
  and the change in this release was one logical change made in several commits, so
  `package.json` went from 0.1.32 to 0.1.37 before anything was released. Nothing was ever
  released under those numbers; everything they would have held is in 0.1.37.

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

[Unreleased]: https://github.com/auto-sop/auto-sop/compare/v0.1.37...HEAD
[0.1.37]: https://github.com/auto-sop/auto-sop/compare/v0.1.32...v0.1.37
[0.1.32]: https://github.com/auto-sop/auto-sop/compare/v0.1.31...v0.1.32
[0.1.31]: https://github.com/auto-sop/auto-sop/compare/v0.1.0...v0.1.31
[0.1.0]: https://github.com/auto-sop/auto-sop/releases/tag/v0.1.0

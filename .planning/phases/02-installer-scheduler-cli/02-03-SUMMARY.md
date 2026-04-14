# 02-03 Summary: Scheduler Layer

## What was built

### Source files (7)
- `src/scheduler/types.ts` — `SchedulerBackend` interface, `SchedulerStatus`, `SchedulerInstallOpts`
- `src/scheduler/detect.ts` — `systemdUserAvailable()` probe via `systemctl --user is-system-running` with 2s timeout
- `src/scheduler/tick-wrapper.ts` — `renderTickScript()` + `writeTickScript()` for POSIX `tick.sh` with absolute paths, POSIX single-quote escaping, no flock
- `src/scheduler/macos-launchd.ts` — launchd plist renderer + `macosLaunchd` backend (bootstrap/enable/bootout via `gui/<uid>`)
- `src/scheduler/linux-systemd.ts` — systemd service+timer unit renderers + `linuxSystemd` backend (daemon-reload, enable --now, loginctl enable-linger)
- `src/scheduler/linux-cron.ts` — `linuxCron` backend with `# claude-sop:managed` marker for idempotent strip+append
- `src/scheduler/index.ts` — `pickBackend()` dispatcher: darwin→launchd, linux+systemd→systemd, linux-systemd→cron+warning

### Test files (6)
- `test/scheduler/detect.test.ts` — 8 tests
- `test/scheduler/tick-wrapper.test.ts` — 9 tests
- `test/scheduler/macos-launchd.test.ts` — 8 tests
- `test/scheduler/linux-systemd.test.ts` — 11 tests
- `test/scheduler/linux-cron.test.ts` — 7 tests
- `test/scheduler/dispatch.test.ts` — 4 tests

## Results
- **47 scheduler tests passing**
- **419 total tests passing** (full suite, zero regressions)
- **tsc --noEmit clean**
- All execa calls mocked — no real subprocess invocations in tests
- No flock usage in tick.sh (asserted via test)
- main.ts NOT touched

## Key decisions
- 5 test files mock execa (4 backend/detect + dispatch needs it for backend imports)
- `parseLastTrigger` in systemd status handles both pure-microsecond and human-readable timestamp formats
- XML escape helper in launchd covers &, <, >, ", ' for plist safety
- Cron install always strips prior managed entries before appending (idempotent)
- Terminal newline enforced in cron output (Pitfall 8)

# 02-09 Summary: End-to-End Integration Suite

## What was built

- **test/integration/phase2-e2e.test.ts** — 15 e2e tests covering every Phase 2 ROADMAP success criterion
- **test/integration/helpers.ts** — Reusable helpers: `makeTempHome`, `seedPluginBundleFixture`, `stubSchedulerBackend`
- **test/integration/fixtures/plugin-bundle/** — Minimal plugin bundle fixture (plugin.json, hooks.json, marketplace.json, shim.cjs, learner.cjs)

## Traceability

| Req ID   | Test                                                                  |
|----------|-----------------------------------------------------------------------|
| INST-01  | install wires hooks, creates secrets.enc, copies plugin bundle        |
| INST-02  | re-install produces byte-identical settings.json (sha256 hash)        |
| INST-03  | pre-existing user hooks preserved in settings.json                    |
| INST-04  | .gitignore contains `.claude-sop/`                                    |
| INST-05  | CLAUDE.md has managed-section markers                                 |
| INST-06  | uninstall removes hooks/scheduler/secrets; captures preserved         |
| SCHED-01 | scheduler.install called with absolute tick.sh path                   |
| SCHED-03 | tick.sh exists, executable, no flock command                          |
| SCHED-04 | scheduler interval is 3600s                                           |
| SCHED-05 | tick.sh is pure POSIX sh, sets CLAUDE_SOP_LEARNER=1                   |
| PRIV-06  | --purge wipes captures                                                |
| CLI-01   | status returns all I3 fields after install                            |
| CLI-05   | pause/resume toggle paused.flag, status reflects it                   |
| LIC-01   | secrets.enc schema v1 with trial.started_at, license.kind=dev         |
| LIC-02   | re-install preserves trial.started_at (write-once invariant)          |
| G1       | npm install uses extraKnownMarketplaces, never enabledPlugins         |
| G3       | downgrade refused with PreconditionError                              |

## Quality

- **506 tests** across 64 test files — all green
- **tsc --noEmit** clean
- Zero network calls (no-network setup file active)
- Zero OS mutations (scheduler backend fully stubbed)
- Re-install idempotency verified via sha256 byte-hash comparison

## Key design decisions

- **flock assertion**: Checks non-comment lines only, since tick.sh has an explanatory comment mentioning flock
- **getMachineId stub**: Injected to avoid real machine-id calls in CI
- **Temp HOME isolation**: Each test gets its own temp directory pair (home + project), cleaned up in afterEach

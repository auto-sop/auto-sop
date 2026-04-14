# Plan 02-06 Summary: Uninstall + Purge Verbs

## Status: COMPLETE

## What was built

### Source files
- **`src/installer/uninstall-orchestrator.ts`** — Best-effort step runner: backup managed-section → strip markers → strip hooks by id → scheduler uninstall → remove tick.sh/secrets.enc/version.txt/marketplace bundle. `--purge` additionally wipes project captures + global sop dir. Never throws; aggregates warnings.
- **`src/cli/verbs/uninstall.ts`** — CLI verb with `--purge` and `--project` flags. Human + JSON output modes. Exit 0 if zero warnings, exit 1 otherwise.
- **`src/cli/verbs/purge.ts`** — Standalone PRIV-06 verb. Wipes captures only (no hooks/scheduler). Interactive confirmation unless `--yes` or `--json`.
- **`src/cli/verbs/index.ts`** — Added 2 imports + 2 register calls at sentinel comments. Sentinels preserved.

### Test files
- **`test/installer/uninstall-orchestrator.test.ts`** (6 tests) — Full uninstall, --purge, scheduler warnings, scheduler throws, missing files, user-only settings unchanged.
- **`test/cli/verbs/uninstall.test.ts`** (6 tests) — Human mode success/warnings, --purge forwarding, --json ok/fail, backup path display.
- **`test/cli/verbs/purge.test.ts`** (3 tests) — --yes removes dirs, --json skips prompt, absent dirs handled.

## Acceptance verification
- ✅ J1: Default preserves captures; `--purge` wipes them
- ✅ J2: Managed-section backed up to `~/.claude/sop/<hash12>/managed-history/uninstall-<ts>.md` before strip
- ✅ J3: Best-effort semantics — zero warnings → exit 0, any → exit 1
- ✅ J4: secrets.enc always removed
- ✅ PRIV-06: Dedicated `purge` verb independent of uninstall
- ✅ G1: main.ts frozen (untouched)
- ✅ Barrel sentinels preserved
- ✅ 434 tests green, tsc clean

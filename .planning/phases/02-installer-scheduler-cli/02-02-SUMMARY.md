---
phase: 02-installer-scheduler-cli
plan: 02
status: complete
---

# 02-02 Summary: Installer Libraries

## What was built

Seven source files in `src/installer/` providing pure-function installer libraries:

| File | Exports | Purpose |
|------|---------|---------|
| `hook-entries.ts` | `buildHookEntries`, `HOOK_EVENTS`, `CLAUDE_SOP_HOOK_ID` | Build hook entry objects for all 5 Claude Code events |
| `merge-settings.ts` | `mergeProjectHooks`, `mergeGlobalMarketplace` | Edit-preserving JSONC merge into settings.json |
| `marketplace-register.ts` | `registerMarketplace` | Thin wrapper for global marketplace registration |
| `version.ts` | `readInstalledVersion`, `writeInstalledVersion`, `compareVersions` | version.txt read/write/semver compare |
| `managed-section.ts` | `ensureManagedSection`, `stripManagedSection`, `MANAGED_BEGIN`, `MANAGED_END` | CLAUDE.md marker management |
| `gitignore.ts` | `ensureGitignore` | Idempotent .gitignore entry append |
| `index.ts` | barrel re-export | Single import surface for Wave 2 |

## Key design decisions

- **jsonc-parser** `modify` + `applyEdits` preserves comments and formatting in settings.json
- Hook entries tagged with `id: 'claude-sop'` for idempotent detection and strip-before-append
- User hooks always first; claude-sop entries appended LAST (G2 compliance)
- `mergeGlobalMarketplace` writes `extraKnownMarketplaces` only — never touches `enabledPlugins` (G1 mutual exclusion)
- All functions use `writeFileAtomic` for crash-safe writes
- Empty/missing files treated as `"{}"` (Pitfall 4 from RESEARCH)

## Test coverage

6 test files, 40 tests — all passing:
- `hook-entries.test.ts` — 4 tests (events, fields, independence, single hook)
- `merge-settings.test.ts` — 10 tests (fresh, empty, user-hooks-preserved, idempotent, JSONC comments, dedup, all-events, invalid-json, marketplace, non-absolute)
- `marketplace-register.test.ts` — 2 tests (delegation, rejection)
- `version.test.ts` — 8 tests (ENOENT, round-trip, trim, invalid-read, invalid-write, none/same/newer/older)
- `managed-section.test.ts` — 9 tests (create, append, noop, idempotent, separators, strip, strip-no-markers, strip-missing)
- `gitignore.test.ts` — 5 tests (create, noop, append, separator, slash-distinction)

## Verification

- `tsc --noEmit` — clean
- `vitest run` — 346/346 tests pass (43 files, including all pre-existing)
- Zero side effects outside tmp directories in tests
- `src/installer/index.ts` exports union of all 6 submodules

---
phase: 02-installer-scheduler-cli
plan: 04
status: complete
---

# 02-04 Summary: License Storage

## What was built

### `src/license/schema.ts`
- Zod schema `secretsPayloadV1Schema` for secrets.enc payload v1
- Covers `schema_version`, `license`, `trial`, and `install` blocks
- Strict validation: literal version 1, enum kind, min-length strings, positive ints

### `src/license/storage.ts`
- `readSecrets(path)` — decrypt + validate via Phase 0 helpers, null if missing
- `writeSecrets(path, payload)` — validate + encrypt + atomic write via Phase 0 helpers
- `recordLicenseOnInstall(opts)` — LIC-02 critical: preserves `trial.started_at` on re-install, updates license and install blocks

### `src/license/trial.ts`
- `trialStatus(payload, now)` — pure function returning `{status, daysRemaining, startedAt, durationDays}`
- Statuses: `dev-key` (Infinity), `trial` (positive days), `expired` (negative days)
- `TRIAL_DURATION_DAYS = 14`

### `src/license/index.ts`
- Barrel re-export of all public API

## Key invariants
- Phase 0 `secrets.ts` encrypt/decrypt reused — no crypto reimplemented
- `trial.started_at` written once on first install, byte-exact preserved on re-install (LIC-02)
- Dev key `'123'` bypasses trial expiry (returns `dev-key` status with Infinity)

## Test results
- 26 tests across 3 files, all passing
- Schema validation (9 tests): valid/invalid payloads, enum, lengths, ranges
- Storage (10 tests): fresh install, re-install LIC-02, key change, version upgrade, round-trip, corruption, kind derivation
- Trial (7 tests): dev-key, just-started, mid-trial, expired boundaries, custom duration, future start

## Files created
- `src/license/schema.ts`
- `src/license/storage.ts`
- `src/license/trial.ts`
- `src/license/index.ts`
- `test/license/schema.test.ts`
- `test/license/storage.test.ts`
- `test/license/trial.test.ts`

## Files NOT touched
- `src/cli.ts` (main.ts frozen)
- `src/config/secrets.ts` (Phase 0 — imported only)
- `src/config/machine-id.ts` (Phase 0 — mocked in tests)

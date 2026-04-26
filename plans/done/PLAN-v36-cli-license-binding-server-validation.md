# PLAN-v36: CLI License Binding + Server Validation (BIND-1 → BIND-6)

## Overview

Connect the CLI to the backend. After v34 deployed the server-side license validation API with Ed25519 signing, this plan implements the CLI counterpart: project binding, periodic server validation, signed response verification, license caching with grace period, project count enforcement, and ELv2 license file.

**Depends on:** v34 (backend `/api/v1/license/validate` endpoint must be live)
**Repo:** `auto-sop` (CLI — this repo)
**Backend repo:** `auto-sop-site` (already deployed, NOT modified by this plan — see v37 for backend hardening)

## Architecture Decisions

- **Server URL:** `https://auto-sop.com/api/v1` (production), configurable via `AUTO_SOP_API_URL` env var for dev
- **Ed25519 public key:** Embedded in CLI source as base64 PEM. Extracted from the same key pair that the server uses for signing.
- **binding.json:** Written to `<project>/.auto-sop/binding.json` during install. Contains HMAC-SHA256 token binding project to machine+license.
- **license-cache.json:** Written to `~/.auto-sop/state/license-cache.json`. Stores last validated response + signature.
- **Grace period:** 7 days offline. After 7 consecutive days without successful server validation, learner stops (capture continues).
- **Project enforcement:** `bound_projects > max_projects` → learner stops for excess projects (oldest-first order preserved)
- **No breaking changes to install flow** — license key prompt already exists, we enhance it with server validation + binding
- **JSON.stringify for signing** — server uses `JSON.stringify(payload)` (not canonicalize). CLI must match exactly.
- **No new dependencies** — Node.js `crypto` module handles Ed25519 verify, HMAC-SHA256, all natively

## Server API Contract (v34 — already deployed)

```
POST /api/v1/license/validate
Request:
  { key, machine_id?, bound_projects?, binding_hashes?, cli_hash?, cli_version? }

Response (200):
  {
    payload: {
      valid: boolean,
      plan: "free" | "trial" | "pro",
      max_projects: number,
      machine_id: string | null,
      issued_at: ISO8601,
      expires_at: ISO8601,
      nonce: string (32 hex chars)
    },
    signature: string (hex-encoded Ed25519 signature)
  }

Response (401): { error: "Invalid license key" }
Response (429): { error: "Rate limit exceeded" }
```

## Implementation Tasks

### Wave 1: Core Infrastructure (no dependencies between tasks)

#### Task 1: ARCHITECT — Ed25519 Signature Verification Module
Files: `src/license/ed25519-verify.ts`, `src/license/server-public-key.ts`
Requirements:
- Create `src/license/server-public-key.ts`:
  - Export `SERVER_PUBLIC_KEY_B64` — base64-encoded Ed25519 public PEM:
    ```
    LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQXU2cmhQTElaRTNtTlRJbDZHM05hdzlxOVN5ejVVZ0hsbjNPeXBaRDk5dWc9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=
    ```
  - This is the PRODUCTION key — do NOT use a placeholder
  - Also export `API_BASE_URL` — defaults to `https://auto-sop.com/api/v1`, overridable via `AUTO_SOP_API_URL` env var
- Create `src/license/ed25519-verify.ts`:
  - `verifyServerSignature(payload: Record<string, unknown>, signatureHex: string): boolean`
    - Uses Node.js `crypto.verify()` with Ed25519 algorithm (null for Ed25519)
    - Payload serialized with `JSON.stringify(payload)` (must match server's signing)
    - Signature is hex-encoded (matching server's `signature.toString('hex')`)
    - Returns true if valid, false if invalid
  - `validateResponseFreshness(payload: { nonce: string, issued_at: string, expires_at: string }, lastNonce?: string): boolean`
    - Checks: nonce !== lastNonce (anti-replay)
    - Checks: issued_at is recent (within last 2 hours)
    - Checks: expires_at is in the future
    - Returns true if all checks pass
- Unit tests in `test/license/ed25519-verify.test.ts`:
  - Generate a test Ed25519 key pair
  - Sign a payload, verify it passes
  - Tamper with payload, verify it fails
  - Tamper with signature, verify it fails
  - Test freshness validation (expired, replayed nonce, future issued_at)
Acceptance: Signature verification works with test keys, freshness checks pass/fail correctly

#### Task 2: ARCHITECT — Project Binding Module (BIND-1)
Files: `src/license/binding.ts`, `test/license/binding.test.ts`
Requirements:
- Create `src/license/binding.ts`:
  - `createBindingToken(licenseKey: string, projectPath: string, machineId: string): string`
    - Returns HMAC-SHA256 hex: `HMAC-SHA256(licenseKey, projectPath + '|' + machineId)`
  - `createBindingFile(opts: { licenseKey: string, projectPath: string, machineId: string }): BindingData`
    - Returns: `{ license_key_hash: sha256(key).slice(0,16), machine_id: sha256(hostname+username), bound_at: ISO8601, token: hmac_result }`
  - `readBindingFile(projectAutoSopDir: string): BindingData | null`
    - Reads `<project>/.auto-sop/binding.json`, returns parsed or null
  - `verifyBindingToken(binding: BindingData, licenseKey: string, projectPath: string, machineId: string): boolean`
    - Recomputes HMAC and compares with stored token
  - `writeBindingFile(projectAutoSopDir: string, binding: BindingData): void`
    - Atomic write (temp + rename) to `<project>/.auto-sop/binding.json`
- Use existing `machineId()` from `src/config/machine-id.ts` for machine_id derivation
- Unit tests:
  - Create binding, verify it passes
  - Copy binding to different path, verify it fails (path mismatch)
  - Modify license key, verify it fails
  - Different machine, verify it fails
Acceptance: Binding tokens are path+machine+key specific, copying/tampering is detected

#### Task 3: ARCHITECT — License Cache Module (BIND-4)
Files: `src/license/cache.ts`, `test/license/cache.test.ts`
Requirements:
- Create `src/license/cache.ts`:
  - `CACHE_PATH` = `~/.auto-sop/state/license-cache.json`
  - `GRACE_PERIOD_DAYS` = 7
  - `LicenseCache` type: `{ validated_at: ISO8601, last_nonce: string, payload: ValidatePayload, signature: string, consecutive_failures: number, first_failure_at?: ISO8601 }`
  - `readCache(): LicenseCache | null` — read and parse, return null if missing/corrupt
  - `writeCache(cache: LicenseCache): void` — atomic write
  - `isCacheValid(cache: LicenseCache): boolean` — payload.expires_at not yet passed
  - `isGraceExpired(cache: LicenseCache): boolean` — consecutive_failures > 0 AND first_failure_at + 7 days < now
  - `incrementFailure(cache: LicenseCache): LicenseCache` — bump consecutive_failures, set first_failure_at if first failure
  - `resetFailures(cache: LicenseCache): LicenseCache` — reset to 0 on successful validation
- Ensure `~/.auto-sop/state/` directory is created if missing
- Unit tests:
  - Fresh cache is valid
  - Expired cache is invalid
  - Grace period: 6 days of failures → not expired, 8 days → expired
  - Failure counter increments correctly
Acceptance: Cache read/write works, grace period logic correct

#### Task 4: ARCHITECT — ELv2 License File (BIND-6)
Files: `LICENSE`, `package.json`
Requirements:
- Replace existing `LICENSE` file content with Elastic License 2.0 full text
  - Use the official ELv2 text from https://www.elastic.co/licensing/elastic-license
  - Replace `[name of software]` with "auto-sop"
  - Replace `[name of licensor]` with "RTW Bilişim" (or the entity user confirms)
- Update `package.json`:
  - Change `"license"` field from current value to `"Elastic-2.0"`
- Do NOT modify any other files — this is a license-only change
Acceptance: LICENSE file contains ELv2 text, package.json license field updated

### Wave 2: Server Communication (depends on Wave 1 — uses verify + cache modules)

#### Task 5: ARCHITECT — Server Validation Client (BIND-2 + BIND-3)
Files: `src/license/server-client.ts`, `test/license/server-client.test.ts`
Requirements:
- Create `src/license/server-client.ts`:
  - `validateLicense(opts: ValidateOpts): Promise<ValidateResult>`
    - `ValidateOpts`: `{ key, machineId, boundProjects, bindingHashes?, cliHash?, cliVersion? }`
    - `ValidateResult`: `{ success: boolean, payload?, error?, fromCache?: boolean }`
    - Flow:
      1. POST to `${API_BASE_URL}/license/validate` with fetch (Node.js native, no deps)
      2. Parse JSON response
      3. **Verify Ed25519 signature** using `verifyServerSignature()` — reject if invalid
      4. **Check freshness** using `validateResponseFreshness()` — reject if stale/replayed
      5. **Update cache**: on success → `writeCache()` with `resetFailures()`. On network error → `incrementFailure()` on existing cache
      6. Return `{ success: true, payload }` or `{ success: false, error: "..." }`
    - Network error handling:
      - Timeout: 10s fetch timeout (AbortController)
      - Connection refused / DNS failure → fall back to cache
      - 401 (invalid key) → `{ success: false, error: "invalid_key" }` (don't cache)
      - 429 (rate limited) → fall back to cache, don't increment failure
      - 500 → fall back to cache, increment failure
    - Cache fallback logic:
      - If cache exists AND `isCacheValid()` → return cached payload with `fromCache: true`
      - If cache exists AND `isGraceExpired()` → return `{ success: false, error: "grace_expired" }`
      - If no cache → return `{ success: false, error: "no_cache" }`
  - `getValidationStatus(): ValidationStatus`
    - Reads cache, returns: `{ lastValidated, graceRemaining, isOnline, plan, maxProjects }`
    - For `status` CLI verb display
- Unit tests (mock fetch):
  - Successful validation → cache updated, result returned
  - Network failure → falls back to valid cache
  - Network failure + grace expired → returns error
  - Invalid signature → rejected (not cached)
  - Replayed nonce → rejected
  - 429 → uses cache, no failure increment
Acceptance: Server validation works end-to-end, cache fallback + grace period correct

### Wave 3: Integration into Install + Tick (depends on Wave 2)

#### Task 6: ARCHITECT — Integrate Binding into Install Flow (BIND-1 integration)
Files: `src/installer/orchestrator.ts` (modify), `src/cli/prompt.ts` (modify)
Requirements:
- Modify `src/installer/orchestrator.ts` — enhance Step 3 (license handling):
  - After `recordLicenseOnInstall()` succeeds:
    1. Read the license key from secrets
    2. Compute machine_id using existing `machineId()` function
    3. Call `createBindingFile({ licenseKey, projectPath, machineId })`
    4. Write binding to `<project>/.auto-sop/binding.json`
    5. **Server validation**: Call `validateLicense()` to verify key is valid server-side
       - If server returns `valid: true` → proceed normally
       - If server returns `invalid_key` → **abort install**, show error: "Invalid license key. Get a free key at https://app.auto-sop.com/signup"
       - If network error → proceed with WARNING: "Could not reach license server. Install will continue with 7-day offline grace period."
    6. Read current project count from registry for `bound_projects` parameter
  - Keep existing install flow intact — binding is additive
- Modify `src/cli/prompt.ts`:
  - Update `promptLicense()` to show: "Enter your license key (get one free at https://app.auto-sop.com/signup):"
  - Remove default '123' — key is now required (but keep 'dev-key-xxx' pattern for dev mode)
  - `classifyLicense()`: 'dev' if starts with 'dev-', 'user' otherwise
- Do NOT break existing tests — binding is additive to existing install logic
Acceptance: Install creates binding.json, validates with server, rejects invalid keys, handles offline gracefully

#### Task 7: ARCHITECT — Integrate Validation into Learner Tick (BIND-2 + BIND-5 integration)
Files: `src/learner/main.ts` (modify), `src/license/enforcement.ts` (new)
Requirements:
- Create `src/license/enforcement.ts`:
  - `checkLicenseBeforeTick(home: string): Promise<EnforcementResult>`
    - `EnforcementResult`: `{ allowed: boolean, reason?: string, plan?: string, maxProjects?: number }`
    - Flow:
      1. Read secrets.enc → get license key
      2. Read project registry → count bound projects
      3. Collect binding hashes from all registered project binding.json files
      4. Call `validateLicense({ key, machineId, boundProjects, bindingHashes })`
      5. If `success: false` AND `error: "grace_expired"` → return `{ allowed: false, reason: "License validation grace period expired. Please check your internet connection." }`
      6. If `success: false` AND `error: "invalid_key"` → return `{ allowed: false, reason: "Invalid license key. Update with: auto-sop install" }`
      7. If `success: true` AND `payload.valid: false` (over quota) → return `{ allowed: false, reason: "Project limit exceeded..." }`
      8. If `success: true` AND `payload.valid: true` → return `{ allowed: true, plan, maxProjects }`
      9. If dev key → skip all validation, return `{ allowed: true, plan: "dev" }`
  - `shouldProjectRun(projectIndex: number, maxProjects: number): boolean`
    - Projects 0..maxProjects-1 → allowed
    - Projects maxProjects+ → blocked
    - Ordering: by `installed_at` ascending (oldest projects keep running)
- Modify `src/learner/main.ts`:
  - In `main()` function, AFTER pause check (line ~309), BEFORE learner lock:
    ```
    const enforcement = await checkLicenseBeforeTick(home)
    if (!enforcement.allowed) {
      log.warn(`License check failed: ${enforcement.reason}`)
      log.warn('Learner will not run. Captures continue.')
      process.exit(0)  // clean exit, not error
    }
    ```
  - In per-project loop inside `runLearnerTick()`:
    - Before processing each project, check `shouldProjectRun(projectIndex, maxProjects)`
    - If not allowed: log skip message, continue to next project
    - If allowed: process normally
- Do NOT modify the hard timeout or capture pipeline — only gate the learner
Acceptance: Learner stops when license invalid/expired/over-quota, continues captures, dev key bypasses

#### Task 8: ARCHITECT — Update Status Verb with License Info
Files: `src/status/collector.ts` (modify), `src/cli/verbs/status.ts` (modify)
Requirements:
- Modify `src/status/collector.ts`:
  - Add to `collectStatus()`: read license cache, compute grace remaining, online status
  - Add fields to StatusReport: `serverValidation: { lastValidated, graceRemaining, isOnline, plan, maxProjects, boundProjects }`
  - Add binding status per project: `binding: { exists, valid, token_preview }`
- Modify `src/cli/verbs/status.ts`:
  - Add "License & Binding" section to status output:
    ```
    License & Binding:
      Plan:           free (1 project max)
      Server:         ✅ validated 2h ago
      Grace:          7 days remaining
      Bound projects: 1/1
      Upgrade:        https://app.auto-sop.com/upgrade
    ```
  - Show per-project binding status in project table
  - Show warning if grace period < 3 days
  - Show error if grace expired
Acceptance: `auto-sop status` shows license validation state, binding status, grace period

### Wave 4: Tests + Verification (depends on Wave 3)

#### Task 9: ARCHITECT — Integration Tests
Files: `test/license/integration.test.ts`
Requirements:
- Integration test suite that tests the full flow with mocked HTTP:
  - Install with valid key → binding created, cache populated
  - Install with invalid key → install aborted
  - Install offline → grace period starts
  - Tick with valid license → learner proceeds
  - Tick with expired grace → learner blocked
  - Tick with over-quota → excess projects skipped
  - Tick with dev key → all checks bypassed
  - Binding file tampered → detected as invalid
  - Response with bad signature → rejected
  - Response with replayed nonce → rejected
- Mock HTTP server for `/api/v1/license/validate` responses
- Use existing test patterns from the codebase
- Run `npm test` to verify all existing + new tests pass
- Run `npm run build` to verify no build errors
Acceptance: All integration tests pass, no regressions in existing tests, build succeeds

## Quality Gates (MANDATORY)

10. YODA: Code review — all implemented code must pass review
11. APEX: Security review — especially: Ed25519 verification correctness, HMAC binding integrity, no key leakage in logs, grace period cannot be extended by tampering, cache file permissions
12. ANALYZER: Code improvement review — grade must be C or above

## Finalize

13. ARCHITECT: Commit all changes

## CRITICAL RULES FOR ARCHITECT

1. **No new npm dependencies** — Node.js `crypto` handles everything (Ed25519, HMAC-SHA256, SHA-256)
2. **License key NEVER logged in plaintext** — only hash prefixes in logs
3. **binding.json atomic writes** — temp file + rename pattern (match existing codebase)
4. **license-cache.json file permissions** — mode 0600 (sensitive data)
5. **Server public key is a constant** — embedded in source, not fetched at runtime
6. **JSON.stringify match** — CLI must serialize payload identically to server for signature verification
7. **Dev key bypass** — keys starting with 'dev-' skip ALL server validation (development mode)
8. **Capture never stops** — even when learner is blocked, capture pipeline continues
9. **Do NOT modify capture, scrubber, or managed-section code** — binding is additive
10. **Run `npm test` and `npm run build`** after each wave to verify no regressions
11. **Existing tests must not break** — binding/validation is purely additive

## Acceptance Criteria

- [ ] Ed25519 signature verification works (verify server responses)
- [ ] Project binding creates HMAC-SHA256 token bound to path+machine+key
- [ ] Binding tampering detected (copy to different path, modify key)
- [ ] Install flow validates key with server, rejects invalid keys
- [ ] Install works offline with warning (grace period starts)
- [ ] Learner tick validates license before processing
- [ ] Over-quota projects are skipped (oldest projects preserved)
- [ ] Grace period: 7 days offline, then learner stops
- [ ] License cache stores validated response + signature
- [ ] Replay protection: nonce + timestamp checked
- [ ] `auto-sop status` shows license/binding/grace info
- [ ] Dev key bypasses all validation
- [ ] Capture continues even when learner is blocked
- [ ] LICENSE file updated to ELv2
- [ ] package.json license field updated
- [ ] All existing tests pass (no regressions)
- [ ] All new tests pass
- [ ] `npm run build` succeeds with zero errors
- [ ] All quality gates pass (YODA + APEX + ANALYZER)

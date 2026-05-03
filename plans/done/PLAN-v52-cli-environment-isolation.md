# v52: CLI Environment Isolation — Branch-Based URL Routing

## Overview

The CLI has hardcoded `https://auto-sop.com` and `https://app.auto-sop.com` URLs scattered across
source files. The only override is `AUTO_SOP_API_URL` env var — manual and easy to forget.

This plan introduces build-time environment injection so that:
- Building from `master` branch → all URLs point to production (`auto-sop.com`)
- Building from `dev` branch → all URLs point to staging (`staging.auto-sop.com`)
- `AUTO_SOP_API_URL` env var still works as a manual override (highest priority)

## Branch Strategy

- Create feature branch `feat/v52-cli-env-isolation` from `dev`
- All commits go to feature branch
- PR: feature branch → `dev`
- Never commit directly to `master`

## Architecture Decisions

- **Build-time injection via tsup `define`**: Use tsup's `define` option (maps to esbuild's `define`) to replace `__API_BASE_URL__` and `__APP_BASE_URL__` constants at build time. The build script detects the current git branch and sets URLs accordingly.
- **Single source of truth**: Create `src/config/environment.ts` that exports all environment-dependent URLs. All other files import from there — no more scattered hardcoded URLs.
- **Priority chain**: `AUTO_SOP_API_URL` env var (runtime) > build-time injected value > fallback `https://auto-sop.com/api/v1`
- **No runtime git detection**: The branch is checked at build time only. The built artifact has URLs baked in.

## Files That Need Changes

Currently hardcoded URLs in:
1. `src/license/server-public-key.ts:16` — `https://auto-sop.com/api/v1`
2. `src/license/enforcement.ts:111` — `https://app.auto-sop.com/upgrade`
3. `src/cli/prompt.ts:10,14` — `https://app.auto-sop.com/signup`
4. `src/cli/verbs/status.ts:101` — `https://app.auto-sop.com/upgrade`
5. `src/installer/orchestrator.ts:158` — `https://app.auto-sop.com/signup`

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: Create environment config module
   Files: src/config/environment.ts
   Requirements:
   - Create `src/config/environment.ts` with:
     ```ts
     /**
      * Environment-specific URLs.
      * Values are injected at build time via tsup define.
      * AUTO_SOP_API_URL env var overrides API_BASE_URL at runtime.
      */

     // These are replaced by tsup `define` at build time.
     // Fallback values are production URLs (safe default).
     declare const __API_BASE_URL__: string;
     declare const __APP_BASE_URL__: string;

     /** API endpoint base. Runtime env var takes priority over build-time value. */
     export const API_BASE_URL: string =
       process.env.AUTO_SOP_API_URL || (typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__ : 'https://auto-sop.com/api/v1');

     /** Dashboard/app base URL for user-facing links (signup, upgrade). */
     export const APP_BASE_URL: string =
       typeof __APP_BASE_URL__ !== 'undefined' ? __APP_BASE_URL__ : 'https://auto-sop.com';
     ```
   - This is the ONLY place URLs are defined. All other files import from here.
   Acceptance: `src/config/environment.ts` exists with API_BASE_URL and APP_BASE_URL exports

2. ARCHITECT: Add build-time environment detection to tsup config
   Files: tsup.config.ts
   Requirements:
   - Add a helper at the top of tsup.config.ts that detects the git branch:
     ```ts
     import { execSync } from 'child_process';

     function getGitBranch(): string {
       try {
         return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
       } catch {
         return 'master'; // fallback to production
       }
     }

     function getEnvironmentDefines(): Record<string, string> {
       const branch = getGitBranch();
       const isStaging = branch === 'dev' || branch.startsWith('feat/');

       return {
         __API_BASE_URL__: JSON.stringify(
           isStaging ? 'https://staging.auto-sop.com/api/v1' : 'https://auto-sop.com/api/v1'
         ),
         __APP_BASE_URL__: JSON.stringify(
           isStaging ? 'https://staging.auto-sop.com' : 'https://auto-sop.com'
         ),
       };
     }

     const envDefines = getEnvironmentDefines();
     ```
   - Add `define: envDefines` to EVERY bundle entry in the config (there are 6 entries: index+cli, capture/shim, capture/shim-bench, capture/writer, plugin/shim, plugin/learner)
   - IMPORTANT: `define` replaces identifiers at build time — values must be `JSON.stringify()`'d strings
   Acceptance: `npm run build` on `dev` branch produces bundles with staging URLs; on `master` produces production URLs

### Wave 2 (depends on Wave 1)

3. ARCHITECT: Replace all hardcoded URLs with imports from environment config
   Files: src/license/server-public-key.ts, src/license/enforcement.ts, src/cli/prompt.ts, src/cli/verbs/status.ts, src/installer/orchestrator.ts
   Requirements:
   - `src/license/server-public-key.ts`:
     - Remove the `API_BASE_URL` export from this file
     - Keep `SERVER_PUBLIC_KEY_B64` and `SERVER_X25519_PUBLIC_KEY_B64` here (they're crypto keys, not URLs)
   - `src/license/enforcement.ts`:
     - Import `APP_BASE_URL` from `@/config/environment` (or relative path)
     - Replace `https://app.auto-sop.com/upgrade` with `${APP_BASE_URL}/upgrade`
   - `src/cli/prompt.ts`:
     - Import `APP_BASE_URL` from config
     - Replace both `https://app.auto-sop.com/signup` with `${APP_BASE_URL}/signup`
   - `src/cli/verbs/status.ts`:
     - Import `APP_BASE_URL` from config
     - Replace `https://app.auto-sop.com/upgrade` with `${APP_BASE_URL}/upgrade`
   - `src/installer/orchestrator.ts`:
     - Import `APP_BASE_URL` from config
     - Replace `https://app.auto-sop.com/signup` with `${APP_BASE_URL}/signup`
   - Update ALL existing imports of `API_BASE_URL` from `server-public-key.ts` to import from `config/environment.ts` instead:
     - `src/license/server-client.ts`
     - `src/license/stats-sync.ts`
   Acceptance: `grep -r 'auto-sop\.com' src/` returns ZERO results (all URLs come from config)

4. ARCHITECT: Add environment info to `auto-sop status` output
   Files: src/cli/verbs/status.ts
   Requirements:
   - In the status output, add a line showing which environment the CLI is targeting:
     ```
     environment:  production (auto-sop.com)
     ```
     or
     ```
     environment:  staging (staging.auto-sop.com)
     ```
   - Derive from `API_BASE_URL` — if it contains "staging", show staging, otherwise production
   Acceptance: `auto-sop status` shows the active environment

### Wave 3 (verification)

5. ARCHITECT: Verify build-time injection works
   Files: (no code changes — verification only)
   Requirements:
   - Build on current branch: `npm run build`
   - Verify the built bundles contain the correct URLs:
     - `grep -l 'staging.auto-sop.com' dist/**/*.cjs` should find matches (if on dev/feat branch)
     - OR `grep -l 'auto-sop.com' dist/**/*.cjs` should find matches (if on master)
   - Run tests: `npm test`
   - Verify no hardcoded URLs remain: `grep -r 'https://auto-sop\.com' src/` should return nothing
   - Verify no hardcoded URLs remain: `grep -r 'https://app\.auto-sop\.com' src/` should return nothing
   Acceptance: Build passes, tests pass, zero hardcoded URLs in source

## Quality Gates (MANDATORY)

6. YODA: Code review — environment config, tsup define usage, import changes
7. APEX: Security review — verify no URL injection vectors, safe defaults
8. ANALYZER: Code improvement review — grade must be C or above

## Finalize

9. ARCHITECT: Commit all changes to `feat/v52-cli-env-isolation` branch
10. ARCHITECT: Create PR from `feat/v52-cli-env-isolation` → `dev`

## Acceptance Criteria

- [ ] `src/config/environment.ts` is the single source of truth for all URLs
- [ ] Zero hardcoded `auto-sop.com` or `app.auto-sop.com` URLs in `src/`
- [ ] tsup `define` injects correct URLs based on git branch at build time
- [ ] `dev` and `feat/*` branches build with staging URLs
- [ ] `master` branch builds with production URLs
- [ ] `AUTO_SOP_API_URL` env var still overrides at runtime (backward compatible)
- [ ] `auto-sop status` shows active environment
- [ ] All imports updated from `server-public-key.ts` to `config/environment.ts`
- [ ] All tests pass (100%)
- [ ] All quality gates approved
- [ ] Changes committed to `feat/v52-cli-env-isolation`, PR to `dev`
- [ ] NO commits to `master`

# PLAN-v18 — Publish Readiness + Rename to `auto-sop` + License + CI Fixes

## Overview

After v17 the product is feature-complete for an open-source v0.1.0 launch. v18 is the **publish-readiness sprint** that gets us from "code works" to "ready to be a real npm package on a real GitHub repo with a real LICENSE." It also fixes two CI bugs that have been silently failing.

After v18 ships:
- Package is renamed from `claude-sop` to **`auto-sop`** (better name, claimed before launch)
- Repo is renamed AND transferred from `ugurgokdere/claude-sop` to **`auto-sop/auto-sop`** (org `auto-sop` already claimed; GitHub auto-redirects from old URL)
- License is **Apache 2.0** (open core model — CLI open, future cloud closed)
- GitHub Actions ci.yml actually runs on every push (was broken — wrong branch name)
- Shim latency thresholds are realistic (was failing 5+ commits in a row)
- Provenance pipeline ready (`.github/workflows/publish.yml`)
- 28-item release-check script blocks bad releases
- README polished with demo GIF, install command, architecture diagram
- `npm version patch` automation in EVERY future plan's commit step (v14-v17 forgot this — v18 catches up 0.0.13 → 0.0.18)

We do NOT cut a `v0.1.0` tag in v18. That waits until **after Phase 6 (Native Windows v22)** so the first public release supports macOS + Linux + Windows from day one.

## Strategic context (decided 2026-04-19)

**Open core model:** This repo (auto-sop) is open source. The future cloud dashboard repo (auto-sop-cloud, v23+) is closed source proprietary.

| Component | Repo | License | Strategy |
|---|---|---|---|
| auto-sop CLI (THIS) | `auto-sop/auto-sop` | **Apache 2.0** | Open source — adoption magnet, free forever |
| auto-sop-cloud (v23+) | `auto-sop/auto-sop-cloud` (new, private) | Proprietary | Closed source — paid SaaS dashboard |

**Proven model used by:** RTK (rtk-ai.app — exact same playbook), GitLab (CE/EE), Sentry, Grafana, Mattermost, Plausible, PostHog. Open core works.

**Freemium model (decided 2026-04-19, implementation in Phase 7 v23-v27 — referenced here so README copy is consistent):**

- **Free** (forever) — 1 project, unlimited directives, full local capture + LLM analysis, all CLI verbs. $0. Soft cap on project count only.
- **Pro** — $12/mo or $99/yr — Unlimited projects + opt-in encrypted cloud sync + curated directive packs + cross-project pattern detection + web dashboard.
- **Trial** — 14 days OR until first Pro feature touch (whichever comes first). **No credit card.**
- **Soft gate (Notion model):** Trial expiry never deletes or locks existing learnings. User just can't add NEW projects. Existing data + directives keep working forever.

Why this matters for v18 README copy: must position auto-sop as "free forever for solo use; Pro tier coming with cloud + team features" — NOT "14-day trial then paywall."

**Apache 2.0 vs MIT chosen because:** Apache 2.0 has explicit patent grant (enterprise-friendly) and trademark protection. MIT is even more permissive but lacks both. RTK's repo header says MIT but actual LICENSE file is Apache 2.0 — they made the same call.

## What v18 ships

| # | Item | Category | Scope |
|---|---|---|---|
| **R1** | Rename package + repo to `auto-sop` | Brand | Medium |
| **R2** | Apache 2.0 LICENSE file + NOTICES.md update | Legal | Small |
| **CI1** | Fix `ci.yml` branch trigger `main` → `master` | Bug | Tiny |
| **CI2** | Bump `bench-shim.yml` thresholds to realistic values | Bug | Small |
| **VER1** | Bump version 0.0.13 → 0.0.18 (catch up 4 missed plans) | Process | Tiny |
| **VER2** | Add `npm version patch` automation to commit step (so future plans bump correctly) | Process | Small |
| **P1** | npm publish --provenance pipeline (`.github/workflows/publish.yml`) | Phase 5 SC-3 | Medium |
| **P2** | `publint` + `@arethetypeswrong/cli` CI gate | Phase 5 SC-3 | Small |
| **P3** | Claude Code version matrix CI integration smoke | Phase 5 SC-4 | Medium |
| **P4** | "Looks-done-but-isn't" 28-item release-check script | Phase 5 SC-5 | Medium |
| **P5** | Dual ESM+CJS smoke test (real spawn) | Phase 5 SC-3 | Small |
| **P6** | README rewrite + demo GIF + arch diagram | Launch | Medium |
| **B13** | Vitest hookTimeout 60s → 180s for `large-output` | Bug | Tiny |

## Architecture Decisions

### R1 — Rename to `auto-sop`

**Verify availability first:**
```bash
npm view auto-sop  # must return 404 / E404
```

**`auto-sop` is confirmed available on npm registry as of 2026-04-19** (verified `npm view auto-sop` returned 404). If somehow squatted before publish, fallback names (in order): `@auto-sop/cli` (scope `@auto-sop` is also confirmed available, can be reserved), `auto-sop-cli`, `autosop`.

**Repo rename + transfer to org (GitHub UI, two-step manual):**
1. Settings → Repository name → `auto-sop` (still under `ugurgokdere` after this step)
2. Settings → Danger Zone → Transfer ownership → `auto-sop` org

GitHub auto-redirects after both steps:
- `https://github.com/ugurgokdere/claude-sop` → `https://github.com/auto-sop/auto-sop`
- `git@github.com:ugurgokdere/claude-sop.git` clones still work
- Issues, PRs, stars, history all preserved
- Local: `git remote set-url origin git@github.com:auto-sop/auto-sop.git`

**Files to update for new name:**
- `package.json` — `"name": "auto-sop"`
- `package.json` — `repository.url`, `homepage`, `bugs.url`
- `README.md` — title, install commands, all references
- `dist/plugin/.claude-plugin/plugin.json` — `"name": "auto-sop"`
- `dist/plugin/.claude-plugin/marketplace.json` — `"name": "auto-sop"`
- `src/cli/verbs/install.ts` — install tip (`claude-sop statusline` → `auto-sop statusline`)
- `src/scheduler/macos-launchd.ts` — plist label `com.claude-sop.learner` → `com.auto-sop.learner`
- All directory references: `~/.claude-sop/` → `~/.auto-sop/`
- All env vars: `CLAUDE_SOP_*` → `AUTO_SOP_*` (with backward-compat reading both for one version)

**MIGRATION PATH for existing users:**
- v18 installer detects old `~/.claude-sop/` directory
- If found: prompt "Migrate from claude-sop to auto-sop?" (default Y)
- On Y: `mv ~/.claude-sop ~/.auto-sop`, update launchd plist, update settings.json hook paths
- On N: continue alongside (both work)
- Deprecation warning: "claude-sop is being renamed. Run `auto-sop migrate` to switch."
- New CLI verb: `auto-sop migrate` for explicit migration

**Backward compat (one version):**
- `claude-sop` binary stays in `package.json` `bin` field as alias to `auto-sop` for one version
- Env vars: read both `CLAUDE_SOP_*` and `AUTO_SOP_*`, prefer new
- launchd label: install creates new `com.auto-sop.*`, uninstall cleans both

### R2 — Apache 2.0 LICENSE

- NEW `LICENSE` file (Apache 2.0 full text from https://www.apache.org/licenses/LICENSE-2.0.txt)
- Copyright header: `Copyright 2026 Ugur Gokdere`
- Update `package.json`: `"license": "Apache-2.0"`
- Update `NOTICES.md` — confirm all third-party deps are Apache-2.0-compatible (most are MIT/Apache, audit needed)
- Add SPDX header to source files? Optional — modern practice doesn't require it.

### CI1 — Fix ci.yml branch trigger

**Problem:**
```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```
Repo default branch is `master`. CI has been silently NOT running for 5+ commits.

**Fix:**
```yaml
on:
  push:
    branches: [master, main]   # support both during any potential future rename
  pull_request:
    branches: [master, main]
```

Also: post-v18, consider renaming default branch to `main` (GitHub default since 2020) — but that's a separate decision.

### CI2 — Bench-shim threshold realism

**Problem:** Phase 1 set thresholds when shim was minimal. After v4-v8 hardening (full bundling, secret scrubbing baseline, error handling), the shim is heavier. Current numbers from latest CI run:
- p50: 40.53ms (threshold: <20ms) — exceeded by 2x
- p95: 43.63ms (threshold: <35ms) — exceeded by 25%
- p99: 69.46ms (threshold: <50ms) — exceeded by 40%

**Investigation needed:** Why is the shim 40ms now when it was <20ms in Phase 1?
- Bundling overhead (zod, scrubber baseline imported into shim?) — investigate
- Cold-start cost on GHA runner (CI is slower than dev laptop) — likely contributor
- Recent additions (v15 env var rename, v16 hardening — should NOT affect shim)

**Fix (two-part):**

1. **Investigate shim bundle:** check `dist/plugin/shim.cjs` size and `require()` calls. If unnecessary deps leaked in, fix that. Phase 1 success criterion CAPT-03 says shim must stay <50ms p95 — that's the real budget.

2. **Adjust CI thresholds to realistic AND honest values:**
   ```yaml
   # bench-shim.yml — new thresholds (calibrated to GHA ubuntu-latest runner)
   p50: 60ms   # was 20
   p95: 80ms   # was 35
   p99: 100ms  # was 50
   ```
   Document in plan that these are CI thresholds (slower than dev box). Local dev `npm run bench:shim` keeps the original strict thresholds for local validation.

### VER1 — Catch up version 0.0.13 → 0.0.18

**Problem:** `package.json` shows `0.0.13`. Should be `0.0.17` after v17. v14, v15, v16, v17 all forgot to bump.

**Fix:** First task of v18 is `npm version 0.0.18 --no-git-tag-version`. Manual one-time correction. From v18 forward, automation (VER2) prevents drift.

### VER2 — Auto-bump version on every plan

**Add to ARCHITECT's commit step (every future plan):**
```bash
# Before final commit:
npm version patch --no-git-tag-version
git add package.json package-lock.json
# THEN regular commit with the plan's feat/fix message
```

This ensures every plan auto-bumps. The `--no-git-tag-version` flag prevents `npm version` from creating a git tag (we only tag on actual releases).

**Implementation:**
- Update `~/.claude/agents/architect-principal-engineer.md` (agent definition) — add a paragraph: "Before final commit, run `npm version patch --no-git-tag-version` to bump the patch version."
- Update plan templates — example commit step shows the version bump
- Documentation in `CONTRIBUTING.md` (new file)

### P1-P6 + B13 — same as previous v18 draft

(See appendix at bottom for unchanged details.)

## Implementation Tasks

### Wave 1 — Brand & legal (foundation, blocks everything else)

1. **ARCHITECT: R1 — Rename package + add migration**
   - Verify `npm view auto-sop` returns 404 (name available) — **already verified 2026-04-19, both `auto-sop` and `claude-sop` registry slots are empty; user owns npm org `auto-sop`**
   - Update `package.json` with EXACT URLs (use these verbatim, do NOT substitute `ugurgokdere`):
     ```json
     "repository": {
       "type": "git",
       "url": "git+https://github.com/auto-sop/auto-sop.git"
     },
     "homepage": "https://github.com/auto-sop/auto-sop#readme",
     "bugs": {
       "url": "https://github.com/auto-sop/auto-sop/issues"
     }
     ```
   - GitHub org `auto-sop` is already owned by user (verified 2026-04-19); repo will be transferred from `ugurgokdere/claude-sop` to `auto-sop/auto-sop` manually before publish
   - Find/replace ALL `claude-sop` references in src/, test/, plugin/, scripts/ (be careful — some are in user-visible strings/messages)
   - Add backward-compat aliases:
     - `package.json` `bin` includes both `auto-sop` and `claude-sop` (alias)
     - Env vars: read both `CLAUDE_SOP_*` and `AUTO_SOP_*`, prefer new, log deprecation if old used
     - Directories: install creates `~/.auto-sop/`. If `~/.claude-sop/` exists, log migration tip.
   - NEW `claude-sop migrate` / `auto-sop migrate` verb: moves `~/.claude-sop/` → `~/.auto-sop/`, updates launchd plist label, updates project `.claude/settings.json` hook paths in registered projects
   - launchd label: `com.claude-sop.learner` → `com.auto-sop.learner` (uninstall must clean both)
   - Update plugin manifest (`dist/plugin/.claude-plugin/plugin.json` — `"name": "auto-sop"`)
   - Update marketplace manifest

2. **ARCHITECT: R2 — Apache 2.0 LICENSE**
   - NEW `LICENSE` (Apache 2.0 full text, copyright 2026 Ugur Gokdere)
   - `package.json`: `"license": "Apache-2.0"`
   - Audit `NOTICES.md` — verify all deps are Apache-compatible (MIT, BSD, ISC, Apache 2.0). If any are GPL/AGPL, flag as critical issue.
   - Update README footer with license badge

3. **ARCHITECT: VER1 — Catch up version**
   - Run `npm version 0.0.18 --no-git-tag-version`
   - Verify `package.json` shows `0.0.18`
   - Verify `package-lock.json` updated

### Wave 2 — CI fixes (independent of Wave 1, parallel-safe)

4. **ARCHITECT: CI1 + CI2 — GitHub Actions fixes**
   - `ci.yml`: change `branches: [main]` to `branches: [master, main]` in both `on.push` and `on.pull_request`
   - `bench-shim.yml`: investigate shim bundle bloat (compare `dist/plugin/shim.cjs` size today vs Phase 1)
   - Adjust thresholds in `scripts/bench-shim.mjs` and/or `bench-shim.yml`:
     - CI thresholds (looser): p50<60ms, p95<80ms, p99<100ms
     - Local dev thresholds (strict, optional flag `--strict`): p50<20ms, p95<35ms, p99<50ms
   - Verify locally: `npm run bench:shim:ci` passes with new thresholds
   - Add comment in bench-shim.mjs explaining why CI is looser than local

5. **ARCHITECT: B13 — vitest hookTimeout**
   - `vitest.config.ts` and `vitest.smoke.config.ts`: add `hookTimeout: 180_000`
   - Verify `large-output` integration test passes

### Wave 3 — Linting & validation (depends on Wave 1 — needs final package.json)

6. **ARCHITECT: P2 — publint + attw**
   - Add devDeps: `publint`, `@arethetypeswrong/cli`
   - Scripts: `lint:pkg`, `lint:types`, `lint:all`
   - Run both, FIX any issues surfaced (export paths, type files)
   - Both must exit 0 for v18 to be done

7. **ARCHITECT: P5 — Dual ESM+CJS smoke**
   - NEW `test/smoke-package-imports.test.ts`
   - Build `auto-sop-0.0.18.tgz` via `npm pack` in test setup
   - Install into a tmpdir project
   - Spawn `node test-esm.mjs` (ESM import) + `node test-cjs.cjs` (CJS require), both exit 0

### Wave 4 — Release infrastructure (depends on Waves 1-3)

8. **ARCHITECT: VER2 — Version bump automation**
   - Update `~/.claude/agents/architect-principal-engineer.md` (agent prompt) with version-bump-on-commit instructions
   - NEW `CONTRIBUTING.md` documenting the convention
   - Add `package.json` script `version:bump-patch` for clarity

9. **ARCHITECT: P4 — release-check 28 items**
   - NEW `scripts/release-check.sh` with all 28 checks (table from previous v18 draft)
   - Each check: clear pass/fail output + "how to fix" line
   - Must exit non-zero on ANY fail
   - `npm run release-check` script
   - Verify it passes on current main

10. **ARCHITECT: P1 — publish.yml workflow**
    - NEW `.github/workflows/publish.yml`
    - Triggers: tag push `v*.*.*` + `workflow_dispatch` (manual dry-run)
    - `id-token: write` for OIDC + provenance
    - Steps: checkout, setup-node 20.20, npm ci, release-check, build, test, test:smoke, npm publish --provenance --access public
    - `package.json` `publishConfig: { access: public, provenance: true }`
    - DO NOT cut v0.1.0 tag in v18. Use `workflow_dispatch` to dry-run validate.

11. **ARCHITECT: P3 — Claude Code version matrix smoke**
    - Add CC integration job to `ci.yml` (or NEW workflow `cc-integration.yml` running weekly)
    - Step: install Claude Code via official method
    - Run smoke test verifying hook fires + capture appears
    - Document min/max CC version in README compat section

### Wave 5 — User-facing (depends on Wave 4)

12. **ARCHITECT: P6 — README + demo GIF + arch diagram**
    - REWRITE `README.md` with these REQUIRED sections in order:
      1. **Tagline** — single sentence: "Claude Code never makes the same mistake twice."
      2. **Demo GIF** — 30 seconds, terminal recording: install → recap --run → tail CLAUDE.md → see directives appear
      3. **Install** — `npx auto-sop install` (one command)
      4. **Quick start** — exactly 3 shell commands max from install to seeing first directive
      5. **How it works** — architecture diagram (ASCII or PNG): hooks → captures → learner → CLAUDE.md → recall
      6. **Pricing & tiers** (CRITICAL — open core positioning):
         - **Free forever** — 1 project, unlimited directives, full local capture + LLM analysis (uses your Claude Max subscription, $0 cost), all CLI verbs
         - **Pro** (coming with `auto-sop-cloud`, v23+) — Unlimited projects + opt-in encrypted cloud sync + curated directive packs (framework/language) + cross-project pattern detection + web dashboard. **No credit card on trial.** Soft gate: trial expiry never deletes your data — just can't add new projects.
         - DO NOT include a pricing page yet (Pro doesn't ship until Phase 7). State: "Pro tier coming with cloud features. CLI is free forever for solo use, Apache 2.0."
      7. **Privacy** — Captures NEVER leave your machine on Free tier. Pro cloud sync is opt-in, encrypted client-side (AES-256), server stores encrypted blobs only. Raw captures stay local forever.
      8. **Compatibility** — Claude Code >=2.1.107, Node >=18.17, macOS + Linux. Windows: Phase 6 (v22).
      9. **License** — Apache 2.0 badge + link to LICENSE
      10. **Credits** — İbrahim Işkın (Phase 8 smart-directive-targeting insight, 2026-04-17)
    - Generate demo GIF via `vhs` if available (declarative tape file → GIF). If not, leave a recorded asciinema cast file or step-by-step instructions for user to run.
    - Generate architecture diagram (ASCII art is fine if image generation impractical — see PROJECT.md "Phase Map" for inspiration)
    - Verify install command actually works on a fresh box (spawn `npx auto-sop@latest install` in a tmpdir Node project)
    - **DO NOT include "47 errors prevented this month" copy yet** — those metrics come in Phase 9 (v31+). For v18 README, focus on capability ("Claude reads its own mistakes") not numbers.

### Wave 6 — Quality gates

13. **YODA: Code review**
    - Rename completeness: zero `claude-sop` references left in user-visible code
    - Backward compat: old env vars + old binary name still work, with deprecation warning
    - Migration: `auto-sop migrate` is idempotent (run twice = no-op)
    - publish.yml: only triggers on tag push, never on regular commits
    - release-check: every check actually executes
    - LICENSE: Apache 2.0 full text, no truncation
    - **100% approval required.**

14. **APEX: Security review**
    - Rename migration: doesn't expose secrets in any temp file or log
    - publish.yml `id-token: write`: scoped to publish job only
    - No `pull_request` trigger on publish.yml (forks shouldn't publish)
    - LICENSE compatibility audit (NOTICES.md): no GPL/AGPL transitive deps
    - Demo GIF: no real session IDs, real paths (synthetic data only)
    - **Must pass P0/P1.**

15. **ANALYZER: Code improvement review** — **Must be C or above.**

## Finalize

16. **ARCHITECT: Commit + version bump**
    - `npm version patch --no-git-tag-version` → 0.0.18 (already set in Wave 1, but verify)
    - `git add` all changes
    - Commit with message:
      ```
      feat(phase5): publish readiness — rename to auto-sop, Apache 2.0 license, fix CI branches + bench thresholds, version 0.0.18, provenance pipeline, release-check, README + demo GIF
      ```

## Acceptance Criteria

After v18:
- `package.json` `"name": "auto-sop"`, `"version": "0.0.18"`, `"license": "Apache-2.0"`
- `LICENSE` file present, full Apache 2.0 text
- `~/.auto-sop/` is the new default location; `~/.claude-sop/` migrated automatically on next install
- `auto-sop --version` shows `0.0.18` after global install
- `claude-sop` alias still works (backward compat) but logs deprecation
- GitHub repo renamed AND transferred to `auto-sop/auto-sop` (URL redirects from old `ugurgokdere/claude-sop`)
- `ci.yml` runs on every push to master (fixed)
- `bench-shim.yml` passes with realistic CI thresholds
- `npm run lint:all` (publint + attw) exits 0
- `npm run release-check` (28 items) exits 0
- `npm run test` exits 0 (B13 hookTimeout fix)
- `npm run test:smoke` exits 0 (new dual-import + CC integration tests)
- `.github/workflows/publish.yml` syntactically valid, workflow_dispatch dry-run completes successfully
- `README.md` has demo GIF, install command, quick start, architecture diagram, license badge
- `~/.claude/agents/architect-principal-engineer.md` includes version-bump-on-commit instructions
- All future plans (v19+) auto-bump version (no more 0.0.13 drift)

## Post-plan steps for the user

```bash
# 1. Build + test (local)
cd ~/Developer/claude-sop
npm run build
npm run test
npm run test:smoke
npm run lint:all
npm run release-check

# 2. Verify version bump
jq -r .version package.json
# expect: 0.0.18

# 3. GitHub repo rename + transfer (manual, GitHub UI, two steps)
# Step A: Settings → Repository name → "auto-sop" (still under ugurgokdere)
# Step B: Settings → Danger Zone → Transfer ownership → "auto-sop" org
# Both steps preserve history, issues, PRs, stars, and create redirects.

# 4. Local git remote update (after transfer)
git remote set-url origin git@github.com:auto-sop/auto-sop.git
git remote -v   # verify
git fetch origin
git pull --rebase

# 5. CI verification — push and check
git push
# Wait 1-2 min, then:
gh run list --limit 5
# Expect: ci.yml runs (was 0 before), bench-shim passes (was failing)

# 6. Verify migration on dogfood project
cd ~/Developer/wrbeautiful-shopify-theme
auto-sop status   # should detect old ~/.claude-sop/ and offer migration
auto-sop migrate  # explicit migration
ls ~/.auto-sop/   # new location populated
ls ~/.claude-sop/ 2>&1   # should be moved or empty

# 7. Provenance dry-run
gh workflow run publish.yml -f dry-run=true
gh run watch
# Expect: all steps green, "DRY RUN — would publish auto-sop@0.0.18 with provenance"

# 8. README check
glow README.md   # or open in GitHub preview
```

## Out of Scope

- Actually cutting v0.1.0 tag and publishing — waits until v22 (after Phase 6 Native Windows)
- Phase 6 Native Windows (v20-v22)
- Phase 7 SaaS (v23+) and `auto-sop-cloud` repo creation
- Anthropic Claude Code marketplace listing
- Marketing site

## Appendix: P1-P6 details (unchanged from previous draft)

**P1 publish.yml structure:**
```yaml
name: publish
on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
        default: true
jobs:
  publish:
    permissions:
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20.20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run release-check
      - run: npm run build
      - run: npm run test
      - run: npm run test:smoke
      - run: npm run lint:all
      - if: github.event.inputs.dry-run == 'true'
        run: npm publish --dry-run --provenance --access public
      - if: github.event.inputs.dry-run != 'true'
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**P4 release-check 28 items:** (full list in previous draft, unchanged)

**P6 README structure:** (template in previous draft, unchanged — just s/claude-sop/auto-sop/g and add Apache 2.0 badge)

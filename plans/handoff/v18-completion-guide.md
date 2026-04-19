# V18 Completion Handoff Guide

**Created**: 2026-04-19 by JONATHAN
**Trigger**: Run AFTER Commander commits v18 and moves PLAN-v18 to `plans/done/`
**Estimated time**: 15-25 min total (most steps are < 2 min each)

---

## Pre-flight Verification

Before starting any of the steps below, confirm v18 is actually done:

```bash
cd /Users/ugurgokdere/Developer/claude-sop
git log --oneline -3                 # expect newest commit to be v18 feat()
ls plans/queued/                     # expect: empty (or no PLAN-v18-*)
ls plans/done/ | grep v18            # expect: PLAN-v18-*.md present
ls PLAN.md                           # expect: NOT FOUND (Commander deletes after commit)
jq -r .version package.json          # expect: 0.0.18
jq -r .name package.json             # expect: auto-sop
jq -r .license package.json          # expect: Apache-2.0
test -f LICENSE && echo "✓ LICENSE present"
test -f README.md && echo "✓ README present"
```

If any check fails, **stop**. Re-attach to dev-army session and investigate (`tmux attach -t dev-army-claude-sop`).

---

## Step 1: GitHub Repo Rename + Transfer (UI, 5 min)

### 1A. Rename `claude-sop` → `auto-sop` (still under `ugurgokdere`)

1. Go to: https://github.com/ugurgokdere/claude-sop/settings
2. Top section: **Repository name**
3. Change `claude-sop` → `auto-sop`
4. Click **Rename** button
5. Confirm dialog

**What this does:**
- New URL: `https://github.com/ugurgokdere/auto-sop`
- Old URL `https://github.com/ugurgokdere/claude-sop` → automatic 301 redirect
- Issues, PRs, stars, forks, history: all preserved
- Webhooks, deploy keys, secrets: preserved

**Verification:**
```bash
gh repo view ugurgokdere/auto-sop --json name,owner,visibility | jq
# expect: name=auto-sop, owner.login=ugurgokdere
```

### 1B. Transfer `ugurgokdere/auto-sop` → `auto-sop/auto-sop` (org)

1. Go to: https://github.com/ugurgokdere/auto-sop/settings
2. Scroll to bottom: **Danger Zone**
3. Find: **Transfer ownership**
4. Click **Transfer**
5. In dialog:
   - **New owner's GitHub username or organization name**: `auto-sop`
   - **Type the name of the repository to confirm**: `auto-sop`
6. Click **I understand, transfer this repository**

**What this does:**
- New URL: `https://github.com/auto-sop/auto-sop`
- Old URLs (both `ugurgokdere/claude-sop` and `ugurgokdere/auto-sop`) → 301 redirect
- Repo stays **private** by default (organization permissions inherited)
- Issues, PRs, stars: preserved (some old issue assignees may need re-add if they're not org members)

**Verification:**
```bash
gh repo view auto-sop/auto-sop --json name,owner,visibility,description | jq
# expect: name=auto-sop, owner.login=auto-sop, visibility=PRIVATE
```

### 1C. (Optional) Make Public Later

User decision: keep private for now, make public when ready to launch v0.1.0 (after v22 Native Windows).

To make public when ready:
1. https://github.com/auto-sop/auto-sop/settings
2. Bottom: **Danger Zone** → **Change repository visibility**
3. Click **Change visibility** → **Make public**
4. Type repo name to confirm

---

## Step 2: Local Git Remote Update (1 min)

After Step 1 transfer is complete:

```bash
cd /Users/ugurgokdere/Developer/claude-sop

# 2A. Update remote URL
git remote -v   # show current
# expect: origin https://github.com/ugurgokdere/claude-sop.git (current)

git remote set-url origin git@github.com:auto-sop/auto-sop.git
# (using SSH; if you prefer HTTPS, use: https://github.com/auto-sop/auto-sop.git)

git remote -v   # verify
# expect: origin git@github.com:auto-sop/auto-sop.git

# 2B. Test fetch
git fetch origin
# expect: no errors, no new commits (we're in sync)

# 2C. Verify push works (does NOT actually push, --dry-run)
git push --dry-run origin master
# expect: "Everything up-to-date" or actual push would proceed cleanly
```

If `git fetch` fails with "repository not found": SSH key may not have access to `auto-sop` org. Two fixes:
- **Quick**: Switch to HTTPS: `git remote set-url origin https://github.com/auto-sop/auto-sop.git` (uses your gh CLI credentials via gh-credential-helper)
- **Proper**: Add your SSH key to `auto-sop` org permissions, or use a deploy key

---

## Step 3: NPM Org Ownership Transfer (OPTIONAL, 3 min)

**Decision required from user**: Do you want `auto-sop` and `claude-sop` packages to be owned by the `auto-sop` org instead of just `ugurgokdere` user?

**Recommendation**: YES — simplifies v22 OIDC trustedPublisher setup, makes packages appear on `npmjs.com/org/auto-sop` page.

### 3A. Create Org Team (if doesn't exist)

```bash
npm team ls auto-sop                       # check existing teams
npm team create auto-sop:developers         # create if missing
npm team add auto-sop:developers ugurgokdere   # add yourself explicitly
```

### 3B. Add Team as Package Owner

```bash
npm owner add auto-sop:developers auto-sop
npm owner add auto-sop:developers claude-sop

# Verify
npm owner ls auto-sop
# expect: 2 owners — ugurgokdere AND auto-sop:developers
npm owner ls claude-sop
# expect: 2 owners — ugurgokdere AND auto-sop:developers
```

### 3C. (Optional) Remove Personal Ownership Later

Once team ownership is verified working, you can transfer-then-remove personal:

```bash
# DO NOT do this until you're 100% sure team works
# npm owner rm ugurgokdere auto-sop
# npm owner rm ugurgokdere claude-sop
```

Recommendation: keep BOTH (you + team) for safety. No downside.

---

## Step 4: GitHub Branch Protection (5 min)

After transfer, configure branch protection on `master` to enforce quality gates.

1. Go to: https://github.com/auto-sop/auto-sop/settings/branches
2. Click **Add branch protection rule**
3. Branch name pattern: `master`
4. Enable:
   - ☑ **Require a pull request before merging**
     - Required approving reviews: 1
     - Dismiss stale approvals when new commits pushed
   - ☑ **Require status checks to pass before merging**
     - Require branches to be up to date before merging
     - Status checks (search and add as they appear after first CI run):
       - `lint`
       - `test`
       - `test:smoke`
       - `bench:shim` (after v18's CI fix)
       - `publint`
       - `attw` (arethetypeswrong)
   - ☑ **Require conversation resolution before merging**
   - ☑ **Require signed commits** (optional, but recommended for open source)
   - ☑ **Include administrators** (so you also follow rules — important for solo maintainer)
   - ☐ **Allow force pushes** (LEAVE UNCHECKED)
   - ☐ **Allow deletions** (LEAVE UNCHECKED)
5. **Create**

**Note**: First CI run after transfer needs to complete before you can add status checks. Easy workflow:
- Make a tiny commit (e.g., docs typo) on a branch, open PR, watch CI run, get the check names
- Then come back here and add them to branch protection

---

## Step 5: NPM OIDC Trusted Publisher (PREP for v22, 5 min)

**v22 publish workflow uses GitHub Actions OIDC for npm publish (no NPM_TOKEN secret needed).** Setup must be done in npm web UI per package.

### Per Package: `auto-sop`

1. Go to: https://www.npmjs.com/package/auto-sop/access
   (Or: package page → Settings → Publishing access)
2. Find: **Trusted publishers**
3. Click **Add trusted publisher**
4. Provider: **GitHub Actions**
5. Fields:
   - **Organization or user**: `auto-sop`
   - **Repository**: `auto-sop`
   - **Workflow filename**: `publish.yml`
   - **Environment name**: `npm-publish` (must match `environment:` in publish.yml job)
6. Click **Add**

### Per Package: `claude-sop`

Same as above, with `Repository: auto-sop` (not claude-sop — claude-sop is just the alias package, published from same repo).

### Verification (after v22 first publish)

When v22's publish.yml runs, npm dashboard should show:
- ✅ Published with provenance
- ✅ Trusted publisher: `auto-sop/auto-sop@.github/workflows/publish.yml`

If npm rejects publish: usually means `environment:` value in publish.yml doesn't match what you typed in npm UI.

### Critical: Environment in publish.yml

V18 created publish.yml. Verify the publish job has:

```yaml
jobs:
  publish:
    environment: npm-publish    # ← must match npm UI exactly
    permissions:
      id-token: write           # ← APEX SEC-001 fix moved this to job level
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm run release-check
      - run: npm publish --access public --provenance
```

The `--provenance` flag + OIDC `id-token: write` permission produces SLSA Build L3 attestation visible on npm.

---

## Step 6: GitHub Actions Environment Setup (5 min)

If you used `environment: npm-publish` in publish.yml (recommended), you need to create that environment in GitHub repo settings.

1. https://github.com/auto-sop/auto-sop/settings/environments
2. Click **New environment**
3. Name: `npm-publish`
4. (Optional but recommended) Enable:
   - ☑ **Required reviewers**: add yourself
   - ☑ **Wait timer**: 0 (no delay)
   - ☑ **Deployment branches**: only `master` and tags `v*.*.*`
5. **No secrets needed** — OIDC handles auth via npm trusted publisher
6. Click **Configure environment**

This adds a manual approval step to publish: when v22 tags a release, the publish job pauses until you approve. Good safety net for first few releases.

---

## Step 7: Local Folder Rename (DEFERRED to v19)

Local folder is still `~/Developer/claude-sop`. After Step 1, GitHub repo is `auto-sop/auto-sop`. Mismatch is cosmetic only — does not break anything.

**v19 task candidate**: rename local folder + update any open IDE workspaces. Don't do it now to avoid disrupting in-flight terminal sessions.

---

## Step 8: Sanity Check Everything Together

```bash
cd /Users/ugurgokdere/Developer/claude-sop

# Identity check
echo "=== Local folder ==="
basename "$PWD"
echo "=== Package name ==="
jq -r .name package.json
echo "=== Git remote ==="
git remote get-url origin
echo "=== Latest commit ==="
git log --oneline -1
echo "=== npm view ==="
npm view auto-sop name version dist-tags maintainers 2>&1 | head -5
echo "=== npm owner ==="
npm owner ls auto-sop
echo "=== gh repo ==="
gh repo view auto-sop/auto-sop --json name,owner,visibility,description 2>&1 | jq
```

Expected:
- Local folder: `claude-sop` (deferred rename)
- Package: `auto-sop@0.0.18`
- Remote: `git@github.com:auto-sop/auto-sop.git`
- Latest commit: v18 feat() commit
- npm view: `auto-sop@0.0.0-placeholder.0` (until v22 publishes 0.0.18)
- npm owner: `ugurgokdere` AND `auto-sop:developers` (if you did Step 3)
- gh repo: `name=auto-sop, owner=auto-sop, visibility=PRIVATE`

---

## Rollback Procedures (if something goes wrong)

### Rollback GitHub Transfer

If you accidentally transferred wrong:
1. https://github.com/auto-sop/auto-sop/settings → **Danger Zone** → **Transfer ownership**
2. New owner: `ugurgokdere`
3. Confirm

GitHub keeps redirects in both directions, so old links keep working.

### Rollback npm Owner Add

```bash
npm owner rm auto-sop:developers auto-sop
npm owner rm auto-sop:developers claude-sop
```

### Rollback git remote

```bash
git remote set-url origin https://github.com/ugurgokdere/auto-sop.git
# (or https://github.com/ugurgokdere/claude-sop.git — both still work via redirect)
```

---

## What Comes After v18 Completion

| Phase | Plan | Trigger |
|---|---|---|
| **Dogfood observation window** | 1-3 days, watch wrbeautiful-shopify-theme + sahibinden-scraper | After v18 done |
| **v19** | Auto-bump version automation real-world test, fix small issues found in dogfood | After 1-3 day observation |
| **v20-v22** | Native Windows support (Phase 6) — Task Scheduler, .cmd shims, NTFS ACL, CI matrix | After v19 |
| **v0.1.0 GitHub release tag** | First public release, publish to npm with `latest` tag (replaces placeholder) | End of v22 |
| **v23-v27** | Phase 7 SaaS Platform — `auto-sop-cloud` repo bootstrap, Supabase/Clerk/Stripe, Notion-style soft-gate freemium | After v22 |
| **v28-v30** | Phase 8 Smart Directive Targeting — scope classification, skill files, migration tool | After v27 |
| **v31-v33** | Phase 9 Metrics & Social Proof — directive-fire detection, savings tracker, landing page | After v30 |

---

## Open Questions / Decisions Needed Before v19

1. **Local folder rename**: When? (v19 small task vs. ad-hoc)
2. **npm org ownership transfer**: Step 3 done now, or wait for v22?
3. **Domain registration**: `auto-sop.dev` for landing page? When? (Phase 9 v31+)
4. **Marketplace listing**: Submit to Claude Code Marketplace? When? (after v0.1.0 tag)
5. **Demo GIF**: Record now (v18 stable) or wait for v0.1.0 polish?
6. **`auto-sop-cloud` repo**: Create empty placeholder now (claim name) or wait until v23 (recommended B from earlier discussion)?

JONATHAN will turn answers into v19+ plan inputs.

---

*Generated by JONATHAN, 2026-04-19, while v18 was in quality-gate fix loop. Update if anything changes.*

# V22: README Badges + npm Metadata + Publish Workflow + Homebrew Prep

## Overview
Prepare everything for the eventual first npm release — polished README, proper npm metadata, hardened publish workflow, and Homebrew tap bootstrap. This is NOT the publish version (that's v26, after Native Windows lands in v23-v25). This version gets all the packaging infrastructure ready so v26 is a one-tag publish.

## Architecture Decisions
- **No version bump yet**: Stay on `0.0.x` — the `0.1.0` bump happens in v26 when we actually publish. Auto-bump hook keeps incrementing patch.
- **No npm publish yet**: Actual publish is v26 (after Windows in v23-v25). v22 just hardens the workflow so publish is one-tag when ready.
- **`claude-sop` redirect**: Already published as placeholder. Keep as-is for now.
- **Homebrew**: v22 bootstraps the tap staging area with an npm-based formula. Real tap repo creation happens at v26 publish time.
- **No Discord badge**: User explicitly excluded Discord. Star History + Contributors only.

## Implementation Tasks

### Wave 1 (parallel — no dependencies)

1. ARCHITECT: README badge row + bottom sections
   Files: `README.md`
   Requirements:
   - Replace the existing badge block (lines 1-3) with an expanded set:
     ```markdown
     [![CI](https://github.com/auto-sop/auto-sop/actions/workflows/ci.yml/badge.svg)](https://github.com/auto-sop/auto-sop/actions/workflows/ci.yml)
     [![npm version](https://img.shields.io/npm/v/auto-sop)](https://www.npmjs.com/package/auto-sop)
     [![npm downloads](https://img.shields.io/npm/dm/auto-sop)](https://www.npmjs.com/package/auto-sop)
     [![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
     [![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)](https://nodejs.org)
     ```
   - Add a "Star History" section before the License section at the bottom:
     ```markdown
     ## Star History

     [![Star History Chart](https://api.star-history.com/svg?repos=auto-sop/auto-sop&type=Date)](https://star-history.com/#auto-sop/auto-sop&Date)
     ```
   - Add a "Contributors" section after Star History (uses StarMapper-style contrib image):
     ```markdown
     ## Contributors

     [![Contributors](https://contrib.rocks/image?repo=auto-sop/auto-sop)](https://github.com/auto-sop/auto-sop/graphs/contributors)
     ```
   - Add Homebrew install option to the Install section:
     ```markdown
     ## Install

     ```bash
     npx auto-sop install
     ```

     Or via Homebrew (macOS/Linux):

     ```bash
     brew install auto-sop/tap/auto-sop
     ```
     ```
     Note: Homebrew formula will be available after tap is published. Show both options now so README doesn't need another update later.
   - Update Compatibility table: change Windows row from "Phase 6 (v22)" to "Phase 6 (planned)" since Windows is not in v22
   - Add `keywords` context: ensure the README has enough keyword density for npm search (auto-sop, claude, claude-code, CLAUDE.md, directives, self-improving, AI agent)
   Acceptance: README has 5+ badges, Star History chart, Contributors section, dual install options, updated Windows row.

2. ARCHITECT: npm package.json metadata polish
   Files: `package.json`
   Requirements:
   - Add `keywords` array (npm search optimization):
     ```json
     "keywords": [
       "claude",
       "claude-code",
       "claude-md",
       "ai-agent",
       "self-improving",
       "directives",
       "sop",
       "standard-operating-procedures",
       "developer-tools",
       "code-quality",
       "automation"
     ]
     ```
   - Improve `description` to be more searchable:
     ```json
     "description": "Make Claude Code self-improving — auto-detect recurring mistakes and write enforced CLAUDE.md directives"
     ```
   - Verify these fields are correct (read-only check, fix if wrong):
     - `repository.url` → `https://github.com/auto-sop/auto-sop.git`
     - `homepage` → `https://github.com/auto-sop/auto-sop#readme`
     - `bugs.url` → `https://github.com/auto-sop/auto-sop/issues`
     - `author` → should exist (add `"Ugur Gokdere <ugokdere@gmail.com>"` if missing)
     - `engines.node` → `">=18.17"`
   - Do NOT change `version` field yet (that happens in Wave 2)
   Acceptance: `npm pack --dry-run` shows correct metadata. `publint` passes. No missing fields.

3. ARCHITECT: Switch npm publish to OIDC trustedPublisher
   Files: `.github/workflows/publish.yml`
   Requirements:
   - The workflow already has `id-token: write` permission — good.
   - Remove `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` from both publish steps.
   - Add npm provenance config that uses OIDC instead of token:
     ```yaml
     - name: Configure npm for provenance publishing
       run: |
         echo "//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}" >> .npmrc
       env:
         NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
     ```
     Actually, **keep the NPM_TOKEN approach** but ensure `--provenance` flag is present (it already is). Full OIDC trustedPublisher requires npm account configuration on npmjs.com which is a manual step.
   - Instead, add these improvements to the publish workflow:
     a) Add a `release-check` step that runs `npm run release-check` before publish
     b) Add a `test` step that runs `npm test` before publish
     c) Add a step that creates a GitHub Release with auto-generated release notes when a tag is pushed:
       ```yaml
       - name: Create GitHub Release
         if: startsWith(github.ref, 'refs/tags/v')
         uses: softprops/action-gh-release@v2
         with:
           generate_release_notes: true
       ```
     d) Add `contents: write` permission (needed for GitHub Release creation)
   - Document in a comment: "To enable full OIDC trustedPublisher, configure on npmjs.com → Package Settings → Publishing access → Add trusted publisher (GitHub Actions)"
   Acceptance: `publish.yml` has test + release-check gates before publish. GitHub Release step present. Provenance flag present.

### Wave 2 (depends on Wave 1)

4. ARCHITECT: Run full validation suite
   Files: (none — read-only verification)
   Requirements:
   - Run full validation to ensure all Wave 1 changes are clean:
     ```bash
     npm run typecheck
     npm test
     npm run release-check
     npm pack --dry-run
     publint
     ```
   - All must pass. If any fail, fix before proceeding.
   - Do NOT change version or create git tag — actual publish is v26 (after Windows).
   Acceptance: All 5 validation commands pass.

5. ARCHITECT: Create Homebrew tap repository bootstrap
   Files: (NEW) Creates files to be committed to a separate repo, but for now create them under `homebrew-tap/` directory in this repo as a staging area
   Requirements:
   - Create `homebrew-tap/Formula/auto-sop.rb`:
     ```ruby
     class AutoSop < Formula
       desc "Make Claude Code self-improving — auto-detect mistakes, write CLAUDE.md directives"
       homepage "https://github.com/auto-sop/auto-sop"
       url "https://registry.npmjs.org/auto-sop/-/auto-sop-0.1.0.tgz"
       # sha256 will be filled after npm publish
       sha256 "PLACEHOLDER_SHA256"
       license "Apache-2.0"

       depends_on "node@20"

       def install
         system "npm", "install", *std_npm_args
         bin.install_symlink libexec/"bin/auto-sop"
       end

       test do
         assert_match version.to_s, shell_output("#{bin}/auto-sop --version")
       end
     end
     ```
   - Create `homebrew-tap/README.md`:
     ```markdown
     # Homebrew Tap for auto-sop

     ## Install

     ```bash
     brew install auto-sop/tap/auto-sop
     ```

     ## What is auto-sop?

     Make Claude Code self-improving. See [auto-sop/auto-sop](https://github.com/auto-sop/auto-sop).
     ```
   - Add `homebrew-tap/` to `.gitignore` — this is a staging area, NOT part of the npm package. The real tap repo (`auto-sop/homebrew-tap`) will be created on GitHub separately.
   - Create a script `scripts/update-homebrew-tap.sh` that automates tap updates after npm publish:
     ```bash
     #!/usr/bin/env bash
     set -euo pipefail
     VERSION="${1:?Usage: update-homebrew-tap.sh <version>}"
     SHA=$(curl -sL "https://registry.npmjs.org/auto-sop/-/auto-sop-${VERSION}.tgz" | shasum -a 256 | cut -d' ' -f1)
     echo "Version: $VERSION"
     echo "SHA256: $SHA"
     echo ""
     echo "Update homebrew-tap/Formula/auto-sop.rb:"
     echo "  url \"https://registry.npmjs.org/auto-sop/-/auto-sop-${VERSION}.tgz\""
     echo "  sha256 \"$SHA\""
     ```
   Acceptance: `homebrew-tap/Formula/auto-sop.rb` exists with valid Ruby syntax. `scripts/update-homebrew-tap.sh` is executable. `homebrew-tap/` is in `.gitignore`.

## Quality Gates (MANDATORY)
6. YODA: Code review — README changes, package.json metadata, publish workflow, Homebrew formula
7. APEX: Security review — no secrets in committed files, publish workflow security, OIDC config
8. ANALYZER: Code improvement review — grade must be C or above

## Finalize
9. ARCHITECT: Commit with message: `feat(v22): README badges + npm metadata + publish workflow + Homebrew tap bootstrap`

## Post-v22 Manual Steps (USER — deferred to v26)
These happen AFTER Windows (v23-v25) and at actual publish time (v26):
1. Version bump `0.0.x` → `0.1.0`
2. `git tag v0.1.0 && git push origin v0.1.0` → triggers publish workflow
3. Configure npm trustedPublisher on npmjs.com
4. Create `auto-sop/homebrew-tap` repo, push from staging dir
5. Run `scripts/update-homebrew-tap.sh 0.1.0` for real SHA256

## Acceptance Criteria
- README has CI, npm version, npm downloads, license, node badges (5 total)
- README has Star History chart and Contributors section
- README shows both `npx` and `brew` install options
- `package.json` has keywords, improved description, author, engines
- Publish workflow has test + release-check gates before publish
- Publish workflow creates GitHub Release on tag push
- `npm pack --dry-run` + `publint` pass
- Homebrew formula staged in `homebrew-tap/` with update script
- All quality gates approved
- No git tag created, no npm publish triggered (that's v26)

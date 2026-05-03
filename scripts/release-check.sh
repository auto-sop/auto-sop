#!/usr/bin/env bash
#
# release-check.sh — 28 pre-publish checks for auto-sop
# Run: npm run release-check
# Exit: non-zero on ANY failure
#

set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { ((PASS++)); echo "  ✅ PASS: $1"; }
fail() { ((FAIL++)); echo "  ❌ FAIL: $1"; echo "     FIX:  $2"; }
warn() { ((WARN++)); echo "  ⚠️  WARN: $1"; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  auto-sop release check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Package metadata ─────────────────────────
echo "▸ Package metadata"

if node -e "const p=require('./package.json'); if(!p.name) process.exit(1)" 2>/dev/null; then
  pass "package.json has 'name' field"
else
  fail "package.json missing 'name'" "Add \"name\": \"auto-sop\" to package.json"
fi

if node -e "const p=require('./package.json'); if(!p.version) process.exit(1)" 2>/dev/null; then
  pass "package.json has 'version' field"
else
  fail "package.json missing 'version'" "Run: npm version patch --no-git-tag-version"
fi

if node -e "const p=require('./package.json'); if(!p.license) process.exit(1)" 2>/dev/null; then
  pass "package.json has 'license' field"
else
  fail "package.json missing 'license'" "Add \"license\": \"Elastic-2.0\" to package.json"
fi

if node -e "const p=require('./package.json'); if(!p.repository) process.exit(1)" 2>/dev/null; then
  pass "package.json has 'repository' field"
else
  fail "package.json missing 'repository'" "Add \"repository\": { \"type\": \"git\", \"url\": \"...\" } to package.json"
fi

if node -e "const p=require('./package.json'); if(!p.homepage) process.exit(1)" 2>/dev/null; then
  pass "package.json has 'homepage' field"
else
  fail "package.json missing 'homepage'" "Add \"homepage\": \"https://github.com/auto-sop/auto-sop\" to package.json"
fi

if node -e "const p=require('./package.json'); if(!p.bugs) process.exit(1)" 2>/dev/null; then
  pass "package.json has 'bugs' field"
else
  fail "package.json missing 'bugs'" "Add \"bugs\": { \"url\": \"https://github.com/auto-sop/auto-sop/issues\" } to package.json"
fi

# ── 2. License ───────────────────────────────────
echo ""
echo "▸ License"

if [ -f LICENSE ] && [ -s LICENSE ]; then
  pass "LICENSE file exists and is non-empty"
else
  fail "LICENSE file missing or empty" "Add Elastic License 2.0 (ELv2) LICENSE file"
fi

# ── 3. Build artifacts ──────────────────────────
echo ""
echo "▸ Build artifacts"

if [ -d dist ]; then
  pass "dist/ directory exists"
else
  fail "dist/ directory missing" "Run: npm run build"
fi

if [ -f dist/index.js ]; then
  pass "ESM entry point exists (dist/index.js)"
else
  fail "ESM entry point missing" "Run: npm run build"
fi

if [ -f dist/index.cjs ]; then
  pass "CJS entry point exists (dist/index.cjs)"
else
  fail "CJS entry point missing" "Run: npm run build"
fi

if [ -f dist/index.d.ts ]; then
  pass "Type declarations exist (dist/index.d.ts)"
else
  fail "Type declarations missing" "Run: npm run build"
fi

# ── 4. Exports & bin validation ─────────────────
echo ""
echo "▸ Exports & bin"

if node -e "const p=require('./package.json'); if(!p.exports||!p.exports['.']) process.exit(1)" 2>/dev/null; then
  pass "package.json exports field is valid"
else
  fail "package.json exports field missing or invalid" "Add exports map to package.json"
fi

BIN_OK=true
while IFS= read -r binpath; do
  if [ ! -f "$binpath" ]; then
    fail "bin entry points to missing file: $binpath" "Run: npm run build"
    BIN_OK=false
  fi
done < <(node -e "const p=require('./package.json'); Object.values(p.bin||{}).forEach(v=>console.log(v))" 2>/dev/null)
if [ "$BIN_OK" = true ]; then
  pass "All bin entries point to existing files"
fi

# ── 5. Documentation ────────────────────────────
echo ""
echo "▸ Documentation"

if [ -f README.md ] && [ -s README.md ]; then
  pass "README.md exists and is non-empty"
else
  fail "README.md missing or empty" "Create README.md with install, quick start, and architecture sections"
fi

if [ -f CONTRIBUTING.md ] && [ -s CONTRIBUTING.md ]; then
  pass "CONTRIBUTING.md exists"
else
  fail "CONTRIBUTING.md missing" "Create CONTRIBUTING.md with dev setup and version bump convention"
fi

# ── 6. CI workflows ─────────────────────────────
echo ""
echo "▸ CI workflows"

if [ -f .github/workflows/publish.yml ]; then
  pass "publish.yml workflow exists"
else
  fail "publish.yml missing" "Create .github/workflows/publish.yml"
fi

if [ -f .github/workflows/ci.yml ]; then
  pass "ci.yml workflow exists"
else
  fail "ci.yml missing" "Create .github/workflows/ci.yml"
fi

# ── 7. Security & hygiene ───────────────────────
echo ""
echo "▸ Security & hygiene"

if [ -d dist ]; then
  SECRETS_FOUND=$(find dist -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name 'credentials*' -o -name '*.secret' 2>/dev/null | head -5)
  if [ -z "$SECRETS_FOUND" ]; then
    pass "No secret files in dist/"
  else
    fail "Potential secret files found in dist/: $SECRETS_FOUND" "Remove secrets from dist/ and add to .gitignore"
  fi

  # Content-pattern scan for hardcoded secrets in dist/ files
  SECRET_PATTERNS='AKIA[0-9A-Z]{16}|sk-ant-api03-[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{36}'
  CONTENT_SECRETS=$(grep -rEol "$SECRET_PATTERNS" dist/ 2>/dev/null | head -5 || true)
  if [ -z "$CONTENT_SECRETS" ]; then
    pass "No hardcoded secret patterns in dist/ content"
  else
    fail "Hardcoded secret patterns found in: $CONTENT_SECRETS" "Remove hardcoded secrets and use environment variables"
  fi
else
  warn "dist/ not found, skipping secrets check"
fi

# Backward-compat code legitimately references 'claude-sop' for migration/env-compat.
# Exclude those files and lines tagged as legacy/compat/migration.
CLAUDE_SOP_REFS=$( (grep -rn 'claude-sop' src/ README.md CONTRIBUTING.md 2>/dev/null || true) \
  | grep -Ev 'LEGACY|[Ll]egacy|[Dd]eprecated|[Cc]ompat|[Mm]igrat|[Bb]ackward|CLAUDE_SOP_' \
  | grep -Ev 'env-compat|machine-id|macos-launchd|linux-cron|linux-systemd|kill-switch' \
  | grep -Ev 'markers\.ts|managed-section\.ts|doctor\.ts|statusline\.ts|migrate\.ts' \
  | grep -v node_modules \
  | head -10 || true)
if [ -z "$CLAUDE_SOP_REFS" ]; then
  pass "No 'claude-sop' leftover references in user-visible files"
else
  fail "Found 'claude-sop' references in: $CLAUDE_SOP_REFS" "Rename all 'claude-sop' to 'auto-sop'"
fi

# ── 8. Code quality ─────────────────────────────
echo ""
echo "▸ Code quality"

TODO_COUNT=$( (grep -rn 'TODO\|FIXME' src/ --include='*.ts' 2>/dev/null || true) | wc -l | tr -d ' ')
if [ "$TODO_COUNT" -eq 0 ]; then
  pass "No TODO/FIXME in src/"
else
  fail "Found $TODO_COUNT TODO/FIXME markers in src/" "Resolve or remove TODO/FIXME comments before release"
fi

# ── 9. Node/npm versions ────────────────────────
echo ""
echo "▸ Runtime requirements"

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -ge 20 ]; then
  pass "Node.js >= 20 (found v$(node -v | sed 's/v//'))"
else
  fail "Node.js < 20 (found v$(node -v | sed 's/v//'))" "Upgrade Node.js to >= 20"
fi

NPM_MAJOR=$(npm -v | cut -d. -f1)
if [ "$NPM_MAJOR" -ge 9 ]; then
  pass "npm >= 9 (found v$(npm -v))"
else
  fail "npm < 9 (found v$(npm -v))" "Upgrade npm to >= 9"
fi

# ── 10. publishConfig ───────────────────────────
echo ""
echo "▸ Publish config"

if node -e "const p=require('./package.json'); if(!p.publishConfig||p.publishConfig.access!=='public') process.exit(1)" 2>/dev/null; then
  pass "publishConfig.access is 'public'"
else
  fail "publishConfig.access not set to 'public'" "Add \"publishConfig\": { \"access\": \"public\", \"provenance\": true } to package.json"
fi

if node -e "const p=require('./package.json'); if(!p.publishConfig||!p.publishConfig.provenance) process.exit(1)" 2>/dev/null; then
  pass "publishConfig.provenance is enabled"
else
  fail "publishConfig.provenance not enabled" "Add \"provenance\": true to publishConfig in package.json"
fi

# ── 11. Package name check ─────────────────────
echo ""
echo "▸ Package identity"

PKG_NAME=$(node -p "require('./package.json').name" 2>/dev/null)
if [ "$PKG_NAME" = "auto-sop" ]; then
  pass "Package name is 'auto-sop'"
else
  fail "Package name is '$PKG_NAME' (expected 'auto-sop')" "Set \"name\": \"auto-sop\" in package.json"
fi

PKG_LICENSE=$(node -p "require('./package.json').license" 2>/dev/null)
if [ "$PKG_LICENSE" = "Elastic-2.0" ]; then
  pass "License is Elastic-2.0"
else
  fail "License is '$PKG_LICENSE' (expected 'Elastic-2.0')" "Set \"license\": \"Elastic-2.0\" in package.json"
fi

if node -e "const p=require('./package.json'); if(!p.engines||!p.engines.node) process.exit(1)" 2>/dev/null; then
  pass "engines.node field is set"
else
  fail "engines.node field missing" "Add \"engines\": { \"node\": \">=20\" } to package.json"
fi

# ── 12. Version-tag match (optional) ────────────
echo ""
echo "▸ Version consistency"

PKG_VERSION=$(node -p "require('./package.json').version" 2>/dev/null)
CURRENT_TAG=$(git describe --tags --exact-match 2>/dev/null || echo "none")
if [ "$CURRENT_TAG" = "none" ]; then
  pass "No tag on HEAD (expected during development)"
elif [ "$CURRENT_TAG" = "v$PKG_VERSION" ]; then
  pass "Tag ($CURRENT_TAG) matches package.json version ($PKG_VERSION)"
else
  fail "Tag ($CURRENT_TAG) does not match package.json version ($PKG_VERSION)" "Ensure git tag matches package.json version"
fi

# ── Summary ──────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "  Total checks: $((PASS + FAIL))"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  ❌ RELEASE BLOCKED — fix $FAIL issue(s) above"
  exit 1
else
  echo ""
  echo "  ✅ ALL CHECKS PASSED — ready to publish"
  exit 0
fi

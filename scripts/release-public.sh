#!/usr/bin/env bash
# Syncs curated source files from auto-sop-cli to the public auto-sop repo.
# Usage: ./scripts/release-public.sh <source-dir> <dest-dir>
#
# Source: local auto-sop-cli repo (private, full source)
# Dest:   local auto-sop repo clone (public, curated source)

set -euo pipefail

SRC_DIR="${1:?Usage: release-public.sh <source-dir> <dest-dir>}"
DEST_DIR="${2:?Usage: release-public.sh <source-dir> <dest-dir>}"

if [ ! -d "$SRC_DIR/src" ]; then
  echo "Error: $SRC_DIR does not look like the auto-sop-cli repo (no src/)"
  exit 1
fi
if [ ! -d "$DEST_DIR/.git" ]; then
  echo "Error: $DEST_DIR is not a git repository"
  exit 1
fi

echo "=== auto-sop public release sync ==="
echo "Source (private): $SRC_DIR"
echo "Dest (public):    $DEST_DIR"
echo ""

# Clean destination (preserve .git and .github)
find "$DEST_DIR" -mindepth 1 -maxdepth 1 \
  ! -name '.git' ! -name '.github' \
  -exec rm -rf {} +

# --- Included source directories ---
INCLUDE_DIRS=(
  "src/atomic"
  "src/capture"
  "src/cli"
  "src/config"
  "src/installer"
  "src/managed-section"
  "src/path-resolver"
  "src/platform"
  "src/scheduler"
  "src/status"
)

INCLUDE_FILES=(
  "src/cli.ts"
  "src/index.ts"
  "src/platform-check.ts"
)

mkdir -p "$DEST_DIR/src"
for dir in "${INCLUDE_DIRS[@]}"; do
  if [ ! -d "$SRC_DIR/$dir" ]; then
    echo "Error: included directory $SRC_DIR/$dir does not exist"
    exit 1
  fi
  cp -r "$SRC_DIR/$dir" "$DEST_DIR/$dir"
done
for file in "${INCLUDE_FILES[@]}"; do
  [ -f "$SRC_DIR/$file" ] && cp "$SRC_DIR/$file" "$DEST_DIR/$file"
done

# --- Remove proprietary files from included directories ---
# src/config/ is included but these specific files contain proprietary logic:
PROPRIETARY_FILES_IN_INCLUDED_DIRS=(
  "src/config/secrets.ts"      # scrypt + AES-256-GCM encryption
  "src/config/machine-id.ts"   # machine fingerprinting algorithm
)
for file in "${PROPRIETARY_FILES_IN_INCLUDED_DIRS[@]}"; do
  rm -f "$DEST_DIR/$file"
  echo "  Removed proprietary: $file"
done

# --- Excluded directories (proprietary — create README stubs) ---
EXCLUDE_DIRS=("src/learner" "src/license" "src/metrics" "src/scrubber")

for dir in "${EXCLUDE_DIRS[@]}"; do
  module_name=$(basename "$dir")
  module_title=$(printf '%s' "$module_name" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
  mkdir -p "$DEST_DIR/$dir"
  cat > "$DEST_DIR/$dir/README.md" << STUB
# $module_title Module

This module's source code is proprietary and not included in the public repository.
The compiled version is distributed via the official npm package.

\`\`\`bash
npm install -g auto-sop
\`\`\`

**Documentation:** https://auto-sop.com/docs
**License:** [Elastic License 2.0 (ELv2)](../../LICENSE)
STUB
done

# --- Plugin directory (hook shim) ---
[ -d "$SRC_DIR/plugin" ] && cp -r "$SRC_DIR/plugin" "$DEST_DIR/plugin"

# --- Root files ---
ROOT_FILES=(
  "package.json"
  "README.md"
  "LICENSE"
  "NOTICES.md"
  "CONTRIBUTING.md"
  "CHANGELOG.md"
  "tsconfig.json"
  "tsup.config.ts"
  "eslint.config.js"
  ".gitignore"
)

for file in "${ROOT_FILES[@]}"; do
  [ -f "$SRC_DIR/$file" ] && cp "$SRC_DIR/$file" "$DEST_DIR/$file"
done

# --- Post-sync security scan ---
echo ""
echo "=== Security scan ==="
LEAK=0

# Check proprietary .ts files not present
for dir in "${EXCLUDE_DIRS[@]}"; do
  ts=$(find "$DEST_DIR/$dir" -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
  [ "$ts" -gt 0 ] && echo "LEAK: $dir has .ts files" && LEAK=1
done

# Check removed proprietary files
for f in "${PROPRIETARY_FILES_IN_INCLUDED_DIRS[@]}"; do
  [ -f "$DEST_DIR/$f" ] && echo "LEAK: $f still present" && LEAK=1
done

# Check excluded dirs don't exist
for dir in test coverage scripts dist .planning .auto-sop .claude plans homebrew-tap; do
  [ -d "$DEST_DIR/$dir" ] && echo "LEAK: $dir/ exists" && LEAK=1
done

# Check no env/key/secret files
env_count=$(find "$DEST_DIR" -name ".env*" -o -name "*.pem" -o -name "*.key" -o -name "*.secret" -o -name "*.tgz" -o -name ".npmrc" 2>/dev/null | wc -l | tr -d ' ')
[ "$env_count" -gt 0 ] && echo "LEAK: $env_count sensitive files found" && LEAK=1

# Check no CLAUDE.md or bench files
[ -f "$DEST_DIR/CLAUDE.md" ] && echo "LEAK: CLAUDE.md present" && LEAK=1
[ -f "$DEST_DIR/bench-results.json" ] && echo "LEAK: bench-results.json present" && LEAK=1

# Deep grep for secrets (scan all of DEST_DIR)
secret_hits=$(grep -rn 'sk-ant-\|BEGIN PRIVATE KEY\|SUPABASE_SERVICE_ROLE\|CLERK_SECRET\|STRIPE_SECRET\|AKIA\|ghp_\|sk-proj-' "$DEST_DIR/" --include='*.ts' --include='*.js' --include='*.json' --include='*.md' --include='*.sh' --include='*.env*' --include='*.yml' --include='*.yaml' 2>/dev/null | wc -l | tr -d ' ')
[ "$secret_hits" -gt 0 ] && echo "LEAK: $secret_hits lines with secret patterns" && LEAK=1

if [ "$LEAK" -gt 0 ]; then
  echo ""
  echo "SECURITY CHECK FAILED — do NOT push this"
  exit 1
fi
echo "All security checks passed"

# --- Summary ---
ts_count=$(find "$DEST_DIR/src" -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
stub_count=${#EXCLUDE_DIRS[@]}
echo ""
echo "=== Sync complete ==="
echo "TypeScript files copied: $ts_count"
echo "Proprietary modules stubbed: $stub_count"
echo "Root files copied: ${#ROOT_FILES[@]}"
echo ""
PKG_VER=$(node -p "require('$DEST_DIR/package.json').version" 2>/dev/null || echo "X.Y.Z")
echo "Next steps:"
echo "  cd $DEST_DIR"
echo "  git add -A && git commit -m 'release: v${PKG_VER}'"
echo "  git push origin main"

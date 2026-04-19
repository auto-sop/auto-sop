#!/usr/bin/env bash
# Auto-bump patch version on every commit.
# Idempotent: skips if version was already bumped in this commit.
# Skips during: npm lifecycle events, rebase, merge.

set -euo pipefail

# --- Guard: skip during npm version / npm publish lifecycle ---
if [[ -n "${npm_lifecycle_event:-}" ]]; then
  exit 0
fi

# --- Guard: skip during rebase ---
GIT_DIR_PATH="$(git rev-parse --git-dir 2>/dev/null)"
if [[ -d "${GIT_DIR_PATH}/rebase-merge" ]] || [[ -d "${GIT_DIR_PATH}/rebase-apply" ]]; then
  exit 0
fi

# --- Guard: skip during merge ---
if [[ -f "${GIT_DIR_PATH}/MERGE_HEAD" ]]; then
  exit 0
fi

# --- Guard: idempotency — skip if package.json version already changed ---
# Compare staged package.json version against HEAD version.
HEAD_VERSION="$(git show HEAD:package.json 2>/dev/null | grep '"version"' | head -1 | sed 's/.*"\([0-9][0-9.]*\)".*/\1/' || echo "")"
CURRENT_VERSION="$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9][0-9.]*\)".*/\1/' || echo "")"

if [[ -n "$HEAD_VERSION" ]] && [[ "$HEAD_VERSION" != "$CURRENT_VERSION" ]]; then
  # Version already differs from HEAD — already bumped, skip.
  exit 0
fi

# --- Bump patch version ---
npm version patch --no-git-tag-version --silent
git add package.json package-lock.json

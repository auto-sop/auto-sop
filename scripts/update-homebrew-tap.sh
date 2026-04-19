#!/usr/bin/env bash
set -euo pipefail
VERSION=${1:?Usage: update-homebrew-tap.sh <version>}
SHA=$(curl -sL "https://registry.npmjs.org/auto-sop/-/auto-sop-${VERSION}.tgz" | shasum -a 256 | cut -d' ' -f1)
echo "Version: $VERSION"
echo "SHA256: $SHA"
echo ""
echo "Update homebrew-tap/Formula/auto-sop.rb:"
echo "  url \"https://registry.npmjs.org/auto-sop/-/auto-sop-${VERSION}.tgz\""
echo "  sha256 \"$SHA\""

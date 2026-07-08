#!/usr/bin/env bash
# Zero-CI-cost release from this Mac: build → sign → notarize → README row → tag →
# GitHub Release. Produces the same artifacts and bookkeeping as the CI release job,
# without spending a single Actions minute (macOS runners bill at 10x).
#
#   usage: ./scripts/release-local.sh
#
# Signing: electron-builder auto-discovers the "Developer ID Application" identity
# in your keychain — no env vars needed. Without one, the build is unsigned (warned).
#
# Notarization: electron-builder does NOT read notarytool keychain profiles — it
# needs these three env vars (values in 1Password):
#
#   export APPLE_ID=<apple-id email>
#   export APPLE_APP_SPECIFIC_PASSWORD=<app-specific password>
#   export APPLE_TEAM_ID=XTDM7A93Z3
#
# If they're unset, the script checks for a notarytool keychain profile
# ($NOTARY_PROFILE, default "codelifter") purely to remind you the credentials
# exist, then degrades to a SIGNED-BUT-UNNOTARIZED build with a loud warning.
# It never fails on missing notarization credentials.
#
# Versioning matches CI conventions: BASE_VERSION + RELEASE_LEVEL repo variables;
# the patch is (highest existing v<BASE>.N tag) + 1. Don't mix local and CI releases
# within one BASE_VERSION unless you're sure the CI run counter is behind the tags.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "error: $*" >&2; exit 1; }

# ── preconditions ──────────────────────────────────────────────────
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "release from main only"
git diff-index --quiet HEAD || die "uncommitted changes — commit or stash first"
git fetch -q --tags origin
git pull -q --ff-only origin main || die "local main has diverged from origin — reconcile first"

# ── version ────────────────────────────────────────────────────────
BASE="$(gh variable get BASE_VERSION 2>/dev/null || echo 0.5)"
LEVEL="$(gh variable get RELEASE_LEVEL 2>/dev/null || echo "")"
LAST_PATCH="$(git tag -l "v${BASE}.*" | sed -E "s/^v${BASE}\.([0-9]+).*$/\1/" | sort -n | tail -1)"
PATCH=$(( ${LAST_PATCH:-0} + 1 ))
VERSION="${BASE}.${PATCH}${LEVEL:+-$LEVEL}"
TAG="v${VERSION}"
echo "── releasing ${TAG} (base ${BASE}, level '${LEVEL}')"

# ── signing / notarization credentials ─────────────────────────────
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  echo "!! no 'Developer ID Application' identity in the keychain — the build will be UNSIGNED."
fi
if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
  NOTARY_PROFILE="${NOTARY_PROFILE:-codelifter}"
  echo "!! APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set —"
  echo "   electron-builder will SKIP notarization (signed-but-unnotarized build)."
  if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "   Keychain profile '$NOTARY_PROFILE' exists, but electron-builder can't read"
    echo "   notarytool profiles — export the three env vars (values in 1Password) and rerun."
  else
    echo "   Export the three env vars (values in 1Password) to notarize."
  fi
fi

# ── stamp version + build ──────────────────────────────────────────
[ -d node_modules ] || npm ci
npm version "$VERSION" --no-git-tag-version --allow-same-version
npx electron-builder --mac --publish never

DMG="dist/LGTM-arm64.dmg"
ZIP="dist/LGTM-arm64.zip"
UPDATE_YML="dist/latest-mac.yml"
[ -f "$DMG" ] && [ -f "$ZIP" ] || die "expected artifacts missing in dist/"

# ── README release-history row (same awk as the CI release job) ────
REPO_URL="https://github.com/CodeLifterIO/LGTM"
DL="${REPO_URL}/releases/download/${TAG}"
NEW_ROW="| ${TAG} | $(date -u +%Y-%m-%d) | [dmg](${DL}/LGTM-arm64.dmg) · [zip](${DL}/LGTM-arm64.zip) | — | [Release notes](${REPO_URL}/releases/tag/${TAG}) |"
awk -v row="$NEW_ROW" '/\|[-]+\|[-]+\|[-]+\|[-]+\|[-]+\|/{print; print row; next} {print}' README.md > README.tmp \
  && mv README.tmp README.md

# ── commit, tag, push, release ─────────────────────────────────────
git add package.json package-lock.json README.md
git commit -q -m "chore: release ${VERSION} [skip ci]"
git tag "$TAG"
git push -q origin main --tags

RELEASE_FLAGS=(--title "LGTM ${TAG}" --generate-notes)
[ -n "$LEVEL" ] && RELEASE_FLAGS+=(--prerelease)
FILES=("$DMG" "$ZIP")
[ -f "$UPDATE_YML" ] && FILES+=("$UPDATE_YML")
gh release create "$TAG" "${FILES[@]}" "${RELEASE_FLAGS[@]}"

echo "── released: ${REPO_URL}/releases/tag/${TAG}"

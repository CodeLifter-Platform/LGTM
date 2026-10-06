#!/usr/bin/env bash
# Zero-CI-cost release from this Mac: build → sign → notarize → README row → tag →
# GitHub Release. Produces the same artifacts and bookkeeping as the CI release job,
# without spending a single Actions minute (macOS runners bill at 10x).
#
#   usage: ./scripts/release-local.sh [prerelease|minor|major]     (default: prerelease)
#
#   prerelease  patch + 1, tagged vX.Y.Z-pre, a GitHub *prerelease*, Pre-releases row.
#               What a merge into main produces on the platform; here it is run by hand
#               because this public repo keeps its heavy CI legs dispatch-only.
#   minor       the RELEASE MINOR button: minor + 1, patch -> 0, full release.
#   major       the RELEASE MAJOR button: major + 1, minor/patch -> 0, full release.
#
# Versions come from git tags via .github/scripts/next-version.sh — nothing is stored in
# a repo variable (Platform-Standards/process/versioning-ci.md). A promotion rebuilds the
# newest pre-release's commit, exactly like the buttons do, so main must be sitting on
# that commit: cut a pre-release first, then promote it.
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
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "error: $*" >&2; exit 1; }

KIND="${1:-prerelease}"
case "$KIND" in prerelease|minor|major) ;; *) die "usage: $0 [prerelease|minor|major]" ;; esac

# ── preconditions ──────────────────────────────────────────────────
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "release from main only"
git diff-index --quiet HEAD || die "uncommitted changes — commit or stash first"
git fetch -q --tags --force origin
git pull -q --ff-only origin main || die "local main has diverged from origin — reconcile first"
command -v gh >/dev/null || die "gh CLI is required (brew install gh)"

# ── version ────────────────────────────────────────────────────────
VERSION="$(./.github/scripts/next-version.sh "$KIND")"
TAG="v${VERSION}"
BUILD_SHA="$(git rev-parse HEAD)"
PROMOTED_FROM=""

if [ "$KIND" != "prerelease" ]; then
  # A promotion rebuilds a TESTED pre-release, never whatever happens to be on main.
  PRE="$(git tag --list 'v*-pre' | sed -E 's/^v//; s/-pre$//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
  [ -n "$PRE" ] || die "no pre-release tag to promote — run '$0 prerelease' first"
  PROMOTED_FROM="v${PRE}-pre"
  PRE_SHA="$(git rev-parse "${PROMOTED_FROM}^{commit}")"
  if [ "$PRE_SHA" != "$BUILD_SHA" ]; then
    die "main is at $(git rev-parse --short HEAD) but the newest pre-release ${PROMOTED_FROM} is $(git rev-parse --short "$PRE_SHA").
       A promotion rebuilds the pre-release's commit. Either cut a new pre-release from this
       main first ('$0 prerelease'), or check out ${PROMOTED_FROM} and promote from there."
  fi
  IS_PRE=false
  echo "── promoting ${PROMOTED_FROM} → ${TAG} ($KIND)"
else
  IS_PRE=true
  echo "── cutting pre-release ${TAG}"
fi

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

# ── test, stamp version, build ─────────────────────────────────────
[ -d node_modules ] || npm ci
npm test
npm version "$VERSION" --no-git-tag-version --allow-same-version
npx electron-builder --mac --publish never
git checkout -q -- package.json package-lock.json   # the stamp lives in the artifacts, not in main

DMG="dist/LGTM-arm64.dmg"
ZIP="dist/LGTM-arm64.zip"
UPDATE_YML="dist/latest-mac.yml"
[ -f "$DMG" ] && [ -f "$ZIP" ] || die "expected artifacts missing in dist/"

# ── README row (same awk as the CI release job; anchor matched exactly) ──
REPO_URL="https://github.com/CodeLifter-Platform/LGTM"
DL="${REPO_URL}/releases/download/${TAG}"
SHORT_SHA="${BUILD_SHA:0:7}"
if [ "$IS_PRE" = true ]; then
  ANCHOR="<!-- prereleases:insert -->"
  PROVENANCE="[\`${SHORT_SHA}\`](${REPO_URL}/commit/${BUILD_SHA})"
else
  ANCHOR="<!-- releases:insert -->"
  PROVENANCE="rebuilt from ${PROMOTED_FROM} ([\`${SHORT_SHA}\`](${REPO_URL}/commit/${BUILD_SHA}))"
fi
# Windows installers are not built here; their links fill in when a CI dispatch adds them.
DOWNLOADS="[dmg](${DL}/LGTM-arm64.dmg) · [zip](${DL}/LGTM-arm64.zip)"
ROW="| ${TAG} | $(date -u +%Y-%m-%d) | ${DOWNLOADS} | ${PROVENANCE} | [Release notes](${REPO_URL}/releases/tag/${TAG}) |"
grep -qF "$ANCHOR" README.md || die "README.md has no ${ANCHOR} anchor"
awk -v row="$ROW" -v anchor="$ANCHOR" '
  $0 == anchor        { print; inblock=1; next }
  inblock && /^\|---/ { print; print row; inblock=0; next }
  { print }
' README.md > README.tmp && mv README.tmp README.md

# ── commit, tag, push, release ─────────────────────────────────────
git add README.md
git commit -q -m "chore: release ${VERSION} [skip ci]"
git tag "$TAG" "$BUILD_SHA"            # the tag points at the BUILT commit, not the README bump
git push -q origin main --tags

RELEASE_FLAGS=(--title "LGTM ${TAG}" --generate-notes --target "$BUILD_SHA")
[ "$IS_PRE" = true ] && RELEASE_FLAGS+=(--prerelease)
FILES=("$DMG" "$ZIP")
[ -f "$UPDATE_YML" ] && FILES+=("$UPDATE_YML")
gh release create "$TAG" "${FILES[@]}" "${RELEASE_FLAGS[@]}"

echo "── released: ${REPO_URL}/releases/tag/${TAG}"

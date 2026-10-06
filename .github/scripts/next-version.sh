#!/usr/bin/env bash
# Resolve the next version from git tags. The tags ARE the source of truth: nothing is
# stored in a repo variable, so the version can never drift from what was published, and
# no PAT is needed to write state back.
#
#   next-version.sh prerelease   # patch + 1, suffixed -pre   (a merge into main)
#   next-version.sh minor        # minor + 1, patch -> 0      (RELEASE MINOR button)
#   next-version.sh major        # major + 1, minor/patch -> 0 (RELEASE MAJOR button)
#
# Writes version / version_tag / is_prerelease / base_tag to $GITHUB_OUTPUT when set, and
# echoes the version either way so it can be run by hand.
#
# MAJOR_PIN pins the major (Iconizit.Core tracks the Font Awesome major). With it set,
# `major` refuses unless the pin has already moved past the current major.

set -euo pipefail
KIND="${1:?usage: next-version.sh prerelease|minor|major}"

# Highest semver across BOTH pre-releases and full releases. sort -V orders 0.9.9 < 0.9.14
# correctly, where a lexical sort would not — the whole reason the old run-number scheme
# produced gappy, meaningless patch numbers.
highest="$(git tag --list 'v*' \
  | sed -E 's/^v//; s/-pre$//; s/-(alpha|beta|rc)$//' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V | tail -1 || true)"
highest="${highest:-0.0.0}"

IFS=. read -r MAJOR MINOR PATCH <<<"$highest"

if [ -n "${MAJOR_PIN:-}" ]; then
  if [ "$MAJOR_PIN" -lt "$MAJOR" ]; then
    echo "!! MAJOR_PIN=$MAJOR_PIN is behind the current major $MAJOR" >&2; exit 1
  fi
  # A raised pin resets the lower components: Font Awesome 8 starts at 8.0.0.
  if [ "$MAJOR_PIN" -gt "$MAJOR" ]; then MAJOR="$MAJOR_PIN"; MINOR=0; PATCH=0; fi
fi

case "$KIND" in
  prerelease) PATCH=$((PATCH + 1)); SUFFIX="-pre"; PRE=true ;;
  minor)      MINOR=$((MINOR + 1)); PATCH=0; SUFFIX=""; PRE=false ;;
  major)
    if [ -n "${MAJOR_PIN:-}" ]; then
      echo "!! this repo pins its major (MAJOR_PIN=$MAJOR_PIN). Raise the pin to match the" >&2
      echo "   upstream major first, then a merge picks it up — there is no free major bump." >&2
      exit 1
    fi
    MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0; SUFFIX=""; PRE=false ;;
  *) echo "!! unknown bump kind: $KIND" >&2; exit 1 ;;
esac

VERSION="${MAJOR}.${MINOR}.${PATCH}${SUFFIX}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "version=$VERSION"
    echo "version_tag=v${VERSION}"
    echo "is_prerelease=$PRE"
    echo "base_tag=v${highest}"
  } >> "$GITHUB_OUTPUT"
fi
echo "$VERSION"

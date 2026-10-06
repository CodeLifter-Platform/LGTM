# How to Release LGTM

LGTM follows the platform versioning contract
(`Platform-Standards/process/versioning-ci.md`): **`major.minor.patch`, derived from git
tags**. Nothing is stored in a repo variable, so the recorded version can never drift from
what was published. `BASE_VERSION` and `RELEASE_LEVEL` are retired; delete them from the
repo variables if they still exist.

## The scheme

| Event | Version | GitHub release | README table |
|---|---|---|---|
| Pre-release (dispatch on `main`, or `release-local.sh`) | patch + 1, `-pre` | prerelease | **Pre-releases** |
| **RELEASE MINOR** button (or `release-local.sh minor`) | minor + 1, patch → 0 | full release | **Releases** |
| **RELEASE MAJOR** button (or `release-local.sh major`) | major + 1, minor → 0, patch → 0 | full release | **Releases** |

Starting from the current `v1.6.0`:

```
pre-release → 1.6.1-pre    pre-release → 1.6.2-pre
RELEASE MINOR              → 1.7.0   (rebuilds the 1.6.2-pre commit)
pre-release → 1.7.1-pre
RELEASE MAJOR              → 2.0.0
```

`.github/scripts/next-version.sh` is the one place the arithmetic lives (a copy of the
platform template). `sort -V` keeps `1.6.9 < 1.6.14`; `fetch-depth: 0` in the workflows is
what makes the tags visible to a CI checkout.

## One difference from the platform default

On the platform, **merging into `main` publishes the pre-release**. This repo is public, so
its macOS (10×) and Windows (2×) legs are `workflow_dispatch`-only and a merge builds
nothing; pushes and PRs run only the ubuntu `version` + `test` jobs. The pre-release is
therefore cut deliberately, by one of two equivalent routes:

- **`./scripts/release-local.sh`** from a dev Mac: builds, signs, notarizes, inserts the
  Pre-releases row, commits `chore: release X.Y.Z-pre [skip ci]`, tags the built commit,
  and publishes a GitHub prerelease with the `.dmg`, `.zip` and `latest-mac.yml`. $0 of
  Actions minutes. Windows installers are not built this way.
- **Actions → Build & Release → Run workflow on `main`**: the full pipeline on GitHub
  runners, producing both macOS and Windows artifacts and the same bookkeeping.

A dispatch on any other branch builds artifacts versioned `X.Y.Z-pre.<run>+<sha>` and
never releases.

## The two buttons

**RELEASE MINOR** and **RELEASE MAJOR** live under Actions (`release-minor.yml`,
`release-major.yml`, both calling `promote.yml`). Each one resolves the newest `-pre`
tag, checks out **that commit**, and reruns the build pipeline with the release version
compiled in, so `LGTM 1.7.0` reports `1.7.0`. The tag points at the rebuilt commit; the
Releases README row and its `chore: release` commit land on `main`.

`./scripts/release-local.sh minor` (or `major`) does the same from a Mac, and refuses to
run unless `main` is sitting on the newest pre-release's commit, for the same reason the
buttons rebuild that commit: a release must be a tested pre-release, not whatever is on
`main`.

Only full releases are what `releases/latest` and the auto-updater resolve to:
pre-releases are marked as such on GitHub, and `electron-updater` ignores them unless the
app opts in.

## Day-to-day

```bash
git push origin my-feature-branch    # version + tests on ubuntu, no paid runners
# merge the PR into main             # still no paid runners
./scripts/release-local.sh           # → v1.6.1-pre from your Mac, $0
# …a few of those, then:
./scripts/release-local.sh minor     # → v1.7.0, or press RELEASE MINOR in Actions
```

### Local release prerequisites

- `gh` CLI authenticated with push access to the repo
- **Signing:** a `Developer ID Application` certificate in your login keychain —
  electron-builder auto-discovers it (no env vars). Missing → unsigned build, loud warning.
- **Notarization:** export `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID` (values in 1Password) before running. electron-builder cannot
  read `notarytool` keychain profiles, so the profile alone isn't enough. Missing →
  signed-but-unnotarized build, loud warning. The script never fails on this.

## What gets built

| Platform | Installer | Portable |
|----------|-----------|----------|
| macOS | `LGTM-arm64.dmg` | `LGTM-arm64.zip` |
| Windows | `LGTM-Setup.exe` (NSIS) | `LGTM-Portable.exe` |

Asset names are version-less so the `releases/latest/download/…` links in the README
always resolve to the newest full release.

## Code signing

Sign when the secrets are present, never fail the build when they are absent. macOS
signing and notarization are documented in
[`..Documentation/MAC_CODE_SIGNING.md`](..Documentation/MAC_CODE_SIGNING.md); the CI
secrets are `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID` and the org-level
`LGTM_APPLE_APP_SPECIFIC_PASSWORD`. Windows has no signing identity yet; the intended route
is Azure Artifact Signing (`Platform-Standards/process/versioning-ci.md` → Signing).

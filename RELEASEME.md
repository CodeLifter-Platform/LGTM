# How to Release LGTM

## Quick Release

```bash
git checkout main
git tag v1.0.0
git push origin v1.0.0
```

Replace `v1.0.0` with your desired version. That's it — GitHub Actions handles the rest.

## What Happens Automatically

1. **Build** — macOS and Windows builds run in parallel (~5 min)
2. **Package** — produces `.dmg`, `.zip`, Setup `.exe`, and Portable `.exe`
3. **Release** — a draft GitHub Release is created with all installers attached
4. **README** — download links in `README.md` are updated and committed to `main`

## After the Build Finishes

1. Go to [Releases](https://github.com/CodeLifterIO/LGTM/releases)
2. Find the draft release for your tag
3. Review the auto-generated release notes
4. Click **Publish release** when ready

## Version Numbering

Follow [semver](https://semver.org/): `vMAJOR.MINOR.PATCH`

- **Patch** (`v1.0.1`) — bug fixes, dependency updates
- **Minor** (`v1.1.0`) — new features, backwards compatible
- **Major** (`v2.0.0`) — breaking changes

For pre-release builds: `v1.1.0-beta.1`, `v2.0.0-rc.1`

## Updating package.json Version

Before tagging, update the version in `package.json` to match:

```bash
npm version 1.1.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Bump version to 1.1.0"
git tag v1.1.0
git push origin main --tags
```

Or do it in one step with `npm version`:

```bash
npm version minor            # bumps 1.0.0 → 1.1.0, creates commit + tag
git push origin main --tags  # pushes both the commit and the tag
```

## Manual Build Trigger

To build without creating a release (e.g., for testing):

1. Go to [Actions → Build & Release](https://github.com/CodeLifterIO/LGTM/actions/workflows/build.yml)
2. Click **Run workflow**
3. Select the branch
4. Artifacts will be downloadable from the workflow run (no release created)

## Code Signing (Optional)

To sign builds so users don't see Gatekeeper/SmartScreen warnings:

1. Go to **Settings → Secrets and variables → Actions**
2. Add these secrets:
   - `CSC_LINK` — base64-encoded `.p12` certificate
   - `CSC_KEY_PASSWORD` — certificate password
3. Remove `CSC_IDENTITY_AUTO_DISCOVERY: false` from the workflow

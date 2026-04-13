# How to Release LGTM

## How Versioning Works

Every push triggers a build. The version is fully automatic:

| Component | Source | You touch it? |
|-----------|--------|---------------|
| **Major** | GitHub Actions variable `MAJOR_VERSION` | Only when starting a new major version |
| **Minor** | `GITHUB_RUN_NUMBER` (auto-increments) | Never |
| **Patch** | Always `0` | Never |

### Version format

- **Push to main:** `1.42.0` — creates a tag, builds installers, drafts a GitHub Release
- **Push to any other branch / PR:** `1.42.0-pre.87+abc1234` — builds only, no release

### Example version progression on main

```
1.1.0  →  1.2.0  →  1.3.0  →  ...  →  1.97.0
                                           ↓
                              bump MAJOR_VERSION to 2
                                           ↓
2.98.0  →  2.99.0  →  2.100.0  →  ...
```

The minor number never resets — it's a global build counter. This is intentional: it makes every version globally unique and traceable.

## Day-to-Day Workflow

Just push code. That's it.

```bash
git push origin my-feature-branch   # → builds 1.42.0-pre.87+abc1234
# merge PR to main
# → builds 1.43.0, tags v1.43.0, creates draft release
```

Then go to [Releases](https://github.com/CodeLifterIO/LGTM/releases), review the draft, and publish when ready.

## Bumping the Major Version

When you're ready for a breaking/new-era release:

1. Go to **Settings → Secrets and variables → Actions → Variables** tab
2. Edit `MAJOR_VERSION` (e.g., change `1` to `2`)
3. Next push to main gets the new major: `2.44.0`

That's the only manual step in the entire release process.

## First-Time Setup

Create the `MAJOR_VERSION` variable if it doesn't exist yet:

1. Go to repo **Settings → Secrets and variables → Actions**
2. Click the **Variables** tab
3. Click **New repository variable**
4. Name: `MAJOR_VERSION`, Value: `1`

## Manual Build Without Release

To test builds without creating a release:

1. Go to [Actions → Build & Release](https://github.com/CodeLifterIO/LGTM/actions/workflows/build.yml)
2. Click **Run workflow**
3. Select the branch
4. Download artifacts from the workflow run (prerelease version, no GitHub Release created)

## What Gets Built

| Platform | Installer | Portable |
|----------|-----------|----------|
| macOS | `LGTM-arm64.dmg` | `LGTM-arm64.zip` |
| Windows | `LGTM-Setup.exe` (NSIS) | `LGTM-Portable.exe` |

## Code Signing (Optional)

To sign builds so users don't see Gatekeeper/SmartScreen warnings:

1. Go to **Settings → Secrets and variables → Actions → Secrets**
2. Add these secrets:
   - `CSC_LINK` — base64-encoded `.p12` certificate
   - `CSC_KEY_PASSWORD` — certificate password
3. Remove `CSC_IDENTITY_AUTO_DISCOVERY: false` from `build.yml`

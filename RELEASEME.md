# How to Release LGTM

## How Versioning Works

Every push triggers a build. The version is fully automatic:

| Component | Source | You touch it? |
|-----------|--------|---------------|
| **Major.Minor** | GitHub Actions variable `BASE_VERSION` | Only when bumping minor or major |
| **Patch** | `GITHUB_RUN_NUMBER` (auto-increments) | Never |

### Version format

- **Push to main:** `1.6.7` — creates a tag, builds installers, publishes a GitHub Release
- **Push to any other branch / PR:** `1.6.7-pre.7+abc1234` — builds only, no release

### Example version progression on main

```
1.6.1  →  1.6.2  →  1.6.3  →  ...  →  1.6.50
                                          ↓
                             change BASE_VERSION to "1.7"
                                          ↓
1.7.51  →  1.7.52  →  1.7.53  →  ...
```

The patch number never resets — it's a global build counter. This is intentional: it makes every version globally unique and traceable.

## Day-to-Day Workflow

Just push code. That's it.

```bash
git push origin my-feature-branch   # → builds 1.6.7-pre.7+abc1234
# merge PR to main
# → builds 1.6.8, tags v1.6.8, publishes release
```

## Bumping the Version

When you're ready for a new minor or major:

1. Go to **Settings → Secrets and variables → Actions → Variables** tab
2. Edit `BASE_VERSION` (e.g., change `1.6` to `1.7` or `2.0`)
3. Next push to main picks up the new base: `1.7.<next_run>`

That's the only manual step in the entire release process.

## First-Time Setup

Create the `BASE_VERSION` variable if it doesn't exist yet:

1. Go to repo **Settings → Secrets and variables → Actions**
2. Click the **Variables** tab
3. Click **New repository variable**
4. Name: `BASE_VERSION`, Value: `1.0`

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

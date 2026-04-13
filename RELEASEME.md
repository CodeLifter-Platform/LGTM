# How to Release LGTM

## Automatic Releases (Default)

Just push to `main` using conventional commit messages. The pipeline handles everything:

```bash
git commit -m "feat: add dark mode toggle"
git push origin main
```

The pipeline will:

1. **Scan** commit messages since the last tag
2. **Determine** the semver bump (patch, minor, or major)
3. **Bump** `package.json` and create a git tag
4. **Build** macOS and Windows installers in parallel
5. **Create** a draft GitHub Release with all artifacts
6. **Update** README download links

Then go to [Releases](https://github.com/CodeLifterIO/LGTM/releases), review the draft, and publish.

## Conventional Commit Prefixes

The commit message prefix determines the version bump:

| Prefix | Bump | Example |
|--------|------|---------|
| `fix:` | **patch** (1.0.0 → 1.0.1) | `fix: resolve PAT storage on restart` |
| `perf:` | **patch** | `perf: cache repo file tree responses` |
| `refactor:` | **patch** | `refactor: extract prompt resolver` |
| `feat:` | **minor** (1.0.0 → 1.1.0) | `feat: add per-repo prompt config` |
| `feat!:` | **major** (1.0.0 → 2.0.0) | `feat!: redesign settings panel` |
| anything else | **no release** | `docs: update readme`, `chore: clean up` |

You can also add a scope: `fix(auth): handle expired PAT gracefully`

If no conventional commits are found since the last tag, no release is created.

## Manual Release (Override)

To force a specific version (e.g., for a major release):

```bash
git checkout main
git tag v2.0.0
git push origin v2.0.0
```

This skips the auto-bump and triggers the build directly.

## Manual Build Without Release

To test builds without creating a release:

1. Go to [Actions → Build & Release](https://github.com/CodeLifterIO/LGTM/actions/workflows/build.yml)
2. Click **Run workflow**
3. Select the branch
4. Download artifacts from the workflow run

## What Gets Built

| Platform | Installer | Portable |
|----------|-----------|----------|
| macOS | `.dmg` | `.zip` |
| Windows | Setup `.exe` (NSIS) | Portable `.exe` |

## Code Signing (Optional)

To sign builds so users don't see Gatekeeper/SmartScreen warnings:

1. Go to **Settings → Secrets and variables → Actions**
2. Add these secrets:
   - `CSC_LINK` — base64-encoded `.p12` certificate
   - `CSC_KEY_PASSWORD` — certificate password
3. Remove `CSC_IDENTITY_AUTO_DISCOVERY: false` from `build.yml`

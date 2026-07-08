# How to Release LGTM

## TL;DR — release locally, for $0

Day-to-day releases happen from a dev Mac, not from CI:

```bash
./scripts/release-local.sh
```

The script builds, signs (and notarizes when the Apple env vars are exported —
values in 1Password), inserts the README release-history row, commits
`chore: release <version> [skip ci]` with the stamped `package.json` /
`package-lock.json`, tags, pushes, and publishes a GitHub Release with
generated notes and the `dist/*.dmg`, `dist/*.zip`, and `dist/latest-mac.yml`
artifacts — exactly the bookkeeping the CI release job produces, without
spending a single Actions minute.

## Why CI doesn't build on every push anymore

macOS runners bill at **10x** and Windows at **2x**. Routine pushes and PRs
now run only the cheap ubuntu `version` job. The full pipeline
(`build-mac` + `build-windows` + `release`) is **dispatch-only**: trigger it
manually from [Actions → Build & Release](https://github.com/CodeLifterIO/LGTM/actions/workflows/build.yml)
when you need CI-built artifacts (e.g. the Windows installers, which the
local script doesn't build). A dispatch on `main` publishes a real release;
a dispatch on any other branch produces artifact-only prerelease builds.

The iOS workflow (`.github/workflows/ios.yml`) is dispatch-only for the same
reason — even its simulator build runs on a 10x macOS runner.

## How Versioning Works

| Component | Source | You touch it? |
|-----------|--------|---------------|
| **Major.Minor** | GitHub Actions variable `BASE_VERSION` | Only when bumping minor or major |
| **Patch** | Local script: highest existing `v<BASE>.N` tag + 1. CI: `GITHUB_RUN_NUMBER` | Never |
| **Suffix** | GitHub Actions variable `RELEASE_LEVEL` (`alpha` / `beta` / `rc`, unset = stable) | Only for prerelease lines |

### Version format

- **Local release / dispatch on main:** `1.6.7` — tag, installers, GitHub Release
  (with `RELEASE_LEVEL=beta`: `1.6.7-beta`, published as a GitHub *prerelease*)
- **Push to any branch / PR:** version job only, `1.6.7-pre.7+abc1234`, nothing built
- **Dispatch on another branch:** `1.6.7-pre.7+abc1234` — builds artifacts, no release

`RELEASE_LEVEL` is a workflow capability only — LGTM ships stable versions, so
leave the variable unset unless you deliberately start a prerelease line.

### Example version progression on main

```
1.6.1  →  1.6.2  →  1.6.3  →  ...  →  1.6.50
                                          ↓
                             change BASE_VERSION to "1.7"
                                          ↓
1.7.51  →  1.7.52  →  1.7.53  →  ...
```

The patch number never resets. Don't mix local and CI releases within one
`BASE_VERSION` unless you're sure the CI run counter is behind the tags —
the two counters are independent.

## Day-to-Day Workflow

```bash
git push origin my-feature-branch   # → cheap version job only, no paid runners
# merge PR to main                  # → still no paid runners
./scripts/release-local.sh          # → v1.6.8 released from your Mac, $0
```

### Local release prerequisites

- `gh` CLI authenticated with push access to the repo
- **Signing:** a `Developer ID Application` certificate in your login keychain —
  electron-builder auto-discovers it (no env vars). Missing → unsigned build, loud warning.
- **Notarization:** export `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
  `APPLE_TEAM_ID` (values in 1Password) before running. electron-builder cannot
  read `notarytool` keychain profiles, so the profile alone isn't enough. Missing →
  signed-but-unnotarized build, loud warning. The script never fails on this.

## Bumping the Version

When you're ready for a new minor or major:

1. Go to **Settings → Secrets and variables → Actions → Variables** tab
   (or `gh variable set BASE_VERSION --body "1.7"`)
2. Edit `BASE_VERSION` (e.g., change `1.6` to `1.7` or `2.0`)
3. The next release (local or dispatched) picks up the new base

That's the only manual step in the entire release process.

## First-Time Setup

Create the `BASE_VERSION` variable if it doesn't exist yet:

1. Go to repo **Settings → Secrets and variables → Actions**
2. Click the **Variables** tab
3. Click **New repository variable**
4. Name: `BASE_VERSION`, Value: `1.0`

## Manual CI Build (workflow_dispatch)

To run the full CI pipeline — the only way heavy jobs run now:

1. Go to [Actions → Build & Release](https://github.com/CodeLifterIO/LGTM/actions/workflows/build.yml)
2. Click **Run workflow**
3. Select the branch — `main` publishes a release; any other branch produces
   artifact-only prerelease builds
4. Download artifacts from the workflow run

## What Gets Built

| Platform | Installer | Portable |
|----------|-----------|----------|
| macOS | `LGTM-arm64.dmg` | `LGTM-arm64.zip` |
| Windows | `LGTM-Setup.exe` (NSIS) | `LGTM-Portable.exe` |

## Code Signing (Optional)

To sign builds so users don't see Gatekeeper/SmartScreen warnings.

### macOS — Signing & Notarization with an Apple Developer Account

Since macOS 10.15, distributing a `.dmg` or `.zip` to users outside the App Store requires **both** signing with a Developer ID certificate **and** notarization by Apple. Without both, users see "LGTM is damaged and can't be opened" or "cannot verify developer" warnings.

#### Prerequisites

- A paid **Apple Developer Program** membership ($99/yr): https://developer.apple.com/programs/
- Access to Xcode or Keychain Access on a Mac to generate and export the certificate
- Your Team ID (found at https://developer.apple.com/account under Membership)

#### Step 1 — Create a Developer ID Application certificate

1. Sign in at https://developer.apple.com/account/resources/certificates
2. Click **+** to add a new certificate
3. Under **Software**, choose **Developer ID Application** (not "Mac App Distribution" — that's for the App Store)
4. Follow the prompts to upload a CSR generated from Keychain Access (*Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority → Saved to disk*)
5. Download the resulting `.cer` file and double-click it to install into your login keychain

#### Step 2 — Export the certificate as a `.p12`

1. Open **Keychain Access** → **login** keychain → **My Certificates**
2. Find **Developer ID Application: Your Name (TEAMID)** — it should have a disclosure triangle showing the private key
3. Right-click → **Export** → choose **Personal Information Exchange (.p12)**
4. Set a strong password (you'll need it as `CSC_KEY_PASSWORD`)

#### Step 3 — Create an app-specific password for notarization

Notarization uploads your signed build to Apple and gets a stapled ticket back. It authenticates via an app-specific password, *not* your main Apple ID password.

1. Go to https://account.apple.com → **Sign-In and Security** → **App-Specific Passwords**
2. Generate a new password labelled e.g. `LGTM Notarization`
3. Copy it immediately — Apple only shows it once

#### Step 4 — Add GitHub Actions secrets

Go to **Settings → Secrets and variables → Actions → Secrets** and add:

| Secret | Value |
|--------|-------|
| `CSC_LINK` | base64-encoded contents of the `.p12` file: `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_ID` | your Apple ID email (the one that owns the Developer Program seat) |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from Step 3 |
| `APPLE_TEAM_ID` | your 10-character Team ID from developer.apple.com |

#### Step 5 — Enable signing in the workflow

In `.github/workflows/build.yml`, remove or comment out this line so electron-builder picks up the certificate:

```yaml
CSC_IDENTITY_AUTO_DISCOVERY: false
```

And ensure the notarization env vars are passed to the build step:

```yaml
env:
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

electron-builder auto-detects these and invokes `notarytool` — no extra config needed in `package.json`. The existing `hardenedRuntime: true` and `entitlements` settings in `package.json`'s `build.mac` block are already correct for notarization.

#### Step 6 — Verify

After a successful build, download the DMG and run:

```bash
codesign -dv --verbose=4 /Applications/LGTM.app
spctl -a -vvv -t install /Applications/LGTM.app
```

You should see `Developer ID Application: Your Name` and `source=Notarized Developer ID`.

### Windows

1. Obtain a code-signing certificate (EV or standard) from a CA like DigiCert or Sectigo
2. Add the same `CSC_LINK` / `CSC_KEY_PASSWORD` secrets (electron-builder uses them for both platforms)
3. The Windows build step will pick them up automatically

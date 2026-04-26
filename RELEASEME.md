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

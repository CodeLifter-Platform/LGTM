# macOS Code Signing & Notarisation Runbook

How to make the GitHub Actions macOS build sign and notarise LGTM, so it
opens on a fresh Mac without Gatekeeper warnings.

> **Why this doc exists.** Builds were silently shipping unsigned because the
> uploaded `CSC_LINK` secret held a **Developer ID Installer** certificate
> instead of a **Developer ID Application** certificate. Electron-builder
> happily reports "success" while skipping signing — the only signal is a
> `skipped macOS application code signing` line buried in the log. This
> runbook prevents the same mistake next time.

---

## TL;DR

You need **three** Apple things:

1. A **Developer ID *Application*** certificate (NOT Installer). Issued by
   Apple, installed in your login keychain with its private key, exported
   to `.p12`.
2. An **app-specific password** for your Apple ID, used by notarytool.
3. Your **Apple Team ID** (10-character string).

Those map onto five GitHub Actions secrets:

| Secret name                          | What it holds                                                |
|--------------------------------------|--------------------------------------------------------------|
| `CSC_LINK`                           | Base64 of the `.p12` (the signing certificate + private key) |
| `CSC_KEY_PASSWORD`                   | Password you set when exporting the `.p12`                   |
| `APPLE_ID`                           | Your Apple ID email                                          |
| `LGTM_APPLE_APP_SPECIFIC_PASSWORD`   | App-specific password from appleid.apple.com                 |
| `APPLE_TEAM_ID`                      | 10-char team ID from developer.apple.com → Membership        |

Get all five right and `.github/workflows/build.yml` does the rest.

---

## 1. The cert-type trap (read this first)

Apple issues several certificate products. Two look almost identical in the
portal:

- **Developer ID Application** — signs `.app` bundles, executables,
  frameworks, dylibs. **This is what Electron apps need.**
- **Developer ID Installer** — signs `.pkg` installer packages. LGTM
  doesn't ship as a `.pkg`, so this cert is useless to us.

Electron-builder's failure mode when only Installer is present:

```
skipped macOS application code signing
reason=cannot find valid "Developer ID Application" identity or custom
non-Apple code signing certificate
allIdentities=
  1) ... "Developer ID Installer: <name> (***)"
```

If you see that line in a `build-mac` log, you have the wrong cert in
`CSC_LINK`.

---

## 2. Generate the CSR on your Mac

The certificate's private key must originate on the machine you'll later
sign from (your Mac). You cannot let Apple, GitHub, or anyone else
generate it — they don't have the private half. Apple gives you a public
cert, and only your keychain has the matching private key. The two combined
become the `.p12`.

1. Open **Keychain Access**.
2. Menu → **Keychain Access** → **Certificate Assistant** → **Request a
   Certificate From a Certificate Authority…**
3. Fill in:
   - User Email Address: your Apple ID email
   - Common Name: anything descriptive, e.g. `LGTM Developer ID`
   - CA Email Address: **leave blank**
   - Request is: **Saved to disk**
   - Tick **Let me specify key pair information** (recommended)
4. Click Continue. On the key pair screen pick **RSA / 2048 bits**.
5. Save the `.certSigningRequest` file somewhere you'll find it.

After this, your **login** keychain has a private key labelled "Common
Name" from step 3. Don't delete it — the cert Apple issues binds to that
private key.

---

## 3. Create the Developer ID Application cert at Apple

1. Go to <https://developer.apple.com/account/resources/certificates/list>.
2. Click the **+** to add a certificate.
3. Under **Software** pick **Developer ID Application**. Make sure you do
   **not** pick "Developer ID Installer" — they're on the same page.
4. **Profile Type**: leave the default unless you have a reason; for new
   accounts pick **G2 Sub-CA** (this is Apple's current root, required for
   new certs).
5. Upload the `.certSigningRequest` from step 2.
6. Download the resulting `developerID_application.cer`.

Double-click the `.cer` to install it in your **login** keychain. It
should pair up with the private key from step 2 automatically — verify by
expanding the certificate row in Keychain Access; you should see a private
key nested beneath it. If you don't, signing won't work.

---

## 4. Export to `.p12`

1. In Keychain Access → **login** keychain → **My Certificates** category.
2. Find your new "Developer ID Application: <your name> (TEAMID)" entry.
3. Right-click → **Export "Developer ID Application: …"**.
4. Format: **Personal Information Exchange (.p12)**.
5. Save somewhere temporary (e.g. `~/Desktop/developerID_application.p12`).
6. Set a strong password — **remember this**, it becomes `CSC_KEY_PASSWORD`.
7. macOS will ask for your login password to unlock the private key. Enter it.

Sanity check the file:

```sh
openssl pkcs12 -info -in ~/Desktop/developerID_application.p12 -nodes \
  -passin pass:'<your-p12-password>' 2>/dev/null | grep 'friendlyName' | head
```

You should see `friendlyName: Developer ID Application: <your name>
(TEAMID)`. If it says **Installer**, redo step 4 picking the right cert.

---

## 5. Base64-encode the `.p12`

GitHub secrets can only hold text, so we base64 the binary `.p12`:

```sh
base64 -i ~/Desktop/developerID_application.p12 | pbcopy
```

(Now in your clipboard. No trailing newline issues — `pbcopy` handles it
cleanly. If you can't use `pbcopy`, `base64 -i ... > cert.b64.txt` and open
the file.)

---

## 6. Set GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions → Secrets**. Update
(or create) these:

| Secret                              | Value                                                |
|-------------------------------------|------------------------------------------------------|
| `CSC_LINK`                          | Paste the base64 string from step 5                  |
| `CSC_KEY_PASSWORD`                  | The `.p12` password you set in step 4                |
| `APPLE_ID`                          | Apple ID email (e.g. `you@example.com`)              |
| `LGTM_APPLE_APP_SPECIFIC_PASSWORD`  | See step 7                                           |
| `APPLE_TEAM_ID`                     | 10-char team ID from developer.apple.com → Membership Details |

The workflow at `.github/workflows/build.yml` already wires these into
electron-builder's env. The `CSC_FOR_PULL_REQUEST: 'true'` line lets PR
builds sign too — keep it.

---

## 7. App-specific password for notarytool

Notarisation logs into Apple as you, so it needs an app-specific password
(not your Apple ID login password — Apple won't accept that for automation).

1. Sign in at <https://appleid.apple.com/>.
2. **Sign-In and Security → App-Specific Passwords → Generate Password**.
3. Label it `LGTM notarytool` or similar.
4. Copy the 19-char password (format `xxxx-xxxx-xxxx-xxxx`).
5. Paste it as the value of the `LGTM_APPLE_APP_SPECIFIC_PASSWORD` secret.

If you lose this password you can't recover it — revoke and generate a new
one, then update the secret.

---

## 8. Trigger a build and verify

Push any commit to a branch the workflow runs on (or hit "Re-run all jobs"
on an existing run). Then check the `build-mac` log:

**Good signs:**

```
• signing       file=dist/mac-arm64/LGTM.app identityName=Developer ID Application: ...
• notarization started
• notarization successful
```

**Bad signs (you missed something):**

- `skipped macOS application code signing` — wrong cert type, redo from step 3.
- `Current build is a part of pull request, code signing will be skipped.`
  — `CSC_FOR_PULL_REQUEST` env isn't set in the workflow step. (We do set
  it; if you see this you've reverted the line.)
- `unable to find a valid identity` — `CSC_LINK` is corrupted or
  `CSC_KEY_PASSWORD` doesn't unlock it.
- `Invalid credentials. Username or password is incorrect.` during
  notarisation — `APPLE_ID` / `LGTM_APPLE_APP_SPECIFIC_PASSWORD` /
  `APPLE_TEAM_ID` mismatch. Apple is picky: the team ID must match the team
  that owns the cert.

**Quick grep from `gh`:**

```sh
gh run view <run-id> --log --job <build-mac-job-id> 2>/dev/null \
  | grep -iE 'signing|notariz|skipped|identity'
```

---

## 9. Verify a downloaded artifact

Once a build succeeds, download the DMG from the release or artifact page
and run:

```sh
codesign -dv --verbose=4 /Volumes/LGTM/LGTM.app
spctl --assess --type execute --verbose /Volumes/LGTM/LGTM.app
xcrun stapler validate /Volumes/LGTM/LGTM.app
```

Expected:

- `codesign` prints `Authority=Developer ID Application: <name> (TEAMID)`
  and `TeamIdentifier=<TEAMID>`.
- `spctl` prints `accepted source=Notarized Developer ID`.
- `stapler validate` prints `The validate action worked!` (means the
  notarisation ticket was stapled, so Gatekeeper works offline).

Any other output = something in steps 1–7 is wrong.

---

## Renewal

- The **Developer ID Application** cert expires 5 years from issue. Apple
  doesn't email a reminder; calendar it.
- App-specific passwords don't expire but break if you change your Apple
  ID password — regenerate and re-paste into the secret.
- If you rotate the cert, redo steps 2–6 and update `CSC_LINK` +
  `CSC_KEY_PASSWORD`. Apps signed with the old cert remain valid until the
  old cert is revoked, so there's no urgency to rebuild old releases.

---

## Common pitfalls

- **Two certs in the keychain with the same name.** If you accidentally
  generate two Application certs, both end up in `.p12` and electron-builder
  picks the first. Delete the older one in Keychain Access before exporting.
- **Exporting the cert without its private key.** If Keychain Access asks
  only for the cert (no password prompt for the private key), the private
  key isn't paired. Go back to step 3 — the `.cer` must be installed in the
  same keychain that holds the private key from step 2.
- **CSC_LINK with a trailing newline.** Some terminals add one when copying.
  GitHub's secret editor trims trailing whitespace, but if you paste through
  an intermediate file, strip newlines: `tr -d '\n' < cert.b64.txt | pbcopy`.
- **Team ID confusion.** It's the 10-char ID (e.g. `AB12CD34EF`), not the
  team *name*. Find it on developer.apple.com → Membership Details.
- **Notarytool vs. altool.** Older guides reference `altool`; Apple
  deprecated it. electron-builder uses `notarytool` automatically with the
  three Apple env vars above — you don't need to install anything.

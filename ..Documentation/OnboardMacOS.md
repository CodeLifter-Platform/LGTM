# Onboarding — macOS

## Prerequisites

| Need | Version | Check |
|---|---|---|
| Node.js | 20.x (what CI uses) | `node --version` |
| npm | bundled with Node | `npm --version` |

## Get the code, install, run

```bash
git clone https://github.com/CodeLifter-Platform/LGTM.git
cd LGTM
npm install
npm start
```

**What you should see:** no dock icon and no window — LGTM hides the dock on macOS and
lives in the menu bar. Click the tray icon to open the popover. If you are looking for a
window in the taskbar, you are looking in the wrong place.

You will need an Azure DevOps organisation URL and a PAT; the PAT is stored in the
Keychain via keytar, not in the config file.

## Package

```bash
npm run build:mac
```

Signing and notarization turn on automatically when the credentials are present, and are
skipped otherwise. Detail: [`MAC_CODE_SIGNING.md`](MAC_CODE_SIGNING.md).

## Gotchas

- **The window hides on blur** by design — it is a popover, not an app window. Clicking
  elsewhere making it vanish is correct behaviour.
- **Closing the window only hides it.** The process survives in the tray; quit from the
  tray menu.
- **`keytar` is a native module.** After a Node or Electron version change, run
  `npm install` again so it rebuilds, or you will get a runtime load error that looks like
  a missing dependency.

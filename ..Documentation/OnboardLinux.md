# Onboarding — Linux

**Read this before assuming the app is broken.** LGTM behaves deliberately differently on
Linux from macOS and Windows.

## Prerequisites

| Need | Version | Check |
|---|---|---|
| Node.js | 20.x | `node --version` |
| libsecret | for `keytar` | `pkg-config --exists libsecret-1; echo $?` |
| A running keyring | gnome-keyring or KWallet | — |
| `xz-utils` | only to build the `.deb` | `xz --version` |

## Get the code, install, run

```bash
git clone https://github.com/CodeLifter-Platform/LGTM.git
cd LGTM
npm install
npm start
```

**What you should see:** an ordinary application window, framed, in the taskbar, opening at
launch. That is not a bug and not a fallback — it is the intended Linux behaviour.

## Why the window model differs

On macOS and Windows the window is a frameless popover anchored to the tray. On Linux that
model is unsafe: tray support varies by desktop (GNOME needs an extension), and Electron
does not support `tray.getBounds()` there, so positioning would put the window off-screen
at 0,0 even when a tray existed. A tray-only app on a desktop without a working tray has
**no way to be opened at all**.

So on Linux, behind a `TRAY_ONLY` flag: the window is framed, in the taskbar, shown at
launch, hide-on-blur is off, positioning centres instead of reading tray bounds, a tray
construction failure is caught rather than fatal, and relaunching from the launcher
re-shows an existing window rather than doing nothing.

## Package

```bash
npm run build:linux
```

Produces an AppImage and a `.deb`. **AppImage first is not cosmetic** — `electron-updater`
cannot auto-update a `.deb`, so it is the only Linux format where updates keep working.

## Gotchas

- **Nobody has watched this run yet.** The Linux window path is a targeted fix for a
  problem visible in the source, but it has not been observed working on a real desktop.
  If you are reading this on Linux, you are likely the first — report what you see.
- **`.deb` builds need `xz-utils`.** fpm shells out to `tar` with an xz compressor and
  fails with a bare `tar failed (exit code 2)` without it. `ubuntu-latest` has it; slim
  containers do not.
- **`keytar` needs libsecret and a running keyring.** Without them, credential storage
  fails at runtime rather than at install.
- **Tray icons are unreliable.** GNOME needs an extension. If no tray icon appears, that is
  expected — use the window, which is why it exists.

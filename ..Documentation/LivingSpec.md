# LGTM — Living Spec

The current state of the application. Maintained alongside the code: a change that alters
what LGTM does updates this file in the same commit.

## What it is

LGTM is a **menu-bar app that lists your open Azure DevOps pull requests and runs
AI-powered code reviews on them with one click**. It is the platform's only Electron/Node
app; the .NET conventions in the harness do not apply here, but design tokens, theming,
versioning, and release conventions do.

## Status

**Shipping.** `BASE_VERSION` 1.6 — the most mature app on the platform, and the only one
past the 0.9 line. This repo is **public**.

## Features

**Working today**

- **Azure DevOps PR listing** through `devops-client.js`, authenticated with a PAT.
- **One-click AI review**, run by `agent-runner.js` against an agent from
  `agent-registry.js`, with prompts resolved by `prompt-resolver.js` and attachments by
  `prompt-attachments.js`.
- **Model discovery** (`model-discovery.js`) that refreshes the available model list in the
  background, showing a hardcoded fallback immediately so the UI is never empty.
- **Repository cloning** (`repo-cloner.js`) so reviews run against real checkouts.
- **A webhook server** (`webhook-server.js`) for event-driven triggers.
- **Auto-update** via `electron-updater`, with native notifications on update available
  and update ready.
- **Credential storage in the OS keychain** via `keytar`, which uses libsecret on Linux —
  so unlike Specter and Reps, LGTM already had a working Linux secret backend.

## Architecture

Electron, main process in `src/main/`:

| File | Role |
|---|---|
| `main.js` | Lifecycle, tray, window, IPC, auto-updater |
| `devops-client.js` | Azure DevOps API |
| `agent-runner.js`, `agent-registry.js` | Review execution and agent catalogue |
| `prompt-resolver.js`, `prompt-attachments.js`, `scenario-prompts.js` | Prompt construction |
| `pat-store.js` | PAT persistence via keytar |
| `repo-cloner.js`, `webhook-server.js`, `model-discovery.js` | Supporting services |

Renderer in `src/renderer/`, preload bridge in `src/main/preload.js` with
`contextIsolation: true` and `nodeIntegration: false`.

## Window model — and why it differs per platform

On **macOS and Windows** the window is a frameless popover hanging off the tray:
`show: false`, `frame: false`, `skipTaskbar: true`, `alwaysOnTop: true`, positioned from
`tray.getBounds()`, and hidden on blur. The dock icon is hidden on macOS.

On **Linux** that model does not work. Tray support varies by desktop (GNOME needs an
extension) and Electron does not support `tray.getBounds()` there, so a tray-only app can
end up with **no way to be opened at all**. Linux therefore gets an ordinary window —
framed, in the taskbar, shown at launch, no hide-on-blur — and a tray construction failure
is caught and logged rather than fatal. All of this is behind a `TRAY_ONLY` flag.

## Data and state

`electron-store` for configuration (org URL, webhook port, polling interval, agent and
model selections, per-repo prompt configuration, starred repos, filters). The **Azure
DevOps PAT lives in the OS keychain** via keytar, never in the config store.

## External services

Azure DevOps, plus the AI providers used for reviews. Canonical inventory:
[`SERVICES.md`](../SERVICES.md).

## Platform matrix

| Platform | Ships | Format |
|---|---|---|
| macOS | ✅ | `.dmg` + `.zip`, signed and notarized |
| Windows | ✅ | NSIS installer + portable |
| Linux | ✅ | AppImage + `.deb` |

**AppImage is not optional on Linux**: `electron-updater` cannot auto-update a `.deb`, so it
is the only Linux format where the existing update flow keeps working.

Because this repo is **public**, macOS and Windows builds stay on GitHub-hosted runners and
are `workflow_dispatch`-gated — macOS bills at 10× and Windows at 2×, so pushes and PRs run
only the cheap ubuntu version job. Day-to-day releases happen for free from a dev Mac via
`scripts/release-local.sh`. That is the documented public-repo pattern, not a deviation.

## Known gaps

- **The Linux window path has never been observed working.** The tray-independent window is
  a targeted fix for a problem plain in the source, but nobody has watched it run. Electron
  under emulation on the Apple Silicon dev host crashes before it can be checked.
- **Tray behaviour on Linux is untested** across GNOME and KDE.
- **README badges and download links still point at `CodeLifterIO/LGTM`**, the old
  user-owned location, while the repo lives under the org. The update feed itself was
  fixed; the README links were not.
- **`docs/` is the GitHub Pages source** (`main//docs`, serving
  `codelifter-platform.github.io/LGTM`). It is a landing page, not documentation, and must
  not be renamed — doing so would take the published site down. Only
  `MAC_CODE_SIGNING.md` moved out of it into this folder.

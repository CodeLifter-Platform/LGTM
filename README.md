# LGTM — Azure DevOps PR Reviewer

A cross-platform menu bar app that lists your open Azure DevOps pull requests and runs AI-powered code reviews with a single click.

[![Build & Release](https://github.com/CodeLifterIO/LGTM/actions/workflows/build.yml/badge.svg)](https://github.com/CodeLifterIO/LGTM/actions/workflows/build.yml)
[![Latest Release](https://img.shields.io/github/v/release/CodeLifterIO/LGTM?include_prereleases&label=latest)](https://github.com/CodeLifterIO/LGTM/releases/latest)

## Download

| Platform | Installer | Portable |
|----------|-----------|----------|
| **macOS** | [LGTM.dmg](https://github.com/CodeLifterIO/LGTM/releases/latest/download/LGTM.dmg) | [LGTM-mac.zip](https://github.com/CodeLifterIO/LGTM/releases/latest/download/LGTM-mac.zip) |
| **Windows** | [LGTM-Setup.exe](https://github.com/CodeLifterIO/LGTM/releases/latest/download/LGTM-Setup.exe) | [LGTM-Portable.exe](https://github.com/CodeLifterIO/LGTM/releases/latest/download/LGTM-Portable.exe) |

> **Note:** The app is not code-signed yet. On macOS, right-click → Open to bypass Gatekeeper. On Windows, click "More info" → "Run anyway" in SmartScreen.

## Features

- **Multi-agent support** — choose between Claude Code, Codex, and Augment Code, each with selectable models
- **Clone-then-review** — shallow-clones the repo remotely using your PAT, runs the agent against the full codebase in an isolated temp directory
- **Streaming review output** — real-time markdown-rendered review results streamed directly into the app
- **Per-repo prompt configuration** — auto-detect from repo conventions, specify a file in the repo with autocomplete, set a custom local path with a native file picker, or fall back to a global default
- **Secure PAT storage** — your Azure DevOps Personal Access Token is stored in the OS keychain (macOS Keychain / Windows Credential Manager) with encrypted fallback
- **Live PR list** — all active PRs from your org displayed as `Repo/PrId/PRName`, sorted by creation date (newest first)
- **Status indicators** — pulsing yellow (cloning/in progress), green (completed), red (failed)
- **Webhook + polling** — real-time updates via Azure DevOps Service Hooks with polling fallback
- **Concurrent reviews** — run multiple reviews across different PRs simultaneously

## Prerequisites

- **Node.js** 18+ and **npm**
- At least one AI agent CLI installed and in PATH: `claude`, `codex`, or `auggie`
- An **Azure DevOps PAT** with at least `Code (Read)` scope

## Quick Start

```bash
npm install
npm start
```

On first launch the app appears in your menu bar / system tray and prompts for your Azure DevOps org URL and PAT.

## Building from Source

```bash
# macOS (.dmg + .zip)
npm run build:mac

# Windows (.exe installer + portable)
npm run build:win

# Both
npm run build:all

# Quick unpacked build for testing
npm run build:mac:dir    # → dist/mac/LGTM.app
npm run build:win:dir    # → dist/win-unpacked/LGTM.exe
```

## Configuration

Access settings via the gear icon in the app toolbar or right-click the tray icon → Settings.

| Setting | Default | Description |
|---------|---------|-------------|
| Default agent | Claude | Which AI agent to use for reviews |
| Agent model | Per-agent default | Model selection per agent (e.g., Opus 4.6, Sonnet 4.6, o4-mini) |
| Global prompt path | *(bundled)* | Fallback prompt file if no repo-specific prompt is found |
| Webhook port | `3847` | Port for Azure DevOps Service Hook events |
| Polling interval | `60s` | PR list refresh interval |

### Per-Repo Prompt Resolution

When starting a review, the prompt is resolved in this order:

1. **Custom local path** — an absolute path on your machine configured per-repo in settings
2. **Specific repo file** — a file path within the repo configured per-repo (with autocomplete)
3. **Convention auto-detect** — scans the cloned repo for: `NYLE_PR_PROMPT.md`, `.lgtm/review-prompt.md`, `.github/pr-review-prompt.md`, `PR_REVIEW_PROMPT.md`
4. **Global custom path** — the global prompt path from settings
5. **Bundled default** — `resources/NYLE_PR_PROMPT.md` shipped with the app

## Architecture

```
src/
├── main/
│   ├── main.js              # Electron main process, tray, window, IPC
│   ├── preload.js           # Context bridge (renderer ↔ main)
│   ├── pat-store.js         # Keytar + encrypted electron-store dual storage
│   ├── devops-client.js     # Azure DevOps REST API client
│   ├── agent-registry.js    # Agent discovery (claude, codex, auggie)
│   ├── agent-runner.js      # Clone → resolve prompt → spawn agent → stream output
│   ├── repo-cloner.js       # Shallow git clone into temp directories
│   ├── prompt-resolver.js   # Per-repo prompt resolution chain
│   └── webhook-server.js    # HTTP server for DevOps webhooks
├── renderer/
│   ├── index.html           # App UI (PAT setup, PR list, review detail, settings)
│   ├── styles.css           # Dark theme
│   └── app.js               # UI logic, streaming output, repo config
└── assets/
    └── tray-icon*.png       # Menu bar icons (Template for macOS, colour for Windows)
```

## License

MIT

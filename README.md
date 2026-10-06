# LGTM — PR Reviewer for Azure DevOps and GitHub

A cross-platform menu bar app that lists your open pull requests, bugs and tickets from Azure DevOps and GitHub and runs AI-powered agents against them with a single click. A provider filter at the top of the toolbar switches between the services you have connected.

[![Build & Release](https://github.com/CodeLifter-Platform/LGTM/actions/workflows/build.yml/badge.svg)](https://github.com/CodeLifter-Platform/LGTM/actions/workflows/build.yml)
[![Latest Release](https://img.shields.io/github/v/release/CodeLifter-Platform/LGTM?include_prereleases&label=latest)](https://github.com/CodeLifter-Platform/LGTM/releases/latest)

**Repository:** <https://github.com/CodeLifter-Platform/LGTM>

## Downloads

Asset names are version-less, so the direct links below always resolve to the newest
**full release**. Pre-releases are marked as such on GitHub, which `releases/latest`
skips, and the in-app updater ignores them too.

### Download Latest

| Platform | Installer | Portable |
|----------|-----------|----------|
| **macOS (Apple Silicon)** | [LGTM-arm64.dmg](https://github.com/CodeLifter-Platform/LGTM/releases/latest/download/LGTM-arm64.dmg) | [LGTM-arm64.zip](https://github.com/CodeLifter-Platform/LGTM/releases/latest/download/LGTM-arm64.zip) |
| **Windows** | [LGTM-Setup.exe](https://github.com/CodeLifter-Platform/LGTM/releases/latest/download/LGTM-Setup.exe) | [LGTM-Portable.exe](https://github.com/CodeLifter-Platform/LGTM/releases/latest/download/LGTM-Portable.exe) |

> **Note:** On macOS, right-click → Open if Gatekeeper objects to an unnotarized build. On Windows, click "More info" → "Run anyway" in SmartScreen.

## Releases

Cut deliberately with the **RELEASE MINOR** / **RELEASE MAJOR** buttons in Actions (or
`scripts/release-local.sh minor|major`). Each one rebuilds a tested pre-release's commit
with the release version compiled in. Versions derive from git tags; see
[RELEASEME.md](RELEASEME.md).

<!-- releases:insert -->
| Version | Date | Downloads | Rebuilt from | Notes |
|---|---|---|---|---|
| v0.5.58 | 2026-05-13 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.58/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.58/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.58/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.58/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.58) |
| v0.5.54 | 2026-05-13 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.54/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.54/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.54/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.54/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.54) |
| v0.5.39 | 2026-05-13 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.39/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.39/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.39/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.39/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.39) |
| v0.5.25 | 2026-04-29 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.25/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.25/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.25/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.25/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.25) |
| v0.5.23 | 2026-04-28 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.23/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.23/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.23/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.23/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.23) |
| v0.5.22 | 2026-04-26 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.22/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.22/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.22/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.22/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.22) |
| v0.5.21 | 2026-04-26 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.21/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.21/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.21/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.21/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.21) |
| v0.5.8 | 2026-04-13 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.8/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.8/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.8/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.8/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.8) |
| v0.5.7 | 2026-04-13 | [dmg](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.7/LGTM-arm64.dmg) · [zip](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.7/LGTM-arm64.zip) · [installer](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.7/LGTM-Setup.exe) · [portable](https://github.com/CodeLifter-Platform/LGTM/releases/download/v0.5.7/LGTM-Portable.exe) | — | [Release notes](https://github.com/CodeLifter-Platform/LGTM/releases/tag/v0.5.7) |

## Pre-releases

Patch + 1 per cut, signed, marked as a prerelease on GitHub. On this public repo they are
cut by a `workflow_dispatch` on `main` or by `scripts/release-local.sh`, not by the merge
itself (the macOS and Windows legs are dispatch-only).

<!-- prereleases:insert -->
| Version | Date | Downloads | Commit | Notes |
|---|---|---|---|---|


## Features

- **Two git services** — connect Azure DevOps and GitHub (github.com or GitHub Enterprise) side by side, each with its own token, and switch between them with the provider filter
- **Multi-agent support** — choose between Claude Code, Codex, and Augment Code, each with selectable models
- **Clone-then-review** — partial-clones the repo using the service's token, runs the agent against the full codebase in an isolated temp directory
- **Streaming review output** — real-time markdown-rendered review results streamed directly into the app
- **Per-repo prompt configuration** — auto-detect from repo conventions, specify a file in the repo with autocomplete, set a custom local path with a native file picker, or fall back to a global default
- **Secure token storage** — each service's token is stored in the OS keychain (macOS Keychain / Windows Credential Manager / libsecret) with an encrypted fallback
- **CodeLifter Design System** — dark and light themes from the platform tokens, Inter and JetBrains Mono bundled
- **Live PR list** — all open PRs from your org or owner, grouped by repository, sorted by creation date (newest first)
- **Status indicators** — pulsing yellow (cloning/in progress), green (completed), red (failed)
- **Webhook + polling** — real-time updates via Azure DevOps Service Hooks or GitHub webhooks, with polling fallback
- **Concurrent reviews** — run multiple reviews across different PRs simultaneously

## Prerequisites

- **Node.js** 18+ and **npm**
- At least one AI agent CLI installed and in PATH: `claude`, `codex`, or `auggie`
- An **Azure DevOps PAT** (Code, Work Items, Pull Request Threads) and/or a **GitHub token** (`repo`, `read:org`, `read:user`)

## Quick Start

```bash
npm install
npm start
```

On first launch the app appears in your menu bar / system tray and asks you to connect a service: pick Azure DevOps or GitHub, paste the URL and a token. The other service can be added later from Settings → Connections or from the provider filter.

```bash
npm test                  # the Node test suite
npm run test:coverage     # same, with the coverage table
```

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
| Webhook port | `3847` | Port for Azure DevOps Service Hook and GitHub webhook events |
| Polling interval | `60s` | PR list refresh interval |

### Per-Repo Prompt Resolution

When starting a review, the prompt is resolved in this order:

1. **Custom local path** — an absolute path on your machine configured per-repo in settings
2. **Specific repo file** — a file path within the repo configured per-repo (with autocomplete)
3. **Convention auto-detect** — scans the cloned repo for: `.lgtm/review-prompt.md`, `.github/pr-review-prompt.md`, `PR_REVIEW_PROMPT.md`, `NYLE_PR_PROMPT.md`
4. **Global custom path** — the global prompt path from settings
5. **Bundled default** — `resources/REPO_REVIEW_TEMPLATE.md` shipped with the app

## Architecture

```
src/
├── main/
│   ├── main.js              # Electron main process, tray, window, IPC
│   ├── preload.js           # Context bridge (renderer ↔ main)
│   ├── token-store.js       # Per-service keytar + encrypted electron-store dual storage
│   ├── providers/           # Provider registry + GitHub REST/GraphQL client
│   ├── devops-client.js     # Azure DevOps REST API client
│   ├── agent-registry.js    # Agent discovery (claude, codex, auggie)
│   ├── agent-runner.js      # Clone → resolve prompt → spawn agent → stream output
│   ├── repo-cloner.js       # Shallow git clone into temp directories
│   ├── prompt-resolver.js   # Per-repo prompt resolution chain
│   └── webhook-server.js    # HTTP server for Azure DevOps service hooks and GitHub webhooks
├── renderer/
│   ├── index.html           # App UI (PAT setup, PR list, review detail, settings)
│   ├── styles.css           # Dark theme
│   └── app.js               # UI logic, streaming output, repo config
└── assets/
    └── tray-icon*.png       # Menu bar icons (Template for macOS, colour for Windows)
```

## Future Enhancements

Ideas considered and parked, kept here so they don't get lost:

- **Chained Ticket → Review → Resolve flow.** After the ticket prompt opens a PR, optionally run the review prompt against that PR, then the resolve prompt against the resulting threads — all before handing the PR to the human. Promising in theory (one-shot end-to-end), but only worth building once the agent runner can pin **different models to each phase**: single-model self-review is weak signal because the model that wrote the code is the worst candidate to find its own blind spots, and the resolver would rubber-stamp its own review. Until per-phase model selection lands, the safer pre-flight is a self-audit step inside the ticket prompt (read your own diff against the rule stack and acceptance criteria, list weak spots under **Flags for Reviewer**), and let the next independent LGTM run drive the actual review.

## License

MIT

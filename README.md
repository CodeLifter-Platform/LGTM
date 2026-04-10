# LGTM — Azure DevOps PR Reviewer

A menu bar app (macOS + Windows) that lists your open Azure DevOps pull requests and kicks off **Claude Code** reviews with a single click.

## Features

- **Secure PAT storage** — your Azure DevOps Personal Access Token is stored in the OS keychain (macOS Keychain / Windows Credential Manager), never on disk.
- **First-run validation** — the app won't proceed until your PAT is verified against your org.
- **Live PR list** — all open PRs across every repo in your org, displayed as `Repo/PrId/PRName`.
- **One-click Claude Code review** — click a PR to launch a headless Claude Code process that reviews the branch and posts comments directly into Azure DevOps.
- **Status indicators**:
  - Pulsing yellow dot — review in progress
  - Green circle — approved / review completed
  - Red circle — rejected / review failed
- **Webhook support** — optional real-time updates via Azure DevOps Service Hooks (falls back to polling).

## Prerequisites

- **Node.js** 18+ and **npm**
- **Claude Code** CLI installed and authenticated (`claude` command available in PATH)
- An **Azure DevOps PAT** with at least `Code (Read & Write)` scope

## Quick Start

```bash
cd lgtm-app
npm install
npm start
```

On first launch the app will appear in your menu bar / system tray and prompt you to enter your Azure DevOps org URL and PAT.

## Building Distributable Binaries

```bash
# macOS (.dmg + .zip)
npm run build:mac

# Windows (.exe installer + portable)
npm run build:win

# Both
npm run build:all
```

Output goes to `dist/`.

## Configuration

Access settings from the tray icon right-click menu or the gear icon inside the app.

| Setting | Default | Description |
|---------|---------|-------------|
| Custom prompt path | *(bundled)* | Absolute path to your own `NYLE_PR_PROMPT.md`. Leave blank to use the bundled default. You can also place a `NYLE_PR_PROMPT.md` in your repo root. |
| Webhook port | `3847` | Port for the local webhook server that receives Azure DevOps Service Hook events. |
| Polling interval | `60s` | How often to poll for new/updated PRs (webhook is instant but polling is the fallback). |

## Azure DevOps Webhook Setup (Optional)

For real-time PR updates instead of polling:

1. Go to your Azure DevOps project → **Project Settings** → **Service Hooks**
2. Click **Create Subscription** → choose **Web Hooks**
3. Set the trigger to **Pull request created** and/or **Pull request updated**
4. Set the URL to `http://<your-machine-ip>:3847/webhook`
5. For remote access, use a tunnel service (ngrok, Cloudflare Tunnel, etc.)

## Prompt Resolution Order

When launching a Claude Code review, the app looks for the review prompt in this order:

1. **User-configured path** — set in Settings
2. **Bundled default** — `resources/NYLE_PR_PROMPT.md` shipped with the app

Claude Code itself will also look for a `NYLE_PR_PROMPT.md` in the repo root if instructed.

## Architecture

```
lgtm-app/
├── src/
│   ├── main/
│   │   ├── main.js            # Electron main process, tray, IPC
│   │   ├── preload.js         # Context bridge (renderer ↔ main)
│   │   ├── pat-store.js       # Keytar-based secure PAT storage
│   │   ├── devops-client.js   # Azure DevOps REST API client
│   │   ├── claude-runner.js   # Spawns headless Claude Code processes
│   │   └── webhook-server.js  # HTTP server for DevOps webhooks
│   ├── renderer/
│   │   ├── index.html         # App UI shell
│   │   ├── styles.css         # Dark theme styles
│   │   └── app.js             # UI logic and IPC calls
│   └── assets/
│       └── tray-icon*.png     # Menu bar icons
├── resources/
│   ├── NYLE_PR_PROMPT.md      # Default review prompt
│   └── entitlements.mac.plist # macOS code-signing entitlements
├── package.json
└── README.md
```

## License

MIT

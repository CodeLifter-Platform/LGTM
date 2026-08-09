# Onboarding — Windows

## Prerequisites

| Need | Version | Check |
|---|---|---|
| Node.js | 20.x | `node --version` |
| Build tools | for native modules (`keytar`) | — |

## Get the code, install, run

```powershell
git clone https://github.com/CodeLifter-Platform/LGTM.git
cd LGTM
npm install
npm start
```

**What you should see:** a tray icon; click it for the popover window. The window is
frameless and does not appear in the taskbar by design.

## Package

```powershell
npm run build:win
```

Produces an NSIS installer and a portable build.

## Gotchas

- **`keytar` needs native build tools.** If `npm install` fails compiling it, install the
  Visual Studio Build Tools with the C++ workload; this is the most common first-run
  failure on Windows.
- **The PAT lives in Windows Credential Manager** through keytar, not in the config store.
  It does not travel with a copied profile.
- **Windows CI bills at 2×**, so the Windows build is `workflow_dispatch`-only. Pushes run
  just the ubuntu version job.

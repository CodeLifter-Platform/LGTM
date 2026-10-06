# CLAUDE.md — LGTM

> **Platform standards:** this repo follows the CodeLifter harness in the sibling
> `Platform-Standards` repo (`../Platform-Standards/HARNESS.md` locally, loaded
> automatically via the folder-level CLAUDE.md symlink; otherwise
> `github.com/CodeLifter-Platform/Platform-Standards`). If that file isn't on disk —
> CI, cloud, or a lone clone — fetch it before doing UI, architecture, or CI work.
>
> **Design system:** new UI is built from the **CodeLifter Design System** in the sibling
> `Platform-Design` repo (`../Platform-Design/readme.md` locally; otherwise
> `github.com/CodeLifter-Platform/Platform-Design`). Read `readme.md`, then `tokens/`, then
> the component's `.prompt.md` — before any markup. If it doesn't have the component, token,
> accent, or pattern the work needs, stop and ask for it to be added — don't invent or
> approximate one. Rules: `Platform-Standards/design/design-system.md`.

<!-- App-specific rules only. Platform-wide standards live in the harness. -->

LGTM is a cross-platform menu-bar app that lists your open pull requests, bugs and tickets
from Azure DevOps and GitHub and runs AI-powered agents on them with one click. It is the
platform's one Electron/Node app; the .NET conventions in the harness do not apply here,
but design tokens, theming, versioning, and release conventions do.

## Quick start

```bash
npm install
npm start
npm test          # node --test over tests/; no Electron needed
```

```bash
npm run build:mac
```

## App-specific notes

- **This repo is PUBLIC**, and its cost model reflects that: pushes and PRs run only the
  ubuntu version + test jobs, while the macOS (10×) and Windows (2×) builds are
  `workflow_dispatch`-only. Versions derive from git tags (`.github/scripts/next-version.sh`);
  the one departure from the platform default is that a merge into `main` builds nothing,
  so the pre-release is cut by a dispatch on `main` or by `scripts/release-local.sh`, and
  the RELEASE MINOR / MAJOR buttons promote it. See `RELEASEME.md`. This is the documented
  public-repo pattern in `Platform-Standards/process/versioning-ci.md`, not a deviation.
- **Electron, so no `global.json` / `Directory.*.props`.** The .NET conformance check
  skips this repo automatically because it has no root `.sln`.
- **Design tokens live in `src/renderer/tokens.css`**, a verbatim port of
  `Platform-Design/tokens/*.css` in the design system's own CSS notation (light is the
  design system's light-cool scope). `styles.css` references tokens only; `ios/LGTM/Theme.swift`
  mirrors the same values. Change the port and the mirror in the same commit.
- **Git services are providers** (`src/main/providers/`). Every PR / work item row carries
  `provider`; the renderer never branches on the service beyond number prefixes and hint
  nouns. A new service is one registry entry, a client with the same row shapes, a prompt
  set under `resources/prompts/<id>/`, and a `token-store.js` entry.
- **The scenario prompt files are verbatim inputs.** The Azure DevOps set at
  `resources/prompts/` and the GitHub set in `resources/prompts/github/` differ only in
  the service-access sections; keep them in step when changing workflow text.
- **Parity gap, recorded:** the iPad head under `ios/` is Azure DevOps only (no GitHub
  client, no provider switch). See `..Documentation/LivingSpec.md` → Known gaps.

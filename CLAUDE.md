# CLAUDE.md — LGTM

> **Platform standards:** this repo follows the CodeLifter harness in the sibling
> `Platform-Standards` repo (`../Platform-Standards/HARNESS.md` locally, loaded
> automatically via the folder-level CLAUDE.md symlink; otherwise
> `github.com/CodeLifter-Platform/Platform-Standards`). If that file isn't on disk —
> CI, cloud, or a lone clone — fetch it before doing UI, architecture, or CI work.
>
> **Design system:** new UI is built from the claude.ai/design project **CodeLifter Design
> System** (read it with `DesignSync`). If it doesn't have the component, token, accent, or
> pattern the work needs, stop and ask for it to be added — don't invent or approximate one.
> Rules: `Platform-Standards/design/design-system.md`.

<!-- App-specific rules only. Platform-wide standards live in the harness. -->

LGTM is a cross-platform menu-bar app that lists your open Azure DevOps pull requests and
runs AI-powered code reviews on them with one click. It is the platform's one
Electron/Node app; the .NET conventions in the harness do not apply here, but design
tokens, theming, versioning, and release conventions do.

## Quick start

```bash
npm install
npm start
```

```bash
npm run build:mac
```

## App-specific notes

- **This repo is PUBLIC**, and its cost model reflects that: pushes and PRs run only the
  ubuntu version job, while the macOS (10×) and Windows (2×) builds are
  `workflow_dispatch`-only. Day-to-day releases happen for free from a dev Mac via
  `scripts/release-local.sh`. This is the documented public-repo pattern in
  `Platform-Standards/process/versioning-ci.md`, not a deviation.
- **Badges and download links still point at `CodeLifterIO/LGTM`** (the old user-owned
  location) while the repo itself lives under the `CodeLifter-Platform` org. Fix the
  README links when convenient; the org repo is canonical.
- **Electron, so no `global.json` / `Directory.*.props`.** The .NET conformance check
  skips this repo automatically because it has no root `.sln`.

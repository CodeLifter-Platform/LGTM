# LGTM — Living Spec

The current state of the application. Maintained alongside the code: a change that alters
what LGTM does updates this file in the same commit.

## What it is

LGTM is a **menu-bar app that lists your open pull requests and work items from Azure
DevOps and GitHub, and runs AI-powered agents against them with one click**: review a PR,
resolve its review comments, or implement a bug or ticket. It is the platform's only
Electron/Node app; the .NET conventions in the harness do not apply here, but design
tokens, theming, versioning, and release conventions do.

## Status

**Shipping.** `BASE_VERSION` 1.6 — the most mature app on the platform, and the only one
past the 0.9 line. This repo is **public**.

## Features

**Working today**

- **Two git services, one UI.** Azure DevOps and GitHub connect independently (each with
  its own token in the OS keychain); a **provider filter** at the top of the toolbar
  switches the whole window between them. Both are polled; each service's PR, bug and
  ticket lists are cached per provider so switching is instant.
- **PR listing**, grouped by repository, with review state and a "passing all policies"
  flag. Azure DevOps reads branch-policy evaluations; GitHub reads reviews plus
  `mergeable_state` (approved reviews and a clean merge state count as passing).
- **Bugs and Tickets** tabs. Azure DevOps: WIQL over work items (Bug vs everything else),
  sprint metadata, linked-PR relations. GitHub: open issues, partitioned by a bug-ish label
  (`bug`, `type: bug`, `kind/bug`), priority from `P0–P3` / `priority: high|medium|low`
  labels, milestones as sprints, and linked PRs via `closedByPullRequestsReferences`.
- **One-click agent runs** (`agent-runner.js`) with an agent from `agent-registry.js`:
  three scenarios (PR review, resolve comments, implement ticket), each with a
  **per-service prompt set** under `resources/prompts/` (Azure DevOps at the root,
  `github/` beside it) and a per-service universal review prompt. The dispatched prompt
  gets `PROVIDER`, `REPO_OWNER`, `REPO_NAME` and `REPO_ID` on top of the scenario's
  required variables, and the agent receives the service token under its conventional env
  names (`AZURE_DEVOPS_PAT`…, `GITHUB_TOKEN` / `GH_TOKEN`).
- **Model discovery** (`model-discovery.js`) that refreshes the available model list in the
  background, showing a hardcoded fallback immediately so the UI is never empty.
- **Repository cloning** (`repo-cloner.js`) through the connection's authenticated clone
  URL; GitHub PRs from forks fetch the head from the fork.
- **Inline image attachments** (`prompt-attachments.js`): `<img>` and markdown images in
  PR and work-item bodies are downloaded for the agent, but only from the connected
  service's own hosts, so a token is never sent to a third party.
- **A webhook server** (`webhook-server.js`) that accepts Azure DevOps service hooks and
  GitHub webhooks on one `/webhook` route and refreshes the matching service.
- **Design system UI.** The renderer is built on the CodeLifter Design System tokens
  (`src/renderer/tokens.css`, a verbatim port of `Platform-Design/tokens`) with Inter and
  JetBrains Mono bundled, dark canonical and the light-cool scope behind a persisted
  toggle, compact density, and the system's Button / Input / Tabs / Card / Badge / Tag /
  StatusDot / Toast / Disclosure / ProgressBar vocabulary.
- **Auto-update** via `electron-updater`, with native notifications on update available
  and update ready.
- **Credential storage in the OS keychain** via `keytar` (libsecret on Linux, so unlike
  Specter and Reps, LGTM already had a working Linux secret backend), one entry per
  service. The keychain is the only store: a refusal or a hung prompt is reported to the
  user (the token stays in memory for the session), not papered over with a file. Versions
  before 0.6 kept an obfuscated file copy of the Azure DevOps PAT; it is migrated into the
  keychain and emptied on first read.

**Not done / known limits**

- GitHub review threads are read through GraphQL; a fine-grained token without GraphQL
  access falls back to flat review comments (no resolved state) and to
  `hasLinkedPR = false`.
- GitHub has no won't-fix thread status; the resolve-comments prompt asks the agent to
  prefix its reply with **Won't fix:** and resolve the thread, and the review prompt reads
  that prefix on the next pass.

## Architecture

Electron, main process in `src/main/`:

| File | Role |
|---|---|
| `main.js` | Lifecycle, tray, window, IPC, auto-updater, the connection map |
| `providers/index.js` | Provider registry (`azure-devops`, `github`) and the `Connection` object: client, clone URL, agent env, webhook matcher |
| `providers/github-client.js` | GitHub REST + GraphQL client, normalised to the ADO shapes |
| `devops-client.js` | Azure DevOps API |
| `agent-runner.js`, `agent-registry.js` | Agent execution per connection, and the agent catalogue |
| `prompt-resolver.js`, `prompt-attachments.js`, `scenario-prompts.js` | Prompt construction; scenario prompts are loaded per provider |
| `token-store.js` | Per-provider token persistence via keytar (keychain only; legacy file drained on read) |
| `settings.js` | Every `config.json` key, its default, the corrupt-file guard |
| `pr-poller.js` | One per connection: polls the PR list, keeps the last good list on a failure, coalesces overlapping polls |
| `raw-http.js` | The axios adapter the registry's startup token check runs through |
| `core/` | Pure pieces main.js and the runner share: org URL parsing, prompt builders, connection validation mapping |
| `repo-cloner.js`, `webhook-server.js`, `model-discovery.js` | Supporting services |

Renderer in `src/renderer/` (`tokens.css` → `styles.css`; `app.js` owns the DOM, `logic.js`
holds the DOM-free decisions and is the part under test), preload bridge in
`src/main/preload.js` with `contextIsolation: true` and `nodeIntegration: false`. Every
PR / work item row carries `provider`; nothing in the renderer branches on the service
except number prefixes (`!` for ADO, `#` for GitHub) and the nouns in hint text.

Adding a third service means one entry in `providers/index.js`, a client that produces the
same row shapes, a prompt set under `resources/prompts/<id>/`, and a token-store entry.

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

`electron-store` for configuration: the Azure DevOps org URL (`orgUrl`), other services'
URLs (`providerUrls`), the active provider, webhook port and bind host, polling interval,
agent and model selections, per-repo prompt configuration, starred repos, filters; a
corrupt `config.json` is reset to defaults rather than blocking the launch. **Tokens live
in the OS keychain** via keytar (`com.lgtm.azuredevops` / `com.lgtm.github`), never in the
config store and never in a file. Repo-keyed settings (`project/repo`) are shared across
services; on GitHub `project` is the owner login. The webhook server listens on loopback
by default and caps request bodies.

## Tests

`tests/` on the Node test runner (`npm test`; `npm run test:coverage` prints the coverage
table). The main-process modules import without Electron, so the suite covers the
provider clients (the real `azure-devops-node-api` client against a fake Azure DevOps
server; the GitHub client against a scripted HTTP stub), the provider registry (clone
URLs, agent env, webhook routing, the startup token check), the token store (round trips,
a refusing or hanging keychain, the legacy-file migration), the webhook trust boundary,
the agent runner's failure paths, attachment extraction (host allow-list, so a token never
leaves its service), the scenario prompt sets, the renderer's DOM-free logic, and an
end-to-end canary. CI runs it on ubuntu on every push and PR and on the macOS and
Windows build legs before they package; the iPad head has its own XCTest target
(`ios/Tests`), run by `ios.yml`. What is covered, what is deliberately not, and why:
`CLAUDE.md` → Testing.

## External services

Azure DevOps, GitHub, plus the AI providers used for reviews. Canonical inventory:
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
only the cheap ubuntu jobs (version + tests). Day-to-day releases happen for free from a
dev Mac via `scripts/release-local.sh`. That is the documented public-repo pattern, not a
deviation.

## Known gaps

- **The iPad head (`ios/`) is Azure DevOps only.** It is a read-only companion viewer that
  predates the provider layer; its `Theme.swift` mirrors the design tokens and bundles the
  fonts, but it has no GitHub client or provider switch. Recorded parity gap: adding it is
  a separate Swift piece of work that could not be compiled or run from the environment
  this change was made in. Tracked in `Platform-Standards/FOLLOWUPS.md`.
- **LGTM has no locked accent** in `Platform-Standards/design/app-accents.md`; the UI uses
  the platform brand pair (purple primary, cyan accent) exactly as the design system ships
  it. Locking an accent is the owner's call; tracked in `FOLLOWUPS.md`.
- **The Linux window path has never been observed working.** The tray-independent window is
  a targeted fix for a problem plain in the source, but nobody has watched it run. Electron
  under emulation on the Apple Silicon dev host crashes before it can be checked.
- **Tray behaviour on Linux is untested** across GNOME and KDE.
- **Versioning is still on the retired `BASE_VERSION` + run-number scheme**; the harness
  wants tag-derived versions (`process/versioning-ci.md`). Flagged by the conformance
  checker, not changed here.
- **README badges and download links still point at `CodeLifterIO/LGTM`**, the old
  user-owned location, while the repo lives under the org. The update feed itself was
  fixed; the README links were not.
- **`docs/` is the GitHub Pages source** (`main//docs`, serving
  `codelifter-platform.github.io/LGTM`). It is a landing page, not documentation, and must
  not be renamed — doing so would take the published site down. Only
  `MAC_CODE_SIGNING.md` moved out of it into this folder.

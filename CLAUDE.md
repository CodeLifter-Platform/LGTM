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
- **The PAT lives in the OS keychain and nowhere else** (`src/main/pat-store.js`). A
  refusing or hanging keychain is reported to the user (the PAT stays in memory for the
  session), never worked around with a file. The pre-0.6 obfuscated file store
  (`lgtm-secure.json`, key hard-coded in source) is read once to migrate an existing
  PAT into the keychain and then emptied; nothing writes to it. On Linux without a
  running Secret Service this means re-entering the PAT each launch, by design.
- **The webhook server binds to loopback** (`webhookHost`, default `127.0.0.1`) and caps
  request bodies at 1 MiB. Azure DevOps reaches it through a tunnel that forwards to
  localhost; set `webhookHost` to `0.0.0.0` in `config.json` only for a machine that is
  meant to take LAN traffic. An optional `webhookSecret` (config.json, no UI yet) makes
  `POST /webhook` require the `X-LGTM-Webhook-Secret` header, compared in constant time;
  `GET /health` stays open.

## Testing

The suite follows `Platform-Standards/process/testing.md`. It runs on the built-in Node
runner with no test dependencies, and nothing under `tests/` requires `electron` or
`keytar`: the main-process modules take their collaborators as constructor arguments
(`AgentRunner`'s notifier, spawn and factories; `PatStore`'s keychain; `AgentRegistry`'s
`which`; `DevOpsSession`'s factories), and `src/main/main.js` is the only file that
wires the Electron ones in.

```bash
npm test                 # node --test tests/**/*.test.js
npm run test:coverage    # same, with the coverage table on stdout and coverage/lcov.info
```

Layout: `tests/core` (parsers, prompt assembly, mapping), `tests/data` (settings and PAT
stores), `tests/wire` (the real `azure-devops-node-api` client against a fake Azure
DevOps server that serves the SDK's route discovery), `tests/auth` (webhook trust
boundary), `tests/failure` (agent runner, poller/session, cloner), `tests/renderer`
(`src/renderer/logic.js`, the DOM-free half of the UI), `tests/integration` (the canary:
fake ADO + real client + real git clone + real prompts + a fake agent process). Shared
fakes are in `tests/helpers/fakes.js`; the agent stand-in is `tests/fixtures/fake-agent.js`.
Only `tests/` is discovered: `.touchdown/` and `Handoffs/` hold stale copies that must
never be picked up.

CI (`build.yml`): the `test` job runs on ubuntu on every push and PR with the coverage
table in the job summary; `build-mac` and `build-windows` run the same suite on their own
OS before `electron-builder` and upload that leg's `coverage/`. `ios.yml` runs
`xcodebuild test` for `ios/Tests` on an iPad simulator, `workflow_dispatch`-only because
the repo is public.

Rows of the standard's table that do not apply here, and why:

- **Persistence (database)**: there is no database. The two stores (`config.json` via
  electron-store, the PAT via keytar) are covered under `tests/data`.
- **Parsers and importers**: LGTM imports no user files. The parsers it has (org URL,
  `auggie model list`, the agents' fenced JSON report, DevOps HTML) are in `tests/core`.
- **AI wire contract**: there is no model API client. The contract with an agent is CLI
  arguments + the prompt on stdin + a fenced JSON report on stdout, and that is what
  `tests/core/agent-commands`, `tests/failure/agent-runner` and the canary pin.

Known gaps: `startWorkItemAction` (the bugs/tickets flow) is only covered through the
cloner and prompt tests, not end to end; `git` must be installed for `tests/failure/
repo-cloner` and the canary, which report *skipped* without it. Linux builds have no CI
job at all (package.json has the targets; the workflow does not), so nothing runs the
suite on the Linux packaging path either — tracked as out of scope here.

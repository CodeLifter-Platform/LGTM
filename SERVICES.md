# Services

Every external service this application depends on and where it's managed. Update this
file in the same change that adds, removes, or reconfigures a service. Platform-wide
map: `Platform-Standards/services/registry.md` (sibling repo,
github.com/CodeLifter-Platform/Platform-Standards).

Last reviewed: 2026-10-06.

## Azure DevOps

- **Usage:** One of the two PR / work-item sources LGTM reviews — pull requests, threads,
  work items, comment posting via the Azure DevOps REST API (`src/main/devops-client.js`).
- **Managed at:** The end user's Azure DevOps organization; PAT supplied by the user at
  runtime (stored in the OS keychain via keytar under `com.lgtm.azuredevops` and nowhere
  else; a refusing keychain is reported, and the pre-0.6 obfuscated file copy is migrated
  out on first read). Scopes: Code (Read & Write), Work Items (Read & Write), Pull Request
  Threads.
- **Handed to agents as:** `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_EXT_PAT`, `SYSTEM_ACCESSTOKEN`.

## GitHub (as a PR / issue source)

- **Usage:** The other PR / work-item source — pull requests, review threads, issues,
  comment posting via the GitHub REST and GraphQL APIs (`src/main/providers/github-client.js`).
  Distinct from the org's own GitHub use for CI and releases.
- **Managed at:** The end user's GitHub account; a personal access token (classic or
  fine-grained) supplied at runtime (stored in the OS keychain via keytar under
  `com.lgtm.github`, never in config and never in a file). Scopes: `repo`, `read:org`, `read:user`. GitHub Enterprise hosts work
  through the same URL field.
- **Handed to agents as:** `GITHUB_TOKEN`, `GH_TOKEN`.

## Anthropic / OpenAI (model APIs)

- **Usage:** Review-agent backends (`src/main/agent-runner.js`, model discovery in
  `src/main/model-discovery.js`); Anthropic and OpenAI-compatible endpoints.
- **Managed at:** API keys supplied by the user at runtime; platform Anthropic account
  is in the registry.

## Apple Developer (macOS signing & notarization)

- **Usage:** Developer ID signing + notarization of the packaged Electron app.
- **Managed at:** CodeLifter-Platform **org secrets** (`LGTM_APPLE_APP_SPECIFIC_PASSWORD`
  was first created here).
- **Detail:** [..Documentation/MAC_CODE_SIGNING.md](..Documentation/MAC_CODE_SIGNING.md).

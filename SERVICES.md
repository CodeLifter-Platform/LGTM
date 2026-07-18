# Services

Every external service this application depends on and where it's managed. Update this
file in the same change that adds, removes, or reconfigures a service. Platform-wide
map: `Platform-Standards/services/registry.md` (sibling repo,
github.com/CodeLifter-Platform/Platform-Standards).

Last reviewed: 2026-07-18.

## Azure DevOps

- **Usage:** The PR source LGTM reviews — pull requests, diffs, comment posting via the
  Azure DevOps REST API.
- **Managed at:** The end user's Azure DevOps organization; PAT supplied by the user at
  runtime (stored in OS secure storage, never in config).

## Anthropic / OpenAI (model APIs)

- **Usage:** Review-agent backends (`src/main/agent-runner.js`, model discovery in
  `src/main/model-discovery.js`); Anthropic and OpenAI-compatible endpoints.
- **Managed at:** API keys supplied by the user at runtime; platform Anthropic account
  is in the registry.

## Apple Developer (macOS signing & notarization)

- **Usage:** Developer ID signing + notarization of the packaged Electron app.
- **Managed at:** CodeLifter-Platform **org secrets** (`LGTM_APPLE_APP_SPECIFIC_PASSWORD`
  was first created here).
- **Detail:** [docs/MAC_CODE_SIGNING.md](docs/MAC_CODE_SIGNING.md).

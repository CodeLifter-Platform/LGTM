# LGTM Container Refactor — Handoff Document

> **Audience:** Claude Code (or another coding agent) running in `~/Documents/Dev/LGTM/` with full repo access.
> **Goal:** Replace LGTM's current in-app `child_process.spawn('claude', ...)` with a Docker-backed runner that has the same observable behavior, while keeping all renderer code untouched. Each container runs a chosen agent (Claude, Codex, or Auggie) with a chosen, agent-supported model.
> **Status of this scaffold:** Container subsystem and orchestrator-side runner abstraction are provided. Integration into existing main-process code is the work to do.

---

## Why this refactor

Today LGTM spawns Claude Code as a child process inside the Electron main process. This works but has three problems:

1. **Cold start dominates.** Each review pays for Node startup + `npx -y @azure-devops/mcp` resolution + ADO auth handshake + repo fetch before any LLM work happens.
2. **No isolation.** A misbehaving agent run can leak file handles, child processes, or memory into the long-lived Electron main process.
3. **No multi-agent / multi-model story.** The current setup is hardcoded to Claude. Adding Codex, Auggie, or per-run model selection means rewriting the spawn logic each time.

The fix: extract per-run work into Docker containers built from a single pre-built image. Image is built once; each review/implement spins up a fresh container from the cached image (~2-5s startup on Docker Desktop for Mac).

This also gives us a clean cloud-deployment story later (Azure Container Apps Jobs) without rewriting anything.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Electron Main Process                         │
│                                                                  │
│  ┌──────────────────┐     ┌────────────────────────────────┐   │
│  │ Existing IPC     │────▶│ ContainerRunner (NEW)          │   │
│  │ handlers         │     │  ├─ LocalDockerRunner          │   │
│  │ (ipcMain.handle) │     │  ├─ EventStreamParser          │   │
│  │                  │     │  ├─ TokenManager (Entra)       │   │
│  │                  │     │  └─ AgentCatalog (models)      │   │
│  └──────────────────┘     └──────────────┬─────────────────┘   │
│                                          │                      │
│                                          │ dockerode            │
│                                          ▼                      │
└──────────────────────────────────────────┼──────────────────────┘
                                           │
                                           ▼
                            ┌──────────────────────────┐
                            │ Docker Engine (host)     │
                            │  ┌────────────────────┐  │
                            │  │ lgtm-worker:0.1    │  │
                            │  │  ─ Node 20         │  │
                            │  │  ─ Claude Code CLI │  │
                            │  │  ─ Codex CLI       │  │
                            │  │  ─ Auggie CLI      │  │
                            │  │  ─ ADO MCP server  │  │
                            │  │  ─ git, build deps │  │
                            │  │  ─ worker.js entry │  │
                            │  └────────────────────┘  │
                            │  Selects agent + model   │
                            │  from env vars at start  │
                            └──────────────────────────┘
```

**Key principle:** The renderer process and existing IPC handlers don't know containers exist. They call into `ContainerRunner` exactly the way they currently call into the in-app spawn helper. Output events arrive through the same channels they always have.

---

## Agent + model selection

Both agent and model are runtime decisions, not build-time. One image supports all three agents; the model is selected per run via `LGTM_MODEL`.

### How model selection flows

1. **Renderer** asks `runner.getCatalog()` to populate the model picker UI. The catalog returns supported models per agent, defaults, and metadata (tier, cost, context window).
2. **User picks** an agent and (optionally) a model. If they don't pick a model, the orchestrator uses the agent's default.
3. **Orchestrator validates** that the chosen model is in the agent's supported list. Fails fast before spawning anything.
4. **Orchestrator passes** `LGTM_MODEL` into the container env.
5. **Worker re-validates** in the container as a safety net.
6. **Agent driver** translates the model name into the right CLI flag for that agent (`--model` for Claude Code, etc.).

### Where the catalog lives

Two places, kept in sync:

- **`src/containers/AgentCatalog.js`** — orchestrator-side, no container dependency. Used by the renderer to populate UIs and by `LocalDockerRunner` to validate. This is the source of truth for the *UI*.
- **`containers/worker/src/agents/<agent>.js`** — each driver exposes `defaultModel()`, `supportedModels()`, `supportsModel(m)`. This is the source of truth for *execution* and the place where Claude Code's `--model` flag actually gets passed.

If they ever diverge, the worker validation will fail the run with exit code 2. That's intentional — orchestrator-side validation is a UX optimization, not the safety boundary.

### Current models per agent

These reflect the catalog as of this scaffold. Update both files when new models ship.

| Agent | Default | Supported models |
|---|---|---|
| **claude** | `claude-sonnet-4-6` | `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, plus aliases `opus`, `sonnet`, `haiku`, `opusplan` |
| **codex** | `gpt-5-codex` | `gpt-5`, `gpt-5-codex`, `gpt-5-mini` *(stub — verify)* |
| **auggie** | `auggie-default` | `auggie-default`, `claude-sonnet-4-6`, `claude-opus-4-7`, `gpt-5` *(stub — verify)* |

The stubs are placeholders; confirm against the agents' own `--list-models` or docs when you wire up codex.js and auggie.js.

---

## Container interface contract

This is the binding contract between the orchestrator and the worker container. Both sides depend on it; treat it as an API.

### Inputs (env vars passed to container)

| Variable | Required | Description |
|---|---|---|
| `LGTM_AGENT` | yes | `claude` \| `codex` \| `auggie` |
| `LGTM_MODE` | yes | `review` \| `implement` |
| `LGTM_MODEL` | no  | Specific model. Falls back to agent's default if absent. Worker validates support and exits 2 if invalid. |
| `LGTM_RUN_ID` | yes | Unique ID for this run |
| `ADO_ORG` | yes | Azure DevOps organization name |
| `ADO_PROJECT` | yes | Azure DevOps project name |
| `ADO_REPO` | yes | Repository name |
| `ADO_MCP_AUTH_TOKEN` | yes | Short-lived Entra token for ADO MCP server |
| `ANTHROPIC_API_KEY` | for claude | Anthropic API key |
| `OPENAI_API_KEY` | for codex | OpenAI API key |
| `AUGMENT_API_KEY` | for auggie | AugmentCode API key |
| `PR_ID` | for review mode | Pull request ID |
| `WORK_ITEM_ID` | for implement mode | ADO work item ID |
| `BASE_BRANCH` | optional | Branch to base work on (default: `main`) |

### Outputs (JSONL on stdout)

Every line on stdout is a single JSON object:

```json
{ "ts": 1714150000000, "runId": "pr-12345-abc", "type": "...", ...payload }
```

**Event types:**

| Type | Payload | Meaning |
|---|---|---|
| `run_start` | `agent`, `agentVersion`, `mode`, `model`, `mcpVersion` | Container initialized, run starting (note `model` is included) |
| `git_op` | `op`, `target`, `durationMs` | Git operation completed |
| `tool_use` | `tool`, `args` | Agent invoked a tool |
| `tool_result` | `tool`, `success`, `bytes` | Tool returned |
| `model_request` | `model`, `tokensIn` | LLM call dispatched |
| `model_response` | `model`, `tokensOut`, `durationMs` | LLM call returned |
| `progress` | `message`, `percent` | Free-text progress update for UI |
| `artifact` | `kind`, `path` | A file was written to `/artifacts/<runId>/` |
| `error` | `message`, `recoverable` | Something went wrong |
| `run_done` | `success`, `summary` | Run finished cleanly |

`run_start` carries the resolved model so consumers can record what actually ran, even if the request didn't specify one.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success — `run_done` was emitted with `success: true` |
| `1` | Worker error — `run_done` emitted with `success: false`, or `error` event present |
| `2` | Bad input — required env var missing/invalid, or model not supported by selected agent |
| `137` | OOM kill (Docker) |
| `143` | SIGTERM |
| other | Catastrophic failure |

---

## Files in this scaffold

```
containers/
  worker/
    Dockerfile                  ← single image, all three agents
    package.json
    src/
      worker.js                 ← entrypoint, dispatches on agent + mode + model
      events.js                 ← JSONL emitter
      agents/
        index.js                ← factory + catalog()
        claude.js               ← shells out to `claude` CLI; --model flag
        codex.js                ← STUB
        auggie.js               ← STUB
      modes/
        review.js
        implement.js
      git/operations.js
      mcp/config.js
    prompts/
      review.md
      implement.md
  build.sh
  test-run.sh                   ← takes optional model arg: ./test-run.sh 12345 opus
  README.md

src/containers/                 ← orchestrator-side, lives in Electron main
  ContainerRunner.js            ← interface + factory
  LocalDockerRunner.js          ← dockerode implementation, validates model before run
  AgentCatalog.js               ← model catalog for UI + validation (orchestrator-side)
  EventStreamParser.js
  TokenManager.js
```

---

## Integration plan for the existing codebase

### Step 1: Locate the current spawn site

Find wherever `child_process.spawn('claude', ...)` is called. Likely candidates:
- `main.js` or `main/index.js`
- A file referenced from an `ipcMain.handle('run-review', ...)` handler

Note the function signature: what does the caller pass in, what do they receive (stream? promise? event emitter?), and how is model currently selected (probably hardcoded or from `electron-store`).

### Step 2: Add the new dependencies

```bash
npm install dockerode @azure/identity
```

### Step 3: Drop in the scaffold

Copy `src/containers/` into the existing `src/` (or wherever main-process code lives). Copy the entire `containers/` folder to the repo root.

### Step 4: Build the image once

```bash
cd containers
./build.sh
```

### Step 5: Smoke-test the container directly

```bash
cd containers
./test-run.sh <a-known-pr-id>                      # uses default model
./test-run.sh <a-known-pr-id> claude-opus-4-7      # explicit model
```

Verify:
- JSONL on stdout, ending with `run_done {success: true}`
- The `run_start` event reports the correct model
- Exit code 0
- A bad model name (`./test-run.sh 12345 bogus-model`) fails fast with exit 2 and a clear error message

Don't move on until all of these work.

### Step 6: Replace the spawn call

Replace the existing `spawn('claude', ...)` block with:

```javascript
const { createContainerRunner } = require('./containers/ContainerRunner');

const runner = createContainerRunner({ backend: 'docker-local' });

const handle = await runner.run({
  agent: 'claude',
  mode: 'review',
  model: chosenModel,           // optional; runner falls back to agent default
  runId: generateRunId(prId),
  context: {
    adoOrg, adoProject, adoRepo, prId,
  },
  secrets: {
    anthropicApiKey: store.get('anthropicApiKey'),
  },
});

handle.events.on('event', (evt) => {
  // Forward to existing event sink — same channel the in-app spawn used
});

const result = await handle.result;
// result.success, result.summary, result.model (resolved model)
```

The shape of `handle` is the same as what the renderer currently consumes from the in-app process: an event stream + a terminal result.

### Step 7: Wire model selection into the UI

- Expose `runner.getCatalog()` over IPC so the renderer can build a model picker.
- Persist the user's last-chosen model per agent in `electron-store`.
- Pass it through as `spec.model` on each run.

If LGTM has multiple entry points (right-click PR → review, sidebar button → review, ticket → implement), they all need to either pass a model explicitly or rely on the persisted default. Do not hardcode a model anywhere except the catalog.

### Step 8: Wire credentials forwarding

- Read API keys from `electron-store` / keytar (existing path).
- Pass into `runner.run({ secrets: { anthropicApiKey, openaiApiKey, augmentApiKey } })`.
- Only the agent-specific key for the chosen agent will actually be forwarded into the container — the runner filters them.

### Step 9: Update `.env.example`

Add the new variables (model defaults, container subsystem opts).

### Step 10: Verify renderer is unchanged (except model picker)

Apart from the new model picker UI, the renderer should not need behavioral changes. If event handling needs to change, the abstraction in Step 6 is wrong — fix that.

---

## What is intentionally NOT done in this scaffold

1. **Warm container pool.** Every run spawns a new container. Future optimization for higher volumes.
2. **Codex and Auggie drivers are stubs.** Their `agents/codex.js` and `agents/auggie.js` files have the right shape and a placeholder model catalog, but the actual CLI invocation needs filling in. Most likely point of inaccuracy: model names and the `--model` flag (Auggie may use a config file instead).
3. **Cloud runner.** Only `LocalDockerRunner` is implemented. `AzureContainerAppsRunner` is for later.
4. **MCP read-only enforcement.** Review mode could lock the MCP server to read-only tools using `X-MCP-Readonly`. Not done yet.
5. **Artifact GC.** `/artifacts/<runId>/` accumulates forever. Add a cleanup pass.
6. **Model usage tracking.** `run_start` carries the model; emitting `model_request` / `model_response` with token counts on every LLM call is the next step for cost visibility.

---

## Test plan

Refactor is correct when:

1. `./containers/build.sh` produces a valid image.
2. `./containers/test-run.sh <prId>` end-to-end against a real PR succeeds.
3. `./containers/test-run.sh <prId> claude-opus-4-7` runs with the explicit model.
4. `./containers/test-run.sh <prId> bogus-model` fails fast with exit 2 and a clear error.
5. Running a PR review through LGTM UI produces the same observable result as before.
6. Running a ticket implementation through LGTM UI works identically.
7. The `run_start` event in the JSONL stream reports the correct model.
8. The renderer's model picker (new UI) actually changes which model is used (verify via `run_start`).
9. The renderer code has no diffs in event handling logic.
10. Killing the orchestrator mid-run leaves no orphan containers.

---

## Common gotchas

- **Apple Silicon.** `build.sh` handles `--platform linux/arm64` automatically.
- **Stdout buffering.** Worker uses `process.stdout.write` directly; don't change to `console.log`.
- **Event ordering.** Don't assume `run_start` arrives first. If the container fails before init, `error` will be the first event.
- **Token forwarding.** `ADO_MCP_AUTH_TOKEN` is short-lived. `TokenManager` handles refresh; don't bypass it.
- **Model-flag drift.** Claude Code uses `--model`. Codex likely does too. AugmentCode may use a config file. Each driver is responsible for translating the model name into whatever the CLI expects.
- **Aliases.** Claude accepts `opus`/`sonnet`/`haiku` as aliases that resolve to current versions. Including them in the catalog means UIs can offer "always use latest opus" without hardcoding a version. The downside: the resolved version isn't stable. If you need exact-version logging, use the full ID.
- **Per-agent secrets.** A user might only have an Anthropic key. The runner only forwards the key for the selected agent and only requires that key in `_validateSpec`. Don't change that to require all three.

---

## Where to ask follow-up questions

When Claude Code hits something it can't decide, useful prompts:

- "The existing spawn helper is in `<file>`. Show me the smallest possible diff to replace it with `ContainerRunner` while preserving the existing event interface, and add a model parameter."
- "The `agents/codex.js` driver is a stub. Here's how the codex CLI behaves when I run `codex --help`. Fill in the driver and update `SUPPORTED_MODELS`."
- "Add a model picker dropdown to the renderer. It should call out to main via IPC to fetch the catalog, group by agent, and persist the selection in electron-store."

# LGTM Container Subsystem

This folder contains the worker container that LGTM dispatches reviews and implementations into. Everything in here is independent of the Electron app — you can build and test it standalone.

## Layout

```
containers/
  worker/        ← the Docker image source (single image, all agents)
  build.sh       ← builds lgtm-worker:<version>
  test-run.sh    ← end-to-end smoke test against a real PR
  README.md      ← you are here
```

## Building the image

```bash
./build.sh           # builds lgtm-worker:0.1 and lgtm-worker:latest
./build.sh 0.2       # builds a specific version tag
```

The script auto-detects Apple Silicon and builds `linux/arm64` accordingly.

First build takes a couple of minutes (Node base image + global npm installs). Subsequent builds use the layer cache and finish in seconds unless you change the Dockerfile.

## Smoke-testing standalone

```bash
# 1. Make sure you can authenticate to ADO via az login
az login

# 2. Set vars in .env at the repo root (or export them)
#    Required: ADO_ORG, ADO_PROJECT, ADO_REPO, ANTHROPIC_API_KEY

# 3. Run against a known PR
./test-run.sh 12345
```

This:
- Mints a fresh ADO Entra token from your `az login` session
- Runs the container with the right env vars
- Tees JSONL events to `test-output/<run-id>/events.jsonl`
- Mounts `test-output/<run-id>/` as `/artifacts/<run-id>` so the worker's artifacts land on disk where you can inspect them

If everything works, the events file ends with a `run_done` event with `success: true`, and the PR has a new review comment.

## What's in the image

- Node 20 (slim)
- `git`, build tools, Python (for build scripts that need it)
- `@anthropic-ai/claude-code` (pinned)
- `@azure-devops/mcp` (pinned)
- The worker code from `worker/src/`

Codex and Auggie CLIs are stubs — see `worker/src/agents/codex.js` and `worker/src/agents/auggie.js` for what to fill in.

## Troubleshooting

**"claude: command not found" inside the container**
The npm global bin isn't on PATH. The base `node:20-slim` image does set this correctly; if you switch base images, ensure `/usr/local/bin` is on PATH.

**Auth fails inside the container**
Verify the token is actually being passed: `docker run --rm lgtm-worker:latest env | grep ADO_MCP_AUTH_TOKEN`. If empty, the orchestrator isn't forwarding it.

**Slow git clones**
The `lgtm-cache` named volume persists across runs. After the first clone, subsequent runs of the same repo just fetch. If clones are slow on every run, you're not mounting the volume — check the `-v lgtm-cache:/cache` flag.

**Container exits with code 137**
OOM kill. Bump Docker Desktop's memory allocation in Settings → Resources, or pass `--memory 2g` to `docker run`.

**JSONL events look truncated mid-line**
A common cause is `console.log` being used somewhere instead of the `events.js` emitter. The emitter writes complete JSON objects with explicit newlines and never `console.log`s. Search for `console.log` in `worker/src/` and replace.

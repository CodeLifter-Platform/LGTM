# LGTM worker container
# Single image. All three agents installed. Mode and agent selected at runtime via env vars.

FROM node:20-slim

# Build tools, git, common deps. Kept minimal — agents do their own heavy lifting.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    build-essential \
    python3 \
    python3-pip \
    curl \
    jq \
 && rm -rf /var/lib/apt/lists/*

# Pin all CLI tool versions. Bump intentionally; never let them float.
# NOTE: codex and auggie package names are placeholders — verify and update
# when those drivers are filled in (see HANDOFF.md, "intentionally NOT done").
ENV CLAUDE_CODE_VERSION=2.0.0
ENV ADO_MCP_VERSION=1.0.0

RUN npm install -g \
        @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
        @azure-devops/mcp@${ADO_MCP_VERSION}

# Codex / Auggie installation — stubs. Uncomment + adjust when ready.
# RUN npm install -g @openai/codex@<version> @augmentcode/cli@<version>

WORKDIR /app

# Worker code
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src/ ./src/
COPY prompts/ ./prompts/

# Mountpoints
# /artifacts — persistent volume, written by worker, read by orchestrator
# /cache     — persistent volume, git clones, agent caches
# /sessions  — optional, for Claude Code's native session JSONL
RUN mkdir -p /artifacts /cache /sessions

# Image labels for traceability
LABEL org.opencontainers.image.title="lgtm-worker"
LABEL org.opencontainers.image.description="LGTM agent worker — runs review or implement mode in isolation"
LABEL org.opencontainers.image.source="https://github.com/codelifter/lgtm"

# Worker reads env vars and writes JSONL to stdout. No interactive shell.
ENTRYPOINT ["node", "/app/src/worker.js"]

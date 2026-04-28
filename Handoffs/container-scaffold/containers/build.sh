#!/usr/bin/env bash
# Build the lgtm-worker image.
# Usage: ./build.sh [version]
# Default version: 0.1

set -euo pipefail

VERSION="${1:-0.1}"
IMAGE_NAME="lgtm-worker"
TAG="${IMAGE_NAME}:${VERSION}"

cd "$(dirname "$0")/worker"

# Detect platform — Apple Silicon needs explicit linux/arm64
PLATFORM=""
if [[ "$(uname -m)" == "arm64" ]]; then
  PLATFORM="--platform linux/arm64"
fi

echo "Building ${TAG} ${PLATFORM}"
docker build ${PLATFORM} -t "${TAG}" -t "${IMAGE_NAME}:latest" .

echo ""
echo "Built: ${TAG}"
docker images "${IMAGE_NAME}" --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}"

#!/usr/bin/env bash
# Smoke-test the lgtm-worker image against a known PR.
# Usage: ./test-run.sh <PR_ID> [model]
#
# Examples:
#   ./test-run.sh 12345
#   ./test-run.sh 12345 claude-opus-4-7
#   ./test-run.sh 12345 sonnet
#
# Requires:
#   - lgtm-worker image already built (run ./build.sh first)
#   - Logged in to Azure CLI (`az login`)
#   - ANTHROPIC_API_KEY in env (or in .env at repo root)
#   - ADO_ORG, ADO_PROJECT, ADO_REPO in env or .env

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <PR_ID> [model]"
  echo "  Default model: claude-sonnet-4-6"
  exit 1
fi

PR_ID="$1"
MODEL="${2:-claude-sonnet-4-6}"
RUN_ID="smoke-pr-${PR_ID}-$(date +%s)"

if [[ -f "$(dirname "$0")/../.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$(dirname "$0")/../.env"; set +a
fi

: "${ADO_ORG:?ADO_ORG must be set}"
: "${ADO_PROJECT:?ADO_PROJECT must be set}"
: "${ADO_REPO:?ADO_REPO must be set}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"

echo "Acquiring ADO token via az login..."
ADO_TOKEN=$(az account get-access-token \
  --resource '499b84ac-1321-427f-aa17-267ca6975798' \
  --query accessToken -o tsv)

OUTPUT_DIR="$(dirname "$0")/test-output/${RUN_ID}"
mkdir -p "${OUTPUT_DIR}"

echo "Running container for PR ${PR_ID} (run id ${RUN_ID}, model ${MODEL})..."
echo "Output will be saved to ${OUTPUT_DIR}/"
echo ""

docker run --rm \
  -e LGTM_AGENT=claude \
  -e LGTM_MODE=review \
  -e LGTM_MODEL="${MODEL}" \
  -e LGTM_RUN_ID="${RUN_ID}" \
  -e ADO_ORG="${ADO_ORG}" \
  -e ADO_PROJECT="${ADO_PROJECT}" \
  -e ADO_REPO="${ADO_REPO}" \
  -e ADO_MCP_AUTH_TOKEN="${ADO_TOKEN}" \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -e PR_ID="${PR_ID}" \
  -e BASE_BRANCH="${BASE_BRANCH:-main}" \
  -v "lgtm-cache:/cache" \
  -v "${OUTPUT_DIR}:/artifacts/${RUN_ID}" \
  lgtm-worker:latest \
  | tee "${OUTPUT_DIR}/events.jsonl"

echo ""
echo "Done. Events: ${OUTPUT_DIR}/events.jsonl"
echo "Artifacts: ${OUTPUT_DIR}/"

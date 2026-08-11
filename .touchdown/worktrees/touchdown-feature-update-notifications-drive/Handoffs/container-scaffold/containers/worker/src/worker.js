// Worker entrypoint.
// Reads env vars, selects agent + mode + model, runs once, exits.
// All output to stdout is JSONL per the contract in HANDOFF.md.

const { emit, emitError, emitDone } = require('./events');
const { loadAgent } = require('./agents');
const { loadMode } = require('./modes');

const REQUIRED_VARS = [
  'LGTM_AGENT',
  'LGTM_MODE',
  'LGTM_RUN_ID',
  'ADO_ORG',
  'ADO_PROJECT',
  'ADO_REPO',
  'ADO_MCP_AUTH_TOKEN',
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    process.stderr.write(`Missing required env vars: ${missing.join(', ')}\n`);
    process.exit(2);
  }

  const { LGTM_MODE, PR_ID, WORK_ITEM_ID } = process.env;
  if (LGTM_MODE === 'review' && !PR_ID) {
    process.stderr.write('PR_ID is required for review mode\n');
    process.exit(2);
  }
  if (LGTM_MODE === 'implement' && !WORK_ITEM_ID) {
    process.stderr.write('WORK_ITEM_ID is required for implement mode\n');
    process.exit(2);
  }
}

async function main() {
  validateEnv();

  const {
    LGTM_AGENT,
    LGTM_MODE,
    LGTM_MODEL,                    // optional — agent's default if absent
    LGTM_RUN_ID,
    ADO_ORG,
    ADO_PROJECT,
    ADO_REPO,
    PR_ID,
    WORK_ITEM_ID,
    BASE_BRANCH = 'main',
  } = process.env;

  let agent;
  let mode;
  try {
    agent = loadAgent(LGTM_AGENT);
    mode = loadMode(LGTM_MODE);
  } catch (err) {
    emitError(err.message, { recoverable: false });
    process.exit(1);
  }

  // Resolve model: explicit env wins, else agent's default.
  const model = LGTM_MODEL || agent.defaultModel();

  // Validate model is one this agent supports. Catches misconfigurations
  // before paying for an LLM round-trip that's going to 4xx.
  if (!agent.supportsModel(model)) {
    emitError(
      `Agent "${LGTM_AGENT}" does not support model "${model}". ` +
      `Supported: ${agent.supportedModels().join(', ')}`,
      { recoverable: false },
    );
    process.exit(2);
  }

  const context = {
    runId: LGTM_RUN_ID,
    agent: LGTM_AGENT,
    mode: LGTM_MODE,
    model,
    ado: { org: ADO_ORG, project: ADO_PROJECT, repo: ADO_REPO },
    prId: PR_ID,
    workItemId: WORK_ITEM_ID,
    baseBranch: BASE_BRANCH,
  };

  let agentVersion;
  try {
    agentVersion = await agent.getVersion();
  } catch {
    agentVersion = 'unknown';
  }

  emit('run_start', {
    agent: LGTM_AGENT,
    agentVersion,
    mode: LGTM_MODE,
    model,
    mcpVersion: process.env.ADO_MCP_VERSION || 'unknown',
  });

  try {
    const result = await mode.run({ context, agent });
    emitDone(true, result.summary || '');
    process.exit(0);
  } catch (err) {
    emitError(err.message || String(err), {
      recoverable: false,
      stack: err.stack,
    });
    emitDone(false, err.message || 'Run failed');
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  emitError(`Unhandled rejection: ${err && err.message ? err.message : err}`, {
    recoverable: false,
  });
  process.exit(1);
});

process.on('SIGTERM', () => {
  emitError('Container received SIGTERM', { recoverable: false });
  process.exit(143);
});

main();

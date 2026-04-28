// PR review mode.
// Agent-agnostic: builds the working tree, builds the prompt, hands off to the agent.

const fs = require('fs');
const path = require('path');
const { fetchPullRequest } = require('../git/operations');
const { writeMcpConfig } = require('../mcp/config');
const { emitProgress, emitArtifact } = require('../events');

async function run({ context, agent }) {
  const { ado, prId, runId, baseBranch } = context;

  if (!prId) throw new Error('PR_ID is required for review mode');

  emitProgress(`Preparing PR ${prId} for review`);

  // 1. Clone or fetch the repo into /cache, check out the PR branch
  const workingDir = await fetchPullRequest({
    org: ado.org,
    project: ado.project,
    repo: ado.repo,
    prId,
    baseBranch,
    cacheDir: '/cache',
  });

  // 2. Write a per-run mcp.json restricting toolset to repos + work items
  //    For review mode, we want read access to PRs/work items + write for PR comments.
  const mcpConfigPath = await writeMcpConfig({
    runId,
    org: ado.org,
    workingDir,
    domains: ['core', 'repositories', 'work-items'],
  });

  // 3. Build the prompt
  const promptTemplate = fs.readFileSync(
    path.join(__dirname, '..', '..', 'prompts', 'review.md'),
    'utf8',
  );
  const prompt = promptTemplate
    .replace('{{ORG}}', ado.org)
    .replace('{{PROJECT}}', ado.project)
    .replace('{{REPO}}', ado.repo)
    .replace('{{PR_ID}}', prId)
    .replace('{{BASE_BRANCH}}', baseBranch);

  // 4. Run the agent
  emitProgress('Invoking agent');
  const result = await agent.run({
    context,
    prompt,
    mcpConfigPath,
    workingDir,
  });

  // 5. Persist artifacts so the orchestrator can pick them up after exit
  const artifactDir = `/artifacts/${runId}`;
  fs.mkdirSync(artifactDir, { recursive: true });
  const summaryPath = path.join(artifactDir, 'agent-output.txt');
  fs.writeFileSync(summaryPath, result.stdoutTail);
  emitArtifact('agent_output', summaryPath);

  return {
    summary: `Reviewed PR ${prId} with ${context.agent}`,
  };
}

module.exports = { run };

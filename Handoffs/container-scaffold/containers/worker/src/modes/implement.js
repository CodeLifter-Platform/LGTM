// Ticket implementation mode.
// Agent-agnostic: clones repo, creates fresh branch, hands off to agent,
// optionally pushes the branch and opens a PR (left to the agent via MCP tools).

const fs = require('fs');
const path = require('path');
const { cloneOrFetch, createBranch } = require('../git/operations');
const { writeMcpConfig } = require('../mcp/config');
const { emitProgress, emitArtifact } = require('../events');

async function run({ context, agent }) {
  const { ado, workItemId, runId, baseBranch } = context;

  if (!workItemId) throw new Error('WORK_ITEM_ID is required for implement mode');

  emitProgress(`Preparing work item ${workItemId} for implementation`);

  // 1. Repo on baseBranch, fresh feature branch
  const workingDir = await cloneOrFetch({
    org: ado.org,
    project: ado.project,
    repo: ado.repo,
    baseBranch,
    cacheDir: '/cache',
  });

  const branchName = `lgtm/wi-${workItemId}-${runId.slice(-8)}`;
  await createBranch({ workingDir, branchName, fromBranch: baseBranch });

  // 2. Per-run mcp.json — implement mode needs full write access
  const mcpConfigPath = await writeMcpConfig({
    runId,
    org: ado.org,
    workingDir,
    domains: ['core', 'repositories', 'work-items', 'wiki'],
  });

  // 3. Build prompt
  const promptTemplate = fs.readFileSync(
    path.join(__dirname, '..', '..', 'prompts', 'implement.md'),
    'utf8',
  );
  const prompt = promptTemplate
    .replace('{{ORG}}', ado.org)
    .replace('{{PROJECT}}', ado.project)
    .replace('{{REPO}}', ado.repo)
    .replace('{{WORK_ITEM_ID}}', workItemId)
    .replace('{{BASE_BRANCH}}', baseBranch)
    .replace('{{BRANCH_NAME}}', branchName);

  // 4. Run agent
  emitProgress('Invoking agent');
  const result = await agent.run({
    context,
    prompt,
    mcpConfigPath,
    workingDir,
  });

  // 5. Artifacts
  const artifactDir = `/artifacts/${runId}`;
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'agent-output.txt'), result.stdoutTail);
  emitArtifact('agent_output', path.join(artifactDir, 'agent-output.txt'));

  return {
    summary: `Implemented work item ${workItemId} on branch ${branchName}`,
    branch: branchName,
  };
}

module.exports = { run };

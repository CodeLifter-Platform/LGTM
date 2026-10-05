/**
 * Prompt builders for the interactive "Details" chat (agent-detail-*
 * IPC): a simplified-but-realistic version of what the scenario reviewer
 * dispatches. Pure string assembly so the exact prompt an agent receives
 * can be pinned by a test.
 */

const { htmlToText } = require('./html-text');

function buildWorkItemDetailPrompt({ workItem, details, repoInfo, repoPrompt }) {
  const lines = [];
  if (repoPrompt && repoPrompt.trim()) {
    lines.push('# Repo-specific Rules', '', repoPrompt.trim(), '');
  }
  lines.push(`# ${details.type || workItem.type || 'Work Item'} #${details.id || workItem.id}`, '');
  lines.push(`- Project: ${details.project || workItem.project}`);
  lines.push(`- Repo: ${repoInfo.repo}`);
  lines.push(`- Title: ${details.title || workItem.title || ''}`);
  lines.push(`- State: ${details.state || ''}`);
  if (details.priority != null) lines.push(`- Priority: ${details.priority}`);
  if (details.severity) lines.push(`- Severity: ${details.severity}`);
  if (details.tags) lines.push(`- Tags: ${details.tags}`);
  if (workItem.webUrl) lines.push(`- URL: ${workItem.webUrl}`);

  const desc = htmlToText(details.description);
  if (desc) lines.push('', '## Description', '', desc);
  const repro = htmlToText(details.reproSteps);
  if (repro) lines.push('', '## Repro Steps', '', repro);
  const sys = htmlToText(details.systemInfo);
  if (sys) lines.push('', '## System Info', '', sys);
  const ac = htmlToText(details.acceptanceCriteria);
  if (ac) lines.push('', '## Acceptance Criteria', '', ac);

  lines.push('', '# Task', '');
  lines.push(
    `Investigate this work item against the cloned repo. Read the relevant code, ` +
    `propose a fix or implementation plan, and discuss with the user before making changes. ` +
    `The user may follow up with questions — answer them based on the repo and work-item context.`,
  );
  return lines.join('\n');
}

function buildPrDetailPrompt({ pr, prDescription, universalPrompt, repoPrompt }) {
  const sourceBranch = (pr.sourceBranch || '').replace(/^refs\/heads\//, '');
  const targetBranch = (pr.targetBranch || '').replace(/^refs\/heads\//, '');
  const lines = [];
  if ((universalPrompt || '').trim()) {
    lines.push('# LGTM Review Rules', '', universalPrompt.trim(), '');
  }
  if ((repoPrompt || '').trim()) {
    lines.push('# Repo-specific Rules', '', repoPrompt.trim(), '');
  }
  lines.push('# Pull Request', '');
  lines.push(`- Project: ${pr.project}`);
  lines.push(`- Repo: ${pr.repo}`);
  lines.push(`- PR ID: !${pr.id}`);
  lines.push(`- Title: ${pr.title || ''}`);
  lines.push(`- Author: ${pr.createdBy || ''}`);
  lines.push(`- Source branch: ${sourceBranch}`);
  lines.push(`- Target branch: ${targetBranch}`);
  if (pr.webUrl) lines.push(`- URL: ${pr.webUrl}`);
  if (prDescription && prDescription.trim()) {
    lines.push('', '## Description', '', prDescription.trim());
  }
  lines.push('');
  lines.push('# Task');
  lines.push('');
  lines.push(
    `You are reviewing this PR interactively. Start by reading the diff between ` +
    `\`${targetBranch}\` and \`${sourceBranch}\` (use \`git diff ${targetBranch}...${sourceBranch}\` ` +
    `or read changed files directly). Apply the rules above, then summarize what you find. ` +
    `The user may follow up with questions — answer them based on the repo and PR context.`,
  );
  return lines.join('\n');
}

module.exports = { buildPrDetailPrompt, buildWorkItemDetailPrompt };

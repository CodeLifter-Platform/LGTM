// Git operations.
// Uses simple-git. Clones into /cache so subsequent runs of the same repo
// only need to fetch.
//
// Auth model: the orchestrator passes ADO_MCP_AUTH_TOKEN as an env var,
// and we use it as a basic-auth password against the ADO https endpoint
// with `git -c http.extraheader=...`. We DO NOT write the token to disk.

const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const { emitGitOp } = require('../events');

function repoCachePath(cacheDir, org, project, repo) {
  return path.join(cacheDir, org, project, repo);
}

function repoUrl(org, project, repo) {
  return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
}

function authHeaderArg() {
  // ADO accepts Bearer Entra tokens via the Authorization header.
  // We pass it transiently via -c so it never lands in .git/config on disk.
  const token = process.env.ADO_MCP_AUTH_TOKEN;
  if (!token) throw new Error('ADO_MCP_AUTH_TOKEN not set');
  // Bearer auth header, base64-encoded value not needed for ADO Entra tokens
  return ['-c', `http.extraheader=Authorization: Bearer ${token}`];
}

async function cloneOrFetch({ org, project, repo, baseBranch, cacheDir }) {
  const target = repoCachePath(cacheDir, org, project, repo);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const exists = fs.existsSync(path.join(target, '.git'));
  const startTs = Date.now();

  if (!exists) {
    const git = simpleGit();
    await git.raw([
      ...authHeaderArg(),
      'clone',
      '--depth', '50',
      repoUrl(org, project, repo),
      target,
    ]);
    emitGitOp('clone', target, Date.now() - startTs);
  } else {
    const git = simpleGit(target);
    await git.raw([...authHeaderArg(), 'fetch', 'origin', baseBranch]);
    emitGitOp('fetch', baseBranch, Date.now() - startTs);
  }

  // Ensure on baseBranch + clean working tree
  const git = simpleGit(target);
  await git.raw(['reset', '--hard']);
  await git.raw(['clean', '-fd']);
  await git.checkout(baseBranch);
  await git.raw([...authHeaderArg(), 'pull', 'origin', baseBranch]);

  return target;
}

async function fetchPullRequest({ org, project, repo, prId, baseBranch, cacheDir }) {
  const target = await cloneOrFetch({ org, project, repo, baseBranch, cacheDir });

  // ADO exposes PR refs as refs/pull/<id>/merge (the merge commit) or
  // refs/pull/<id>/head (the source branch tip). We want both available.
  const startTs = Date.now();
  const git = simpleGit(target);
  await git.raw([
    ...authHeaderArg(),
    'fetch', 'origin',
    `refs/pull/${prId}/merge:lgtm/pr-${prId}-merge`,
    `refs/pull/${prId}/head:lgtm/pr-${prId}-head`,
  ]);
  await git.checkout(`lgtm/pr-${prId}-head`);
  emitGitOp('fetch_pr', `pr-${prId}`, Date.now() - startTs);

  return target;
}

async function createBranch({ workingDir, branchName, fromBranch }) {
  const git = simpleGit(workingDir);
  const startTs = Date.now();
  await git.checkout(fromBranch);
  await git.checkoutLocalBranch(branchName);
  emitGitOp('create_branch', branchName, Date.now() - startTs);
}

module.exports = { cloneOrFetch, fetchPullRequest, createBranch };

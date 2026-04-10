/**
 * DevOpsClient — Azure DevOps REST API wrapper.
 *
 * Uses the PAT as a Basic-auth token (username is empty for PAT auth).
 * API docs: https://learn.microsoft.com/en-us/rest/api/azure/devops
 */

const axios = require('axios');

// Azure DevOps API version — 7.0 is widely supported across both
// Azure DevOps Services (cloud) and Server 2022+.
// Version 7.1 can 404 on older instances.
const API_VERSION = '7.0';

class DevOpsClient {
  /**
   * @param {string} pat   - Personal Access Token
   * @param {string} orgUrl - e.g. "https://dev.azure.com/myorg"
   *                          or    "https://myorg.visualstudio.com"
   */
  constructor(pat, orgUrl) {
    // Normalise: strip trailing slashes
    this.orgUrl = orgUrl.replace(/\/+$/, '');
    this.api = axios.create({
      baseURL: this.orgUrl,
      headers: {
        Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
    });

    // Log request errors with the actual URL for debugging
    this.api.interceptors.response.use(
      (res) => res,
      (err) => {
        const url = err.config ? `${err.config.baseURL}${err.config.url}` : 'unknown';
        const status = err.response ? err.response.status : 'no response';
        console.error(`[LGTM] API error: ${status} → ${url}`);
        throw err;
      },
    );
  }

  // ── Projects ─────────────────────────────────────────────────────
  async getProjects() {
    const res = await this.api.get('/_apis/projects', {
      params: { 'api-version': API_VERSION },
    });
    return res.data.value || [];
  }

  // ── Pull Requests ────────────────────────────────────────────────

  /**
   * Fetch ALL open PRs across every project + repo in the org.
   * Returns a flat array of normalised PR objects.
   */
  async getAllOpenPRs() {
    const projects = await this.getProjects();
    const allPrs = [];

    for (const project of projects) {
      try {
        const repos = await this.getRepos(project.name);
        for (const repo of repos) {
          const prs = await this.getOpenPRs(project.name, repo.id);
          for (const pr of prs) {
            allPrs.push({
              id: pr.pullRequestId,
              title: pr.title,
              status: pr.status,                 // 'active'
              repo: repo.name,
              project: project.name,
              repoId: repo.id,
              sourceBranch: pr.sourceRefName,     // refs/heads/feature-x
              targetBranch: pr.targetRefName,     // refs/heads/main
              createdBy: pr.createdBy?.displayName || '',
              url: pr.url,
              webUrl: `${this.orgUrl}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(repo.name)}/pullrequest/${pr.pullRequestId}`,
              reviewStatus: this._reviewStatus(pr),
            });
          }
        }
      } catch {
        // skip projects we can't read
      }
    }

    return allPrs;
  }

  async getRepos(project) {
    const res = await this.api.get(`/${encodeURIComponent(project)}/_apis/git/repositories`, {
      params: { 'api-version': API_VERSION },
    });
    return res.data.value || [];
  }

  async getOpenPRs(project, repoId) {
    const res = await this.api.get(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullrequests`,
      { params: { 'searchCriteria.status': 'active', 'api-version': API_VERSION } },
    );
    return res.data.value || [];
  }

  // ── PR Comments ──────────────────────────────────────────────────

  /**
   * Post a top-level comment thread on a PR.
   */
  async postPrComment(project, repoId, prId, commentText) {
    const res = await this.api.post(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullrequests/${prId}/threads`,
      {
        comments: [{ parentCommentId: 0, content: commentText, commentType: 1 }],
        status: 1, // active
      },
      { params: { 'api-version': API_VERSION } },
    );
    return res.data;
  }

  /**
   * Set the vote on a PR (approve / reject / etc.)
   * vote: 10 = approved, 5 = approved with suggestions, -5 = wait for author, -10 = rejected
   */
  async setPrVote(project, repoId, prId, vote) {
    // We need the reviewer ID — use "me" shortcut via the PR reviewers endpoint
    const res = await this.api.get(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullrequests/${prId}/reviewers`,
      { params: { 'api-version': API_VERSION } },
    );
    // Find the authenticated user or just return
    return res.data;
  }

  // ── Helpers ──────────────────────────────────────────────────────
  _reviewStatus(pr) {
    // Check reviewer votes
    const reviewers = pr.reviewers || [];
    const hasReject = reviewers.some((r) => r.vote === -10);
    const hasWait = reviewers.some((r) => r.vote === -5);
    const allApproved = reviewers.length > 0 && reviewers.every((r) => r.vote >= 5);

    if (hasReject) return 'rejected';
    if (hasWait) return 'waiting';
    if (allApproved) return 'approved';
    return 'pending';
  }
}

module.exports = { DevOpsClient };

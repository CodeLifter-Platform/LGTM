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
   * @param {string} orgUrl - Full URL which may include a project path, e.g.
   *                          "https://dev.azure.com/myorg"
   *                          "https://dev.azure.com/myorg/MyProject"
   *                          "https://myorg.visualstudio.com"
   *                          "https://myorg.visualstudio.com/MyProject"
   */
  constructor(pat, orgUrl) {
    const parsed = DevOpsClient.parseOrgUrl(orgUrl);
    this.orgUrl = parsed.orgUrl;
    this.projectFilter = parsed.project;  // null or e.g. "CommoditySolutions"

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

  /**
   * Parse a user-provided URL into org base URL + optional project.
   *
   * Handles:
   *   https://dev.azure.com/myorg                    → org only
   *   https://dev.azure.com/myorg/MyProject           → org + project
   *   https://myorg.visualstudio.com                  → org only
   *   https://myorg.visualstudio.com/MyProject        → org + project
   *   https://myorg.visualstudio.com/MyProject/_git/… → org + project (extra path stripped)
   */
  static parseOrgUrl(raw) {
    let url = raw.replace(/\/+$/, '');

    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);

      if (u.hostname === 'dev.azure.com') {
        // dev.azure.com/<org>[/<project>[/…]]
        const org = parts[0] || '';
        const project = parts[1] || null;
        return {
          orgUrl: `${u.protocol}//${u.hostname}/${org}`,
          project,
        };
      }

      if (u.hostname.endsWith('.visualstudio.com')) {
        // <org>.visualstudio.com[/<project>[/…]]
        const project = parts[0] || null;
        return {
          orgUrl: `${u.protocol}//${u.hostname}`,
          project,
        };
      }

      // On-prem / unknown — treat first path segment as collection,
      // second as possible project
      const project = parts.length >= 2 ? parts[1] : null;
      const basePath = parts.length >= 1 ? `/${parts[0]}` : '';
      return {
        orgUrl: `${u.protocol}//${u.hostname}${basePath}`,
        project,
      };
    } catch {
      // Couldn't parse — return as-is
      return { orgUrl: url, project: null };
    }
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
    let projects = await this.getProjects();

    // If the user provided a project in the URL, only show PRs from that project
    if (this.projectFilter) {
      projects = projects.filter(
        (p) => p.name.toLowerCase() === this.projectFilter.toLowerCase(),
      );
    }

    const allPrs = [];

    for (const project of projects) {
      try {
        const repos = await this.getRepos(project.name);
        for (const repo of repos) {
          const prs = await this.getOpenPRs(project.name, repo.id);
          for (const pr of prs.filter((p) => p.status === 'active')) {
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
              createdDate: pr.creationDate || '',
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

    // Sort by creation date descending (newest first) — matches the
    // default order of the Active panel in Azure DevOps.
    allPrs.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));

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

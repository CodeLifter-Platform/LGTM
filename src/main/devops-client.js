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

  // ── Authenticated user ───────────────────────────────────────────

  /**
   * Fetch the authenticated user's identity. Works for both
   * Azure DevOps Services and Server via /_apis/connectionData.
   */
  async getMe() {
    // _apis/connectionData predates api-version; passing it 400s on
    // visualstudio.com. Use connectOptions to scope the response instead.
    const res = await this.api.get('/_apis/connectionData', {
      params: { connectOptions: 'none' },
    });
    const u = res.data.authenticatedUser || {};
    return {
      id: u.id || '',
      displayName: u.providerDisplayName || u.customDisplayName || '',
      email: (u.properties && u.properties.Account && u.properties.Account['$value']) || '',
    };
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

  // ── Work Items: My Open Bugs ─────────────────────────────────────

  /**
   * Fetch all open bugs assigned to the authenticated user across every
   * project. The `@Me` WIQL macro resolves to whoever owns the PAT.
   * Returns a flat array of normalised bug objects sorted by priority.
   */
  async getMyOpenBugs() {
    let projects = await this.getProjects();

    if (this.projectFilter) {
      projects = projects.filter(
        (p) => p.name.toLowerCase() === this.projectFilter.toLowerCase(),
      );
    }

    const wiql = {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE [System.WorkItemType] = 'Bug'
          AND [System.AssignedTo] = @Me
          AND [System.State] NOT IN ('Closed', 'Resolved', 'Done', 'Removed')
        ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.CreatedDate] DESC
      `.trim(),
    };

    const allBugs = [];

    for (const project of projects) {
      try {
        const wiqlRes = await this.api.post(
          `/${encodeURIComponent(project.name)}/_apis/wit/wiql`,
          wiql,
          { params: { 'api-version': API_VERSION } },
        );
        const ids = (wiqlRes.data.workItems || []).map((w) => w.id);
        if (ids.length === 0) continue;

        // Batch work-item fetches in chunks of 200 (ADO limit).
        const fields = [
          'System.Id',
          'System.Title',
          'System.State',
          'System.TeamProject',
          'System.AssignedTo',
          'System.CreatedDate',
          'System.CreatedBy',
          'Microsoft.VSTS.Common.Severity',
          'Microsoft.VSTS.Common.Priority',
        ];

        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          const detailRes = await this.api.get('/_apis/wit/workitems', {
            params: {
              ids: chunk.join(','),
              fields: fields.join(','),
              'api-version': API_VERSION,
            },
          });
          for (const wi of detailRes.data.value || []) {
            const f = wi.fields || {};
            allBugs.push({
              id: wi.id,
              title: f['System.Title'] || '',
              state: f['System.State'] || '',
              severity: f['Microsoft.VSTS.Common.Severity'] || '',
              priority: f['Microsoft.VSTS.Common.Priority'] || null,
              project: f['System.TeamProject'] || project.name,
              assignedTo: f['System.AssignedTo']?.displayName || '',
              createdBy: f['System.CreatedBy']?.displayName || '',
              createdDate: f['System.CreatedDate'] || '',
              webUrl: `${this.orgUrl}/${encodeURIComponent(f['System.TeamProject'] || project.name)}/_workitems/edit/${wi.id}`,
            });
          }
        }
      } catch {
        // skip projects we can't read (WIQL may 403/404 for some processes)
      }
    }

    // Sort: highest priority first (1 → 4), unset last; within each, newest first.
    allBugs.sort((a, b) => {
      const pa = typeof a.priority === 'number' ? a.priority : 99;
      const pb = typeof b.priority === 'number' ? b.priority : 99;
      if (pa !== pb) return pa - pb;
      return new Date(b.createdDate) - new Date(a.createdDate);
    });

    return allBugs;
  }

  // ── Work Items: My Open Non-Bug Tickets ──────────────────────────

  /**
   * Fetch iteration classification nodes for a project and return a map of
   * IterationPath → { startDate, finishDate }. Used to sort groups by sprint
   * recency. Paths use the same backslash-separated format as
   * System.IterationPath on work items.
   */
  async getIterationMetadata(project) {
    try {
      const res = await this.api.get(
        `/${encodeURIComponent(project)}/_apis/wit/classificationnodes/Iterations`,
        { params: { '$depth': 10, 'api-version': API_VERSION } },
      );
      const map = {};
      const walk = (node, pathParts) => {
        const currentPath = pathParts.join('\\');
        map[currentPath] = {
          startDate: node.attributes?.startDate || null,
          finishDate: node.attributes?.finishDate || null,
        };
        (node.children || []).forEach((child) => {
          walk(child, [...pathParts, child.name]);
        });
      };
      walk(res.data, [res.data.name || project]);
      return map;
    } catch {
      return {};
    }
  }

  /**
   * Fetch all open non-Bug work items assigned to the authenticated user
   * across every project. Returns a flat array of normalised objects with
   * iteration metadata so the UI can group by sprint.
   */
  async getMyOpenWorkItems() {
    let projects = await this.getProjects();

    if (this.projectFilter) {
      projects = projects.filter(
        (p) => p.name.toLowerCase() === this.projectFilter.toLowerCase(),
      );
    }

    const wiql = {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE [System.WorkItemType] <> 'Bug'
          AND [System.AssignedTo] = @Me
          AND [System.State] NOT IN ('Closed', 'Resolved', 'Done', 'Removed', 'Completed')
        ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC
      `.trim(),
    };

    const allItems = [];

    for (const project of projects) {
      try {
        const wiqlRes = await this.api.post(
          `/${encodeURIComponent(project.name)}/_apis/wit/wiql`,
          wiql,
          { params: { 'api-version': API_VERSION } },
        );
        const ids = (wiqlRes.data.workItems || []).map((w) => w.id);
        if (ids.length === 0) continue;

        const iterMap = await this.getIterationMetadata(project.name);

        const fields = [
          'System.Id',
          'System.Title',
          'System.State',
          'System.WorkItemType',
          'System.TeamProject',
          'System.IterationPath',
          'System.AssignedTo',
          'System.CreatedDate',
          'System.ChangedDate',
          'Microsoft.VSTS.Common.Priority',
        ];

        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          const detailRes = await this.api.get('/_apis/wit/workitems', {
            params: {
              ids: chunk.join(','),
              fields: fields.join(','),
              'api-version': API_VERSION,
            },
          });
          for (const wi of detailRes.data.value || []) {
            const f = wi.fields || {};
            const iterPath = f['System.IterationPath'] || project.name;
            const iterMeta = iterMap[iterPath] || {};
            // Backlog = iteration path has no sprint nested under the project root.
            const isBacklog = iterPath === project.name || !iterPath.includes('\\');
            const iterName = isBacklog ? 'Backlog' : iterPath.split('\\').slice(1).join(' / ');

            allItems.push({
              id: wi.id,
              title: f['System.Title'] || '',
              state: f['System.State'] || '',
              type: f['System.WorkItemType'] || '',
              priority: typeof f['Microsoft.VSTS.Common.Priority'] === 'number'
                ? f['Microsoft.VSTS.Common.Priority']
                : null,
              project: f['System.TeamProject'] || project.name,
              iterationPath: iterPath,
              iterationName: iterName,
              isBacklog,
              iterationStart: iterMeta.startDate || null,
              iterationFinish: iterMeta.finishDate || null,
              createdDate: f['System.CreatedDate'] || '',
              changedDate: f['System.ChangedDate'] || '',
              webUrl: `${this.orgUrl}/${encodeURIComponent(f['System.TeamProject'] || project.name)}/_workitems/edit/${wi.id}`,
            });
          }
        }
      } catch {
        // skip projects we can't read
      }
    }

    return allItems;
  }

  /**
   * Fetch a single work item with description / repro steps / acceptance
   * criteria fields — used when kicking off an agent action on a bug/ticket
   * so the agent has full context.
   */
  async getWorkItemDetails(id) {
    const fields = [
      'System.Id',
      'System.Title',
      'System.State',
      'System.WorkItemType',
      'System.TeamProject',
      'System.Description',
      'Microsoft.VSTS.TCM.ReproSteps',
      'Microsoft.VSTS.TCM.SystemInfo',
      'Microsoft.VSTS.Common.AcceptanceCriteria',
      'Microsoft.VSTS.Common.Priority',
      'Microsoft.VSTS.Common.Severity',
      'System.Tags',
    ];
    const res = await this.api.get(`/_apis/wit/workitems/${id}`, {
      params: {
        fields: fields.join(','),
        'api-version': API_VERSION,
      },
    });
    const f = res.data.fields || {};
    return {
      id: res.data.id,
      title: f['System.Title'] || '',
      state: f['System.State'] || '',
      type: f['System.WorkItemType'] || '',
      project: f['System.TeamProject'] || '',
      description: f['System.Description'] || '',
      reproSteps: f['Microsoft.VSTS.TCM.ReproSteps'] || '',
      systemInfo: f['Microsoft.VSTS.TCM.SystemInfo'] || '',
      acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
      priority: typeof f['Microsoft.VSTS.Common.Priority'] === 'number' ? f['Microsoft.VSTS.Common.Priority'] : null,
      severity: f['Microsoft.VSTS.Common.Severity'] || '',
      tags: f['System.Tags'] || '',
    };
  }

  // ── Repo file tree (for autocomplete) ────────────────────────────

  /**
   * Fetch the full file tree for a repository.
   * Returns an array of path strings, e.g. [".gitignore", "src/main.js", ...]
   * Results are cached per project/repo for the lifetime of this client.
   */
  async getRepoFileTree(project, repoName) {
    const cacheKey = `${project}/${repoName}`;
    if (this._fileTreeCache && this._fileTreeCache[cacheKey]) {
      return this._fileTreeCache[cacheKey];
    }

    const res = await this.api.get(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoName)}/items`,
      {
        params: {
          recursionLevel: 'full',
          'api-version': API_VERSION,
        },
      },
    );

    const items = (res.data.value || [])
      .filter((item) => !item.isFolder)
      .map((item) => item.path.replace(/^\//, ''));   // strip leading slash

    if (!this._fileTreeCache) this._fileTreeCache = {};
    this._fileTreeCache[cacheKey] = items;
    return items;
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

  // ── PR Threads (for re-review awareness) ─────────────────────────

  /**
   * Fetch all comment threads on a PR, including their status.
   * Returns an array of { id, status, comments: [{ content, author }] }.
   * Status: 1=active, 2=fixed, 3=wontFix, 4=closed, 5=byDesign, 6=pending
   */
  async getPrThreads(project, repoId, prId) {
    const res = await this.api.get(
      `/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullrequests/${prId}/threads`,
      { params: { 'api-version': API_VERSION } },
    );
    const threads = (res.data.value || []).map((t) => ({
      id: t.id,
      status: t.status,                   // 1=active, 2=fixed, etc.
      isDeleted: t.isDeleted || false,
      publishedDate: t.publishedDate,
      comments: (t.comments || []).map((c) => ({
        content: c.content,
        author: c.author?.displayName || '',
        commentType: c.commentType,        // 1=text, 2=system
      })),
    }));
    return threads;
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

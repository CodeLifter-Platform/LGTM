/**
 * DevOpsClient — Azure DevOps client built on the official
 * `azure-devops-node-api` SDK. Auth via PAT.
 *
 * The SDK is a typed wrapper around the same REST endpoints we used to call
 * via axios; the public surface here is unchanged so callers don't need to
 * know which client backs them.
 *
 * SDK docs: https://github.com/microsoft/azure-devops-node-api
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const azdev = require('azure-devops-node-api');
const gitInterfaces = require('azure-devops-node-api/interfaces/GitInterfaces');
const witInterfaces = require('azure-devops-node-api/interfaces/WorkItemTrackingInterfaces');
const policyInterfaces = require('azure-devops-node-api/interfaces/PolicyInterfaces');

// Helpers
const toIso = (d) => {
  if (!d) return '';
  try { return new Date(d).toISOString(); } catch { return ''; }
};

class DevOpsClient {
  /**
   * @param {string} pat
   * @param {string} orgUrl - May include a project path; we strip it into projectFilter.
   */
  constructor(pat, orgUrl) {
    const parsed = DevOpsClient.parseOrgUrl(orgUrl);
    this.orgUrl = parsed.orgUrl;
    this.projectFilter = parsed.project;
    this.pat = pat;

    const handler = azdev.getPersonalAccessTokenHandler(pat);
    this.conn = new azdev.WebApi(this.orgUrl, handler);

    // Lazy API clients — instantiated on first use.
    this._core = null;
    this._git = null;
    this._wit = null;
    this._loc = null;
    this._policy = null;
    this._fileTreeCache = null;
  }

  async _getCore()   { return this._core   || (this._core   = await this.conn.getCoreApi()); }
  async _getGit()    { return this._git    || (this._git    = await this.conn.getGitApi()); }
  async _getWit()    { return this._wit    || (this._wit    = await this.conn.getWorkItemTrackingApi()); }
  async _getLoc()    { return this._loc    || (this._loc    = await this.conn.getLocationsApi()); }
  async _getPolicy() { return this._policy || (this._policy = await this.conn.getPolicyApi()); }

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
    let url = (raw || '').replace(/\/+$/, '');

    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);

      if (u.hostname === 'dev.azure.com') {
        const org = parts[0] || '';
        const project = parts[1] || null;
        return { orgUrl: `${u.protocol}//${u.hostname}/${org}`, project };
      }

      if (u.hostname.endsWith('.visualstudio.com')) {
        const project = parts[0] || null;
        return { orgUrl: `${u.protocol}//${u.hostname}`, project };
      }

      // On-prem / unknown — treat first path segment as collection,
      // second as possible project
      const project = parts.length >= 2 ? parts[1] : null;
      const basePath = parts.length >= 1 ? `/${parts[0]}` : '';
      return { orgUrl: `${u.protocol}//${u.hostname}${basePath}`, project };
    } catch {
      return { orgUrl: url, project: null };
    }
  }

  // ── Authenticated user ───────────────────────────────────────────

  /**
   * Hostname of the configured DevOps org (e.g. "dev.azure.com" or
   * "myorg.visualstudio.com"). Used to decide whether a given image
   * URL is hosted by DevOps and therefore safe to fetch with our PAT.
   */
  get orgHost() {
    try { return new URL(this.orgUrl).hostname; } catch { return ''; }
  }

  /**
   * GET an arbitrary DevOps URL with PAT auth and stream the body to
   * `destPath`. Returns { contentType, bytes }. Caller is responsible
   * for ensuring `destPath`'s parent directory exists.
   *
   * Only call this for URLs you trust to be hosted by your DevOps org —
   * otherwise the PAT goes to a third party. The image-extraction
   * helper enforces that filter before calling here.
   */
  async downloadAttachment(url, destPath) {
    const auth = Buffer.from(`:${this.pat}`).toString('base64');
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 30000,
      headers: { Authorization: `Basic ${auth}`, Accept: '*/*' },
    });
    fs.writeFileSync(destPath, Buffer.from(res.data));
    return {
      contentType: (res.headers['content-type'] || '').toLowerCase(),
      bytes: res.data.length,
    };
  }

  async getMe() {
    const loc = await this._getLoc();
    // 0 = ConnectOptions.None — we just want the authenticated user info.
    const data = await loc.getConnectionData(0);
    const u = (data && data.authenticatedUser) || {};
    return {
      id: u.id || '',
      displayName: u.providerDisplayName || u.customDisplayName || '',
      email: (u.properties && u.properties.Account && u.properties.Account['$value']) || '',
    };
  }

  // ── Projects ─────────────────────────────────────────────────────

  async getProjects() {
    const core = await this._getCore();
    const projects = await core.getProjects();
    return projects || [];
  }

  // ── Pull Requests ────────────────────────────────────────────────

  async getAllOpenPRs() {
    let projects = await this.getProjects();
    if (this.projectFilter) {
      projects = projects.filter(
        (p) => p.name.toLowerCase() === this.projectFilter.toLowerCase(),
      );
    }

    const git = await this._getGit();
    const allPrs = [];

    for (const project of projects) {
      let repos;
      try {
        repos = await git.getRepositories(project.name);
      } catch (err) {
        console.error(`[LGTM] Failed to list repos for ${project.name}: ${err.message}`);
        continue;
      }
      for (const repo of repos || []) {
        try {
          const prs = await git.getPullRequests(
            repo.id,
            { status: gitInterfaces.PullRequestStatus.Active },
            project.name,
          );
          // Fetch policy evaluations in parallel to avoid serial latency.
          const enriched = await Promise.all((prs || []).map(async (pr) => {
            const isApproved = await this._isPassingAllPolicies(project.id, pr.pullRequestId);
            return {
              id: pr.pullRequestId,
              title: pr.title,
              status: 'active',                                  // mirrors old shape
              repo: repo.name,
              project: project.name,
              repoId: repo.id,
              sourceBranch: pr.sourceRefName,
              targetBranch: pr.targetRefName,
              createdBy: (pr.createdBy && pr.createdBy.displayName) || '',
              createdDate: toIso(pr.creationDate),
              url: pr.url,
              webUrl: `${this.orgUrl}/${encodeURIComponent(project.name)}/_git/${encodeURIComponent(repo.name)}/pullrequest/${pr.pullRequestId}`,
              reviewStatus: this._reviewStatus(pr),
              isApproved,
            };
          }));
          allPrs.push(...enriched);
        } catch (err) {
          console.error(`[LGTM] Failed to list PRs for ${project.name}/${repo.name}: ${err.message}`);
        }
      }
    }

    // Newest first.
    allPrs.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    return allPrs;
  }

  async getRepos(project) {
    const git = await this._getGit();
    const repos = await git.getRepositories(project);
    return repos || [];
  }

  async getOpenPRs(project, repoId) {
    const git = await this._getGit();
    const prs = await git.getPullRequests(
      repoId,
      { status: gitInterfaces.PullRequestStatus.Active },
      project,
    );
    return prs || [];
  }

  // ── Repo file tree (for autocomplete) ────────────────────────────

  async getRepoFileTree(project, repoName) {
    const cacheKey = `${project}/${repoName}`;
    if (this._fileTreeCache && this._fileTreeCache[cacheKey]) {
      return this._fileTreeCache[cacheKey];
    }

    const git = await this._getGit();
    const items = await git.getItems(
      repoName,
      project,
      '/',
      gitInterfaces.VersionControlRecursionType.Full,
    );

    const paths = (items || [])
      .filter((item) => !item.isFolder)
      .map((item) => (item.path || '').replace(/^\//, ''));

    if (!this._fileTreeCache) this._fileTreeCache = {};
    this._fileTreeCache[cacheKey] = paths;
    return paths;
  }

  /**
   * Fetch a single PR with its full body (description). The PR list
   * endpoint omits the description, so we hit the per-PR endpoint when
   * we need it (e.g. to scan for inline images before dispatching a
   * review).
   */
  async getPullRequest(project, repoId, prId) {
    const git = await this._getGit();
    const pr = await git.getPullRequestById(prId, project);
    return {
      id: pr.pullRequestId,
      title: pr.title || '',
      description: pr.description || '',
      sourceBranch: pr.sourceRefName || '',
      targetBranch: pr.targetRefName || '',
      repoId: (pr.repository && pr.repository.id) || repoId,
    };
  }

  // ── PR Comments / Threads ────────────────────────────────────────

  async postPrComment(project, repoId, prId, commentText) {
    const git = await this._getGit();
    const thread = {
      comments: [{
        parentCommentId: 0,
        content: commentText,
        commentType: gitInterfaces.CommentType.Text,
      }],
      status: gitInterfaces.CommentThreadStatus.Active,
    };
    return await git.createThread(thread, repoId, prId, project);
  }

  /**
   * Fetch all comment threads on a PR. Status enum (numeric):
   * 1=Active, 2=Fixed, 3=WontFix, 4=Closed, 5=ByDesign, 6=Pending
   */
  async getPrThreads(project, repoId, prId) {
    const git = await this._getGit();
    const threads = await git.getThreads(repoId, prId, project);
    return (threads || []).map((t) => ({
      id: t.id,
      status: t.status,
      isDeleted: t.isDeleted || false,
      publishedDate: toIso(t.publishedDate),
      comments: (t.comments || []).map((c) => ({
        content: c.content,
        author: (c.author && c.author.displayName) || '',
        commentType: c.commentType,
      })),
    }));
  }

  // ── Work Items: Open Bugs ────────────────────────────────────────

  /**
   * Detect whether a work item has at least one linked pull request.
   * ADO represents PR links as `ArtifactLink` relations with the
   * attribute `name === "Pull Request"`. Work item must have been
   * fetched with `$expand=Relations` for this to return a meaningful
   * answer; otherwise `wi.relations` is undefined and we return false.
   */
  static _hasLinkedPullRequest(wi) {
    return (wi && wi.relations ? wi.relations : []).some((r) =>
      r && r.rel === 'ArtifactLink' && r.attributes && r.attributes.name === 'Pull Request',
    );
  }

  /**
   * Open bugs, by default assigned to the calling user.
   *
   * @param {{ assignedToMeOnly?: boolean }} opts
   *   `assignedToMeOnly` defaults to true (preserves the original
   *   behaviour of getMyOpenBugs). Set false for the "All" filter.
   *
   * Each returned bug has a `hasLinkedPR` boolean reflecting whether
   * any `ArtifactLink` relation of type Pull Request is attached.
   * Relations are fetched via `$expand=Relations`, which precludes
   * passing a narrowed field list — payload per item is slightly
   * larger but still bounded.
   */
  async getOpenBugs({ assignedToMeOnly = true } = {}) {
    let projects = await this.getProjects();
    if (this.projectFilter) {
      projects = projects.filter(
        (p) => p.name.toLowerCase() === this.projectFilter.toLowerCase(),
      );
    }

    const wit = await this._getWit();
    // "Mine" → assigned to the calling user. "All" → assigned to any
    // user (still excludes items with no assignee, by request).
    const assignedClause = assignedToMeOnly
      ? `AND [System.AssignedTo] = @Me`
      : `AND [System.AssignedTo] <> ''`;
    const wiqlQuery = {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE [System.WorkItemType] = 'Bug'
          ${assignedClause}
          AND [System.State] NOT IN ('Closed', 'Resolved', 'Done', 'Removed')
        ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.CreatedDate] DESC
      `.trim(),
    };

    const allBugs = [];
    for (const project of projects) {
      try {
        const result = await wit.queryByWiql(wiqlQuery, { project: project.name });
        const ids = (result.workItems || []).map((w) => w.id);
        if (ids.length === 0) continue;

        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          // ADO's getWorkItems rejects `fields` + `$expand` together,
          // so we omit fields when expanding relations. Payload is
          // larger per item but we still need the same fields anyway.
          const items = await wit.getWorkItems(
            chunk,
            undefined,
            undefined,
            witInterfaces.WorkItemExpand.Relations,
            witInterfaces.WorkItemErrorPolicy.Omit,
          );
          for (const wi of items || []) {
            const f = wi.fields || {};
            allBugs.push({
              id: wi.id,
              title: f['System.Title'] || '',
              state: f['System.State'] || '',
              severity: f['Microsoft.VSTS.Common.Severity'] || '',
              priority: typeof f['Microsoft.VSTS.Common.Priority'] === 'number'
                ? f['Microsoft.VSTS.Common.Priority']
                : null,
              project: f['System.TeamProject'] || project.name,
              assignedTo: (f['System.AssignedTo'] && f['System.AssignedTo'].displayName) || '',
              createdBy: (f['System.CreatedBy'] && f['System.CreatedBy'].displayName) || '',
              createdDate: toIso(f['System.CreatedDate']),
              webUrl: `${this.orgUrl}/${encodeURIComponent(f['System.TeamProject'] || project.name)}/_workitems/edit/${wi.id}`,
              hasLinkedPR: DevOpsClient._hasLinkedPullRequest(wi),
            });
          }
        }
      } catch (err) {
        // Skip projects we can't read (custom processes without Bug, missing
        // permissions, etc.).
        console.warn(`[LGTM] Skipping bug query for ${project.name}: ${err.message}`);
      }
    }

    allBugs.sort((a, b) => {
      const pa = typeof a.priority === 'number' ? a.priority : 99;
      const pb = typeof b.priority === 'number' ? b.priority : 99;
      if (pa !== pb) return pa - pb;
      return new Date(b.createdDate) - new Date(a.createdDate);
    });
    return allBugs;
  }

  // Back-compat alias — existing callers that only want their own bugs.
  async getMyOpenBugs() {
    return this.getOpenBugs({ assignedToMeOnly: true });
  }

  // ── Iteration metadata (for grouping tickets by sprint recency) ──

  async getIterationMetadata(project) {
    try {
      const wit = await this._getWit();
      const root = await wit.getClassificationNode(
        project,
        witInterfaces.TreeStructureGroup.Iterations,
        '',
        10,
      );
      const map = {};
      const walk = (node, pathParts) => {
        const currentPath = pathParts.join('\\');
        map[currentPath] = {
          startDate: node.attributes && node.attributes.startDate
            ? toIso(node.attributes.startDate) : null,
          finishDate: node.attributes && node.attributes.finishDate
            ? toIso(node.attributes.finishDate) : null,
        };
        (node.children || []).forEach((child) => {
          walk(child, [...pathParts, child.name]);
        });
      };
      walk(root, [root.name || project]);
      return map;
    } catch {
      return {};
    }
  }

  // ── Work Items: Open Non-Bug Tickets ─────────────────────────────

  /**
   * Open non-bug work items (tickets), by default assigned to the
   * calling user. See getOpenBugs for the assignedToMeOnly contract
   * and the relations-expansion / hasLinkedPR detail.
   */
  async getOpenWorkItems({ assignedToMeOnly = true } = {}) {
    let projects = await this.getProjects();
    if (this.projectFilter) {
      projects = projects.filter(
        (p) => p.name.toLowerCase() === this.projectFilter.toLowerCase(),
      );
    }

    const wit = await this._getWit();
    // "Mine" → assigned to the calling user. "All" → assigned to any
    // user (still excludes items with no assignee, by request).
    const assignedClause = assignedToMeOnly
      ? `AND [System.AssignedTo] = @Me`
      : `AND [System.AssignedTo] <> ''`;
    const wiqlQuery = {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE [System.WorkItemType] <> 'Bug'
          ${assignedClause}
          AND [System.State] NOT IN ('Closed', 'Resolved', 'Done', 'Removed', 'Completed')
        ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC
      `.trim(),
    };

    const allItems = [];
    for (const project of projects) {
      try {
        const result = await wit.queryByWiql(wiqlQuery, { project: project.name });
        const ids = (result.workItems || []).map((w) => w.id);
        if (ids.length === 0) continue;

        const iterMap = await this.getIterationMetadata(project.name);

        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          const items = await wit.getWorkItems(
            chunk,
            undefined,
            undefined,
            witInterfaces.WorkItemExpand.Relations,
            witInterfaces.WorkItemErrorPolicy.Omit,
          );
          for (const wi of items || []) {
            const f = wi.fields || {};
            const iterPath = f['System.IterationPath'] || project.name;
            const iterMeta = iterMap[iterPath] || {};
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
              assignedTo: (f['System.AssignedTo'] && f['System.AssignedTo'].displayName) || '',
              iterationPath: iterPath,
              iterationName: iterName,
              isBacklog,
              iterationStart: iterMeta.startDate || null,
              iterationFinish: iterMeta.finishDate || null,
              createdDate: toIso(f['System.CreatedDate']),
              changedDate: toIso(f['System.ChangedDate']),
              webUrl: `${this.orgUrl}/${encodeURIComponent(f['System.TeamProject'] || project.name)}/_workitems/edit/${wi.id}`,
              hasLinkedPR: DevOpsClient._hasLinkedPullRequest(wi),
            });
          }
        }
      } catch (err) {
        console.warn(`[LGTM] Skipping ticket query for ${project.name}: ${err.message}`);
      }
    }

    return allItems;
  }

  // Back-compat alias — existing callers that only want their own tickets.
  async getMyOpenWorkItems() {
    return this.getOpenWorkItems({ assignedToMeOnly: true });
  }

  // ── Single work item details (for agent context) ─────────────────

  async getWorkItemDetails(id) {
    const wit = await this._getWit();
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
    const wi = await wit.getWorkItem(id, fields);
    const f = (wi && wi.fields) || {};
    return {
      id: wi.id,
      title: f['System.Title'] || '',
      state: f['System.State'] || '',
      type: f['System.WorkItemType'] || '',
      project: f['System.TeamProject'] || '',
      description: f['System.Description'] || '',
      reproSteps: f['Microsoft.VSTS.TCM.ReproSteps'] || '',
      systemInfo: f['Microsoft.VSTS.TCM.SystemInfo'] || '',
      acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
      priority: typeof f['Microsoft.VSTS.Common.Priority'] === 'number'
        ? f['Microsoft.VSTS.Common.Priority']
        : null,
      severity: f['Microsoft.VSTS.Common.Severity'] || '',
      tags: f['System.Tags'] || '',
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────

  _reviewStatus(pr) {
    const reviewers = pr.reviewers || [];
    const hasReject = reviewers.some((r) => r.vote === -10);
    const hasWait   = reviewers.some((r) => r.vote === -5);
    const allApproved = reviewers.length > 0 && reviewers.every((r) => r.vote >= 5);
    if (hasReject) return 'rejected';
    if (hasWait) return 'waiting';
    if (allApproved) return 'approved';
    return 'pending';
  }

  /**
   * True iff every enabled, blocking branch policy on this PR has
   * status === Approved (2). NotApplicable / disabled / non-blocking
   * policies are ignored. Returns false on any error so we never
   * over-promise readiness.
   *
   * Uses the policy GUID artifactId format:
   *   vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}
   */
  async _isPassingAllPolicies(projectId, prId) {
    try {
      const policy = await this._getPolicy();
      const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
      const evals = await policy.getPolicyEvaluations(projectId, artifactId, false);
      if (!evals || evals.length === 0) return false;
      const Approved = policyInterfaces.PolicyEvaluationStatus.Approved;
      let blockingCount = 0;
      for (const ev of evals) {
        const cfg = ev.configuration || {};
        const enabled = cfg.isEnabled !== false;
        const blocking = cfg.isBlocking !== false;
        if (!enabled || !blocking) continue;
        blockingCount += 1;
        if (ev.status !== Approved) return false;
      }
      return blockingCount > 0;
    } catch (err) {
      console.error(`[LGTM] Failed to fetch policy evaluations for PR ${prId}: ${err.message}`);
      return false;
    }
  }
}

module.exports = { DevOpsClient };

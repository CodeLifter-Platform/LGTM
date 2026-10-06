/**
 * GitHubClient — GitHub REST + GraphQL client authenticated with a personal
 * access token (classic or fine-grained). Normalises pull requests and issues
 * into the same shapes `DevOpsClient` produces so the renderer and the agent
 * runner never have to know which service a row came from.
 *
 * Mapping to the Azure DevOps vocabulary the rest of the app uses:
 *
 *   ADO                     GitHub
 *   ----------------------  --------------------------------------------
 *   project                 repository owner (user or organisation login)
 *   repo                    repository name
 *   repoId                  "owner/name"
 *   PR id                   pull request number
 *   branch policies pass    reviews all approved AND mergeable_state=clean
 *   work item: Bug          issue carrying a bug-ish label
 *   work item: ticket       any other open issue
 *   iteration / sprint      milestone (due date = iteration finish)
 *   priority 1-4            P0/P1/P2/P3 or priority:high|medium|low labels
 *   linked PR               closedByPullRequestsReferences (GraphQL)
 *
 * The constructor takes an optional `http` function so tests can drive the
 * client without a network: `http({ method, url, headers, data, timeout,
 * responseType })` resolves `{ status, headers, data }` and never throws on
 * a non-2xx status. The default wraps axios.
 */

const fs = require('fs');

const DEFAULT_WEB = 'https://github.com';
const DEFAULT_API = 'https://api.github.com';
const PAGE = 100;

const toIso = (d) => {
  if (!d) return '';
  try { return new Date(d).toISOString(); } catch { return ''; }
};

// Labels that mark an issue as a bug. Matched case-insensitively against the
// label name with separators stripped, so "bug", "Bug", "type: bug",
// "kind/bug" and "type-bug" all count.
const BUG_LABEL_RE = /^(?:(?:type|kind|category)[:/\-\s]*)?bug$/i;

// Priority labels → ADO-style 1 (highest) … 4. Anything unmatched is null.
function priorityFromLabels(labels) {
  for (const raw of labels) {
    const l = String(raw).trim().toLowerCase().replace(/^priority[:/\-\s]*/, '').replace(/\s+/g, '');
    if (/^p0$|^p1$|^critical$|^urgent$|^highest$|^blocker$/.test(l)) return 1;
    if (/^p2$|^high$/.test(l)) return 2;
    if (/^p3$|^medium$|^normal$/.test(l)) return 3;
    if (/^p4$|^low$|^lowest$|^minor$/.test(l)) return 4;
  }
  return null;
}

function severityFromLabels(labels) {
  for (const raw of labels) {
    const m = String(raw).match(/^severity[:/\-\s]*(.+)$/i) || String(raw).match(/^sev[:/\-\s]*(.+)$/i);
    if (m) return m[1].trim();
  }
  return '';
}

function isBugLabel(name) {
  return BUG_LABEL_RE.test(String(name || '').trim().replace(/\s+/g, ''));
}

// Work item type for non-bug issues: GitHub issue types first, then labels.
function typeFromIssue(issue, labels) {
  if (issue.type && issue.type.name) return issue.type.name;
  const names = labels.map((l) => String(l).toLowerCase());
  if (names.some((n) => /epic/.test(n))) return 'Epic';
  if (names.some((n) => /story/.test(n))) return 'User Story';
  if (names.some((n) => /feature|enhancement/.test(n))) return 'Feature';
  if (names.some((n) => /task|chore/.test(n))) return 'Task';
  return 'Issue';
}

function labelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

class GitHubClient {
  /**
   * @param {string} token
   * @param {string} rawUrl  "https://github.com", "https://github.com/owner",
   *                         "https://github.com/owner/repo", or a GitHub
   *                         Enterprise host with the same path shapes.
   * @param {{ http?: function }} [opts]
   */
  constructor(token, rawUrl, opts = {}) {
    const parsed = GitHubClient.parseUrl(rawUrl);
    this.webUrl = parsed.webUrl;
    this.apiUrl = parsed.apiUrl;
    this.host = parsed.host;
    this.owner = parsed.owner;          // null = every owner the token can see
    this.repoFilter = parsed.repo;      // null = every repo under the owner
    this.token = token;
    this._http = opts.http || GitHubClient.defaultHttp;
    this._me = null;
    this._repoCache = new Map();        // owner → { at, repos }
    this._fileTreeCache = {};
    this._issueCache = new Map();       // scope → { at, issues }
  }

  /** Hosts an attachment URL may point at before the token is sent along. */
  get attachmentHosts() {
    const hosts = [this.host];
    if (this.host === 'github.com') hosts.push('githubusercontent.com', 'objects.githubusercontent.com');
    return hosts;
  }

  // Kept for symmetry with DevOpsClient.orgHost (prompt-attachments reads either).
  get orgHost() { return this.host; }

  /**
   * Parse a user-provided URL. The path (if any) scopes the listing:
   *   https://github.com                      → every owner the token can see
   *   https://github.com/myorg                → one owner
   *   https://github.com/myorg/myrepo         → one repo
   *   https://ghe.corp.com/myorg              → GitHub Enterprise, API at /api/v3
   * A bare "myorg" or "myorg/myrepo" is accepted too.
   */
  static parseUrl(raw) {
    let input = (raw || '').trim().replace(/\/+$/, '');
    if (!input) input = DEFAULT_WEB;
    if (!/^https?:\/\//i.test(input)) {
      input = input.includes('.') && !input.includes('/') ? `https://${input}` : `${DEFAULT_WEB}/${input}`;
    }
    let u;
    try { u = new URL(input); } catch { return { webUrl: DEFAULT_WEB, apiUrl: DEFAULT_API, host: 'github.com', owner: null, repo: null }; }
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);
    const owner = parts[0] || null;
    const repo = parts[1] ? parts[1].replace(/\.git$/, '') : null;
    const webUrl = `${u.protocol}//${u.host}`;
    const apiUrl = host === 'github.com' ? DEFAULT_API : `${webUrl}/api/v3`;
    return { webUrl, apiUrl, host, owner, repo };
  }

  static async defaultHttp(req) {
    const axios = require('axios');
    const res = await axios.request({
      method: req.method || 'GET',
      url: req.url,
      headers: req.headers,
      data: req.data,
      timeout: req.timeout || 30000,
      responseType: req.responseType || 'json',
      maxRedirects: 5,
      validateStatus: () => true,
    });
    return { status: res.status, headers: res.headers || {}, data: res.data };
  }

  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'LGTM',
      ...extra,
    };
  }

  async _get(pathOrUrl, { query = {}, timeout } = {}) {
    const url = new URL(/^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await this._http({ method: 'GET', url: url.toString(), headers: this._headers(), timeout });
    if (res.status >= 400) throw GitHubClient._error(res, url.pathname);
    return res;
  }

  async _getAll(path, query = {}, { max = 1000 } = {}) {
    const out = [];
    let page = 1;
    while (out.length < max) {
      const res = await this._get(path, { query: { ...query, per_page: PAGE, page } });
      const items = Array.isArray(res.data) ? res.data : (res.data && res.data.items) || [];
      out.push(...items);
      if (items.length < PAGE) break;
      page += 1;
    }
    return out.slice(0, max);
  }

  async _post(path, body) {
    const res = await this._http({
      method: 'POST', url: `${this.apiUrl}${path}`, headers: this._headers({ 'Content-Type': 'application/json' }), data: body,
    });
    if (res.status >= 400) throw GitHubClient._error(res, path);
    return res.data;
  }

  async _graphql(query, variables) {
    const url = this.host === 'github.com' ? 'https://api.github.com/graphql' : `${this.webUrl}/api/graphql`;
    const res = await this._http({
      method: 'POST', url, headers: this._headers({ 'Content-Type': 'application/json' }), data: { query, variables },
    });
    if (res.status >= 400) throw GitHubClient._error(res, '/graphql');
    if (res.data && res.data.errors && res.data.errors.length && !res.data.data) {
      throw new Error(`GraphQL: ${res.data.errors.map((e) => e.message).join('; ')}`);
    }
    return (res.data && res.data.data) || {};
  }

  static _error(res, path) {
    const msg = (res.data && (res.data.message || res.data.error)) || `HTTP ${res.status}`;
    const err = new Error(`GitHub ${res.status} on ${path}: ${msg}`);
    err.status = res.status;
    err.response = { status: res.status };
    return err;
  }

  // ── Authenticated user ───────────────────────────────────────────

  async getMe() {
    if (this._me) return this._me;
    const res = await this._get('/user');
    const u = res.data || {};
    this._me = {
      id: u.login || '',
      login: u.login || '',
      displayName: u.name || u.login || '',
      email: u.email || '',
    };
    return this._me;
  }

  // ── "Projects" = owners ──────────────────────────────────────────

  /**
   * The owners whose repositories are listed. With a URL path this is the one
   * owner; otherwise the token's own user plus every organisation it belongs
   * to. Shaped like ADO projects (`{ id, name }`) for the callers that iterate.
   */
  async getProjects() {
    if (this.owner) return [{ id: this.owner, name: this.owner }];
    const me = await this.getMe();
    const owners = [{ id: me.login, name: me.login }];
    try {
      const orgs = await this._getAll('/user/orgs');
      for (const o of orgs) if (o && o.login) owners.push({ id: o.login, name: o.login });
    } catch (err) {
      console.warn(`[LGTM] GitHub: could not list organisations: ${err.message}`);
    }
    return owners;
  }

  // ── Repositories ─────────────────────────────────────────────────

  async getRepos(owner, { force = false } = {}) {
    const cached = this._repoCache.get(owner);
    if (!force && cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.repos;

    let raw;
    const me = await this.getMe().catch(() => null);
    if (me && me.login.toLowerCase() === String(owner).toLowerCase()) {
      raw = await this._getAll('/user/repos', { affiliation: 'owner', sort: 'pushed' });
    } else {
      try {
        raw = await this._getAll(`/orgs/${encodeURIComponent(owner)}/repos`, { type: 'all', sort: 'pushed' });
      } catch (err) {
        if (err.status !== 404) throw err;
        raw = await this._getAll(`/users/${encodeURIComponent(owner)}/repos`, { sort: 'pushed' });
      }
    }
    const repos = raw
      .filter((r) => r && !r.archived && !r.disabled)
      .filter((r) => !this.repoFilter || r.name.toLowerCase() === this.repoFilter.toLowerCase())
      .map((r) => ({
        id: r.full_name,
        name: r.name,
        owner: (r.owner && r.owner.login) || owner,
        defaultBranch: r.default_branch || 'main',
        private: !!r.private,
        openIssues: typeof r.open_issues_count === 'number' ? r.open_issues_count : null,
      }));
    this._repoCache.set(owner, { at: Date.now(), repos });
    return repos;
  }

  // ── Pull requests ────────────────────────────────────────────────

  /**
   * Every open PR across the owners in scope. Discovery is one search call
   * per owner (cheap, rate-limited separately); each hit is then enriched with
   * its branches, mergeability and review state (two calls per PR, six in
   * flight at a time).
   */
  async getAllOpenPRs() {
    const owners = await this.getProjects();
    const hits = [];
    for (const owner of owners) {
      let q = `is:pr is:open archived:false user:${owner.name}`;
      if (this.repoFilter) q = `is:pr is:open repo:${owner.name}/${this.repoFilter}`;
      try {
        const found = await this._getAll('/search/issues', { q, sort: 'created', order: 'desc' });
        hits.push(...found);
      } catch (err) {
        console.error(`[LGTM] GitHub: failed to search PRs for ${owner.name}: ${err.message}`);
      }
    }

    const prs = await mapLimit(hits, 6, async (hit) => {
      try {
        return await this._enrichPr(hit);
      } catch (err) {
        console.error(`[LGTM] GitHub: failed to load PR ${hit.html_url}: ${err.message}`);
        return null;
      }
    });

    const out = prs.filter(Boolean);
    out.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    return out;
  }

  static _ownerRepoFromRepositoryUrl(repositoryUrl) {
    // https://api.github.com/repos/{owner}/{repo}
    const m = String(repositoryUrl || '').match(/\/repos\/([^/]+)\/([^/]+)\/?$/);
    return m ? { owner: m[1], repo: m[2] } : { owner: '', repo: '' };
  }

  async _enrichPr(hit) {
    const { owner, repo } = GitHubClient._ownerRepoFromRepositoryUrl(hit.repository_url);
    const number = hit.number;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
    const [prRes, reviewsRes] = await Promise.all([
      this._get(base),
      this._get(`${base}/reviews`, { query: { per_page: PAGE } }),
    ]);
    const pr = prRes.data || {};
    const reviews = Array.isArray(reviewsRes.data) ? reviewsRes.data : [];
    return GitHubClient.normalizePr(pr, reviews, { owner, repo });
  }

  /**
   * Pure: build the normalised PR row from a `GET /pulls/{n}` body and its
   * reviews. Exported for tests.
   */
  static normalizePr(pr, reviews, { owner, repo }) {
    const reviewStatus = GitHubClient.reviewStatus(reviews, pr.user && pr.user.login);
    const mergeableState = pr.mergeable_state || 'unknown';
    const isApproved = reviewStatus === 'approved' && mergeableState === 'clean';
    const headRef = (pr.head && pr.head.ref) || '';
    const baseRef = (pr.base && pr.base.ref) || '';
    const headRepo = pr.head && pr.head.repo ? pr.head.repo.full_name : `${owner}/${repo}`;
    return {
      id: pr.number,
      title: pr.title || '',
      status: 'active',
      repo,
      project: owner,
      repoId: `${owner}/${repo}`,
      sourceBranch: headRef,
      targetBranch: baseRef,
      // A PR from a fork carries the fork's full name so the cloner can fetch
      // the head from the right remote.
      headRepo,
      isFork: headRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase(),
      createdBy: (pr.user && pr.user.login) || '',
      createdDate: toIso(pr.created_at),
      url: pr.url || '',
      webUrl: pr.html_url || '',
      reviewStatus,
      isApproved,
      isDraft: !!pr.draft,
      mergeableState,
      provider: 'github',
    };
  }

  /**
   * Latest non-comment review per reviewer decides:
   *   any CHANGES_REQUESTED → rejected
   *   ≥1 APPROVED and no other state → approved
   *   otherwise → pending
   * The author's own reviews don't count (GitHub ignores them too).
   */
  static reviewStatus(reviews, authorLogin) {
    const latest = new Map();
    for (const r of reviews || []) {
      const login = r.user && r.user.login;
      if (!login || login === authorLogin) continue;
      if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
      latest.set(login, r.state);
    }
    const states = [...latest.values()];
    if (states.includes('CHANGES_REQUESTED')) return 'rejected';
    if (states.length > 0 && states.every((s) => s === 'APPROVED')) return 'approved';
    return 'pending';
  }

  async getOpenPRs(project, repoId) {
    const [owner, repo] = String(repoId).includes('/') ? repoId.split('/') : [project, repoId];
    const list = await this._getAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, { state: 'open' });
    return list;
  }

  async getPullRequest(project, repoId, prId) {
    const [owner, repo] = String(repoId).includes('/') ? repoId.split('/') : [project, repoId];
    const res = await this._get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prId}`);
    const pr = res.data || {};
    return {
      id: pr.number,
      title: pr.title || '',
      description: pr.body || '',
      sourceBranch: (pr.head && pr.head.ref) || '',
      targetBranch: (pr.base && pr.base.ref) || '',
      repoId: `${owner}/${repo}`,
    };
  }

  // ── PR comments / threads ────────────────────────────────────────

  async postPrComment(project, repoId, prId, commentText) {
    const [owner, repo] = String(repoId).includes('/') ? repoId.split('/') : [project, repoId];
    return this._post(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prId}/comments`, { body: commentText });
  }

  /**
   * Review threads (resolved state via GraphQL) plus top-level issue comments,
   * in the ADO thread shape: status 1 = Active, 2 = Fixed (resolved).
   */
  async getPrThreads(project, repoId, prId) {
    const [owner, repo] = String(repoId).includes('/') ? repoId.split('/') : [project, repoId];
    const threads = [];

    try {
      const data = await this._graphql(`
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id isResolved isOutdated path
                  comments(first: 50) { nodes { body createdAt author { login } } }
                }
              }
            }
          }
        }`, { owner, repo, number: Number(prId) });
      const nodes = (((data.repository || {}).pullRequest || {}).reviewThreads || {}).nodes || [];
      nodes.forEach((t, i) => {
        const comments = ((t.comments || {}).nodes || []).map((c) => ({
          content: c.body || '',
          author: (c.author && c.author.login) || '',
          commentType: 1,
        }));
        threads.push({
          id: t.id || `thread-${i}`,
          status: t.isResolved ? 2 : 1,
          isDeleted: false,
          isOutdated: !!t.isOutdated,
          path: t.path || '',
          publishedDate: toIso(comments.length && ((t.comments.nodes[0] || {}).createdAt)),
          comments,
        });
      });
    } catch (err) {
      console.warn(`[LGTM] GitHub: review threads unavailable (${err.message}); falling back to flat review comments`);
      const flat = await this._getAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prId}/comments`);
      const byRoot = new Map();
      for (const c of flat) {
        const root = c.in_reply_to_id || c.id;
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root).push(c);
      }
      for (const [root, cs] of byRoot) {
        threads.push({
          id: root,
          status: 1,
          isDeleted: false,
          path: cs[0].path || '',
          publishedDate: toIso(cs[0].created_at),
          comments: cs.map((c) => ({ content: c.body || '', author: (c.user && c.user.login) || '', commentType: 1 })),
        });
      }
    }

    const issueComments = await this._getAll(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${prId}/comments`);
    for (const c of issueComments) {
      threads.push({
        id: c.id,
        status: 1,
        isDeleted: false,
        path: '',
        publishedDate: toIso(c.created_at),
        comments: [{ content: c.body || '', author: (c.user && c.user.login) || '', commentType: 1 }],
      });
    }
    return threads;
  }

  // ── Issues → bugs / tickets ──────────────────────────────────────

  async _openIssues({ assignedToMeOnly }) {
    const scope = assignedToMeOnly ? 'mine' : 'all';
    const cached = this._issueCache.get(scope);
    if (cached && Date.now() - cached.at < 15 * 1000) return cached.issues;

    const owners = await this.getProjects();
    const hits = [];
    for (const owner of owners) {
      let q = `is:issue is:open archived:false user:${owner.name}`;
      if (this.repoFilter) q = `is:issue is:open repo:${owner.name}/${this.repoFilter}`;
      if (assignedToMeOnly) q += ' assignee:@me';
      try {
        const found = await this._getAll('/search/issues', { q, sort: 'updated', order: 'desc' });
        hits.push(...found);
      } catch (err) {
        console.warn(`[LGTM] GitHub: skipping issue query for ${owner.name}: ${err.message}`);
      }
    }

    // "All" still means "assigned to somebody", matching the ADO query.
    const issues = hits
      .filter((i) => i && !i.pull_request)
      .filter((i) => assignedToMeOnly || (Array.isArray(i.assignees) && i.assignees.length > 0));

    await this._attachLinkedPrFlags(issues);
    this._issueCache.set(scope, { at: Date.now(), issues });
    return issues;
  }

  /**
   * Mark each issue with `_hasLinkedPR` using one GraphQL query per 50 issues
   * (`closedByPullRequestsReferences`). On failure the flag defaults to false
   * so the "No PR" filter degrades to "show everything".
   */
  async _attachLinkedPrFlags(issues) {
    for (const i of issues) i._hasLinkedPR = false;
    for (let start = 0; start < issues.length; start += 50) {
      const chunk = issues.slice(start, start + 50);
      const parts = chunk.map((iss, idx) => {
        const { owner, repo } = GitHubClient._ownerRepoFromRepositoryUrl(iss.repository_url);
        return `i${idx}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { issue(number: ${iss.number}) { closedByPullRequestsReferences(first: 1) { totalCount } } }`;
      });
      try {
        const data = await this._graphql(`query { ${parts.join('\n')} }`);
        chunk.forEach((iss, idx) => {
          const node = data[`i${idx}`];
          const count = node && node.issue && node.issue.closedByPullRequestsReferences
            ? node.issue.closedByPullRequestsReferences.totalCount : 0;
          iss._hasLinkedPR = count > 0;
        });
      } catch (err) {
        console.warn(`[LGTM] GitHub: linked-PR lookup failed: ${err.message}`);
      }
    }
  }

  static normalizeIssue(issue, { bug }) {
    const { owner, repo } = GitHubClient._ownerRepoFromRepositoryUrl(issue.repository_url);
    const labels = labelNames(issue);
    const ms = issue.milestone || null;
    const base = {
      id: issue.number,
      title: issue.title || '',
      state: issue.state === 'open' ? (issue.state_reason || 'Open') : (issue.state || ''),
      priority: priorityFromLabels(labels),
      project: owner,
      repo,
      repoId: `${owner}/${repo}`,
      assignedTo: (issue.assignees && issue.assignees[0] && issue.assignees[0].login) || (issue.assignee && issue.assignee.login) || '',
      createdBy: (issue.user && issue.user.login) || '',
      createdDate: toIso(issue.created_at),
      changedDate: toIso(issue.updated_at),
      webUrl: issue.html_url || '',
      hasLinkedPR: !!issue._hasLinkedPR,
      labels,
      provider: 'github',
    };
    if (bug) {
      return { ...base, severity: severityFromLabels(labels), type: 'Bug' };
    }
    return {
      ...base,
      type: typeFromIssue(issue, labels),
      iterationPath: ms ? ms.title : owner,
      iterationName: ms ? ms.title : 'Backlog',
      isBacklog: !ms,
      iterationStart: null,
      iterationFinish: ms && ms.due_on ? toIso(ms.due_on) : null,
    };
  }

  async getOpenBugs({ assignedToMeOnly = true } = {}) {
    const issues = await this._openIssues({ assignedToMeOnly });
    const bugs = issues
      .filter((i) => labelNames(i).some(isBugLabel))
      .map((i) => GitHubClient.normalizeIssue(i, { bug: true }));
    bugs.sort((a, b) => {
      const pa = typeof a.priority === 'number' ? a.priority : 99;
      const pb = typeof b.priority === 'number' ? b.priority : 99;
      if (pa !== pb) return pa - pb;
      return new Date(b.createdDate) - new Date(a.createdDate);
    });
    return bugs;
  }

  async getMyOpenBugs() { return this.getOpenBugs({ assignedToMeOnly: true }); }

  async getOpenWorkItems({ assignedToMeOnly = true } = {}) {
    const issues = await this._openIssues({ assignedToMeOnly });
    return issues
      .filter((i) => !labelNames(i).some(isBugLabel))
      .map((i) => GitHubClient.normalizeIssue(i, { bug: false }));
  }

  async getMyOpenWorkItems() { return this.getOpenWorkItems({ assignedToMeOnly: true }); }

  /**
   * Full issue body for the agent prompt. Takes the normalised work item
   * (needs `project`, `repo`, `id`) because issue numbers are per-repo.
   */
  async getWorkItemDetails(workItem) {
    const owner = workItem.project;
    const repo = workItem.repo;
    const res = await this._get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${workItem.id}`);
    const issue = res.data || {};
    const labels = labelNames(issue);
    const bug = labels.some(isBugLabel);
    return {
      id: issue.number,
      title: issue.title || '',
      state: issue.state || '',
      type: bug ? 'Bug' : typeFromIssue(issue, labels),
      project: owner,
      repo,
      description: issue.body || '',
      reproSteps: '',
      systemInfo: '',
      acceptanceCriteria: '',
      priority: priorityFromLabels(labels),
      severity: severityFromLabels(labels),
      tags: labels.join('; '),
      webUrl: issue.html_url || workItem.webUrl || '',
      // GitHub bodies are markdown, not HTML; the prompt builders strip
      // tags only when they see them.
      bodyFormat: 'markdown',
    };
  }

  // ── Repo file tree (for autocomplete) ────────────────────────────

  async getRepoFileTree(project, repoName) {
    const cacheKey = `${project}/${repoName}`;
    if (this._fileTreeCache[cacheKey]) return this._fileTreeCache[cacheKey];
    const repoRes = await this._get(`/repos/${encodeURIComponent(project)}/${encodeURIComponent(repoName)}`);
    const branch = (repoRes.data && repoRes.data.default_branch) || 'main';
    const treeRes = await this._get(
      `/repos/${encodeURIComponent(project)}/${encodeURIComponent(repoName)}/git/trees/${encodeURIComponent(branch)}`,
      { query: { recursive: 1 } },
    );
    const paths = ((treeRes.data && treeRes.data.tree) || [])
      .filter((t) => t.type === 'blob')
      .map((t) => t.path);
    this._fileTreeCache[cacheKey] = paths;
    return paths;
  }

  // ── Attachments ──────────────────────────────────────────────────

  async downloadAttachment(url, destPath) {
    const res = await this._http({
      method: 'GET', url, headers: this._headers({ Accept: '*/*' }), responseType: 'arraybuffer', timeout: 30000,
    });
    if (res.status >= 400) throw GitHubClient._error(res, url);
    fs.writeFileSync(destPath, Buffer.from(res.data));
    return {
      contentType: String(res.headers['content-type'] || '').toLowerCase(),
      bytes: res.data.length,
    };
  }
}

module.exports = {
  GitHubClient,
  priorityFromLabels,
  severityFromLabels,
  isBugLabel,
  typeFromIssue,
};

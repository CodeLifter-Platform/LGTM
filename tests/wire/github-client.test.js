const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitHubClient, priorityFromLabels, isBugLabel, typeFromIssue } = require('../../src/main/providers/github-client');
const { scriptedHttp, ghPr, ghIssue } = require('../helpers/scripted-http');

// Quiet the client's console.warn/error noise inside tests.
const origWarn = console.warn; const origError = console.error;
test.before(() => { console.warn = () => {}; console.error = () => {}; });
test.after(() => { console.warn = origWarn; console.error = origError; });

test('parseUrl: github.com, owner, repo, enterprise and bare forms', () => {
  assert.deepEqual(GitHubClient.parseUrl('https://github.com'), { webUrl: 'https://github.com', apiUrl: 'https://api.github.com', host: 'github.com', owner: null, repo: null });
  assert.deepEqual(GitHubClient.parseUrl('https://github.com/acme/'), { webUrl: 'https://github.com', apiUrl: 'https://api.github.com', host: 'github.com', owner: 'acme', repo: null });
  assert.deepEqual(GitHubClient.parseUrl('https://github.com/acme/widgets.git'), { webUrl: 'https://github.com', apiUrl: 'https://api.github.com', host: 'github.com', owner: 'acme', repo: 'widgets' });
  assert.deepEqual(GitHubClient.parseUrl('https://ghe.corp.com/platform'), { webUrl: 'https://ghe.corp.com', apiUrl: 'https://ghe.corp.com/api/v3', host: 'ghe.corp.com', owner: 'platform', repo: null });
  assert.equal(GitHubClient.parseUrl('acme').owner, 'acme');
  assert.equal(GitHubClient.parseUrl('acme/widgets').repo, 'widgets');
  assert.equal(GitHubClient.parseUrl('').host, 'github.com');
});

test('reviewStatus: latest review per reviewer decides; author and comments ignored', () => {
  const r = (login, state) => ({ user: { login }, state });
  assert.equal(GitHubClient.reviewStatus([], 'alice'), 'pending');
  assert.equal(GitHubClient.reviewStatus([r('bob', 'APPROVED')], 'alice'), 'approved');
  assert.equal(GitHubClient.reviewStatus([r('bob', 'APPROVED'), r('carol', 'COMMENTED')], 'alice'), 'approved');
  assert.equal(GitHubClient.reviewStatus([r('bob', 'CHANGES_REQUESTED'), r('bob', 'APPROVED')], 'alice'), 'approved');
  assert.equal(GitHubClient.reviewStatus([r('bob', 'APPROVED'), r('carol', 'CHANGES_REQUESTED')], 'alice'), 'rejected');
  assert.equal(GitHubClient.reviewStatus([r('alice', 'APPROVED')], 'alice'), 'pending', 'self-review does not count');
});

test('normalizePr: shape, fork detection and the approval rule', () => {
  const pr = GitHubClient.normalizePr(ghPr(), [{ user: { login: 'bob' }, state: 'APPROVED' }], { owner: 'acme', repo: 'widgets' });
  assert.equal(pr.id, 42);
  assert.equal(pr.project, 'acme');
  assert.equal(pr.repo, 'widgets');
  assert.equal(pr.repoId, 'acme/widgets');
  assert.equal(pr.sourceBranch, 'feature/providers');
  assert.equal(pr.targetBranch, 'main');
  assert.equal(pr.createdBy, 'alice');
  assert.equal(pr.createdDate, '2026-10-01T10:00:00.000Z');
  assert.equal(pr.webUrl, 'https://github.com/acme/widgets/pull/42');
  assert.equal(pr.provider, 'github');
  assert.equal(pr.isFork, false);
  assert.equal(pr.reviewStatus, 'approved');
  assert.equal(pr.isApproved, true, 'approved reviews + clean mergeable state');

  const blocked = GitHubClient.normalizePr(ghPr({ mergeable_state: 'blocked' }), [{ user: { login: 'bob' }, state: 'APPROVED' }], { owner: 'acme', repo: 'widgets' });
  assert.equal(blocked.isApproved, false, 'a blocked PR is never "passing all policies"');

  const noReviews = GitHubClient.normalizePr(ghPr(), [], { owner: 'acme', repo: 'widgets' });
  assert.equal(noReviews.isApproved, false, 'clean without an approval is still pending');

  const fork = GitHubClient.normalizePr(ghPr({ head: { ref: 'fix', repo: { full_name: 'dave/widgets' } } }), [], { owner: 'acme', repo: 'widgets' });
  assert.equal(fork.isFork, true);
  assert.equal(fork.headRepo, 'dave/widgets');
});

test('label mapping: priority, bug detection, work item type', () => {
  assert.equal(priorityFromLabels(['P1']), 1);
  assert.equal(priorityFromLabels(['priority: high']), 2);
  assert.equal(priorityFromLabels(['priority/medium']), 3);
  assert.equal(priorityFromLabels(['low']), 4);
  assert.equal(priorityFromLabels(['enhancement']), null);
  assert.equal(isBugLabel('bug'), true);
  assert.equal(isBugLabel('Type: Bug'), true);
  assert.equal(isBugLabel('kind/bug'), true);
  assert.equal(isBugLabel('debug'), false);
  assert.equal(typeFromIssue({}, ['enhancement']), 'Feature');
  assert.equal(typeFromIssue({}, ['epic']), 'Epic');
  assert.equal(typeFromIssue({ type: { name: 'Task' } }, []), 'Task');
  assert.equal(typeFromIssue({}, []), 'Issue');
});

test('getAllOpenPRs: search discovers, per-PR enrich normalises, failures are skipped, newest first', async () => {
  const http = scriptedHttp([
    { match: 'GET https://api.github.com/user', data: { login: 'alice', name: 'Alice' } },
    { match: /GET https:\/\/api\.github\.com\/search\/issues\?q=is%3Apr/, data: { items: [
      { number: 42, repository_url: 'https://api.github.com/repos/acme/widgets', html_url: 'https://github.com/acme/widgets/pull/42' },
      { number: 43, repository_url: 'https://api.github.com/repos/acme/widgets', html_url: 'https://github.com/acme/widgets/pull/43' },
      { number: 9, repository_url: 'https://api.github.com/repos/acme/gadgets', html_url: 'https://github.com/acme/gadgets/pull/9' },
    ] } },
    { match: 'GET https://api.github.com/repos/acme/widgets/pulls/42/reviews', data: [{ user: { login: 'bob' }, state: 'APPROVED' }] },
    { match: 'GET https://api.github.com/repos/acme/widgets/pulls/42', data: ghPr() },
    { match: 'GET https://api.github.com/repos/acme/widgets/pulls/43/reviews', data: [] },
    { match: 'GET https://api.github.com/repos/acme/widgets/pulls/43', data: ghPr({ number: 43, created_at: '2026-10-03T10:00:00Z', mergeable_state: 'dirty' }) },
    { match: 'GET https://api.github.com/repos/acme/gadgets/pulls/9', status: 500, data: { message: 'boom' } },
    { match: 'GET https://api.github.com/repos/acme/gadgets/pulls/9/reviews', data: [] },
  ]);
  const client = new GitHubClient('tok', 'https://github.com/acme', { http });
  const prs = await client.getAllOpenPRs();
  assert.deepEqual(prs.map((p) => p.id), [43, 42], 'newest first, broken PR dropped');
  assert.equal(prs[1].isApproved, true);
  assert.equal(prs[0].isApproved, false);
  // Every request carried the bearer token and never the raw token in the URL.
  for (const c of http.calls) {
    assert.equal(c.req.headers.Authorization, 'Bearer tok');
    assert.ok(!c.key.includes('tok&'), 'token never in the query string');
  }
  // Owner scoping: the search was for user:acme, not the token's user.
  assert.ok(http.calls.some((c) => c.key.includes('user%3Aacme')));
});

test('getProjects: no owner means the token user plus their orgs', async () => {
  const http = scriptedHttp([
    { match: 'GET https://api.github.com/user/orgs', data: [{ login: 'acme' }, { login: 'other' }] },
    { match: 'GET https://api.github.com/user', data: { login: 'alice' } },
  ]);
  const client = new GitHubClient('tok', 'https://github.com', { http });
  const owners = await client.getProjects();
  assert.deepEqual(owners.map((o) => o.name), ['alice', 'acme', 'other']);
});

test('issues: bugs and tickets partition by label, "all" still needs an assignee, linked PRs via GraphQL', async () => {
  const issues = [
    ghIssue(),                                                                   // bug, P1, assigned
    ghIssue({ number: 8, title: 'Dark mode', labels: [{ name: 'enhancement' }], milestone: { title: 'v1.2', due_on: '2026-11-01T00:00:00Z' } }),
    ghIssue({ number: 9, title: 'Nobody owns this', assignees: [], labels: [] }), // unassigned
    ghIssue({ number: 10, title: 'A PR, not an issue', pull_request: { url: 'x' } }),
  ];
  const http = scriptedHttp([
    { match: 'GET https://api.github.com/user', data: { login: 'alice' } },
    { match: /GET https:\/\/api\.github\.com\/search\/issues\?q=is%3Aissue/, reply: (req) => ({ status: 200, headers: {}, data: { items: req.url.includes('assignee%3A%40me') ? issues.filter((i) => i.assignees.length) : issues } }) },
    { match: 'POST https://api.github.com/graphql', reply: (req) => {
      // i0 = #7 has a closing PR, the rest do not.
      const n = (req.data.query.match(/issue\(number: \d+\)/g) || []).length;
      const data = {};
      for (let i = 0; i < n; i++) data[`i${i}`] = { issue: { closedByPullRequestsReferences: { totalCount: i === 0 ? 1 : 0 } } };
      return { status: 200, headers: {}, data: { data } };
    } },
  ]);
  const client = new GitHubClient('tok', 'https://github.com/acme', { http });

  const bugs = await client.getOpenBugs({ assignedToMeOnly: true });
  assert.deepEqual(bugs.map((b) => b.id), [7]);
  assert.equal(bugs[0].priority, 1);
  assert.equal(bugs[0].project, 'acme');
  assert.equal(bugs[0].repo, 'widgets');
  assert.equal(bugs[0].hasLinkedPR, true);
  assert.equal(bugs[0].provider, 'github');

  const tickets = await client.getOpenWorkItems({ assignedToMeOnly: true });
  assert.deepEqual(tickets.map((t) => t.id), [8]);
  assert.equal(tickets[0].type, 'Feature');
  assert.equal(tickets[0].iterationName, 'v1.2');
  assert.equal(tickets[0].isBacklog, false);
  assert.equal(tickets[0].iterationFinish, '2026-11-01T00:00:00.000Z');
  assert.equal(tickets[0].hasLinkedPR, false);

  const all = await client.getOpenWorkItems({ assignedToMeOnly: false });
  assert.ok(!all.some((t) => t.id === 9), 'unassigned issues are excluded from "all"');
  assert.ok(!all.some((t) => t.id === 10), 'pull requests never appear as tickets');
});

test('issues: a failing linked-PR lookup degrades to hasLinkedPR=false, not an error', async () => {
  const http = scriptedHttp([
    { match: 'GET https://api.github.com/user', data: { login: 'alice' } },
    { match: /search\/issues/, data: { items: [ghIssue()] } },
    { match: 'POST https://api.github.com/graphql', status: 403, data: { message: 'Resource not accessible by personal access token' } },
  ]);
  const client = new GitHubClient('tok', 'https://github.com/acme', { http });
  const bugs = await client.getOpenBugs();
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].hasLinkedPR, false);
});

test('getWorkItemDetails takes the normalised item and returns a markdown body', async () => {
  const http = scriptedHttp([
    { match: 'GET https://api.github.com/repos/acme/widgets/issues/7', data: ghIssue({ body: '## Steps\n1. launch' }) },
  ]);
  const client = new GitHubClient('tok', 'https://github.com/acme', { http });
  const d = await client.getWorkItemDetails({ id: 7, project: 'acme', repo: 'widgets' });
  assert.equal(d.type, 'Bug');
  assert.equal(d.description, '## Steps\n1. launch');
  assert.equal(d.bodyFormat, 'markdown');
  assert.equal(d.tags, 'bug; P1');
  assert.equal(d.priority, 1);
});

test('getPrThreads: GraphQL resolved state maps to status 2, PR-level comments are appended', async () => {
  const http = scriptedHttp([
    { match: 'POST https://api.github.com/graphql', data: { data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { id: 'T1', isResolved: true, isOutdated: false, path: 'a.js', comments: { nodes: [{ body: 'nit', createdAt: '2026-10-01T00:00:00Z', author: { login: 'bob' } }] } },
      { id: 'T2', isResolved: false, isOutdated: false, path: 'b.js', comments: { nodes: [{ body: 'bug here', createdAt: '2026-10-01T00:00:00Z', author: { login: 'bob' } }] } },
    ] } } } } } },
    { match: 'GET https://api.github.com/repos/acme/widgets/issues/42/comments', data: [{ id: 99, body: 'overall fine', user: { login: 'carol' }, created_at: '2026-10-02T00:00:00Z' }] },
  ]);
  const client = new GitHubClient('tok', 'https://github.com/acme', { http });
  const threads = await client.getPrThreads('acme', 'acme/widgets', 42);
  assert.deepEqual(threads.map((t) => [t.id, t.status]), [['T1', 2], ['T2', 1], [99, 1]]);
  assert.equal(threads[0].comments[0].commentType, 1);
});

test('getPrThreads: falls back to flat review comments when GraphQL is unavailable', async () => {
  const http = scriptedHttp([
    { match: 'POST https://api.github.com/graphql', status: 401, data: { message: 'Bad credentials' } },
    { match: 'GET https://api.github.com/repos/acme/widgets/pulls/42/comments', data: [
      { id: 1, body: 'root', user: { login: 'bob' }, created_at: '2026-10-01T00:00:00Z', path: 'a.js' },
      { id: 2, body: 'reply', in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-10-01T01:00:00Z', path: 'a.js' },
    ] },
    { match: 'GET https://api.github.com/repos/acme/widgets/issues/42/comments', data: [] },
  ]);
  const client = new GitHubClient('tok', 'https://github.com/acme', { http });
  const threads = await client.getPrThreads('acme', 'acme/widgets', 42);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].comments.length, 2);
});

test('errors carry the HTTP status so the caller can tell a bad token from a bad URL', async () => {
  const http = scriptedHttp([{ match: 'GET https://api.github.com/user', status: 401, data: { message: 'Bad credentials' } }]);
  const client = new GitHubClient('bad', 'https://github.com', { http });
  await assert.rejects(client.getMe(), (err) => err.status === 401 && /Bad credentials/.test(err.message));
});

test('downloadAttachment writes the body and reports the content type', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const http = scriptedHttp([{ match: 'GET https://github.com/user-attachments/assets/abc', data: bytes, headers: { 'content-type': 'image/png' } }]);
  const client = new GitHubClient('tok', 'https://github.com', { http });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-test-'));
  const dest = path.join(dir, 'img.bin');
  const res = await client.downloadAttachment('https://github.com/user-attachments/assets/abc', dest);
  assert.equal(res.contentType, 'image/png');
  assert.equal(res.bytes, 4);
  assert.deepEqual(fs.readFileSync(dest), bytes);
  assert.deepEqual(client.attachmentHosts, ['github.com', 'githubusercontent.com', 'objects.githubusercontent.com']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getRepoFileTree lists blobs of the default branch', async () => {
  const http = scriptedHttp([
    { match: 'GET https://api.github.com/repos/acme/widgets/git/trees/develop?recursive=1', data: { tree: [{ path: 'README.md', type: 'blob' }, { path: 'src', type: 'tree' }, { path: 'src/a.js', type: 'blob' }] } },
    { match: 'GET https://api.github.com/repos/acme/widgets', data: { default_branch: 'develop' } },
  ]);
  const client = new GitHubClient('tok', 'https://github.com/acme', { http });
  assert.deepEqual(await client.getRepoFileTree('acme', 'widgets'), ['README.md', 'src/a.js']);
});

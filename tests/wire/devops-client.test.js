'use strict';
/**
 * The real DevOpsClient on the real azure-devops-node-api SDK against the
 * fake Azure DevOps server: route discovery, auth header, project filter,
 * mapping, sorting, status contract. Nothing here is mocked below the
 * HTTP layer.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DevOpsClient } = require('../../src/main/devops-client');
const { validatePat } = require('../../src/main/core/validate-pat');
const { startFakeAdo, adoPr, tempDir } = require('../helpers/fakes');

const servers = [];
async function ado(fixture) {
  const s = await startFakeAdo(fixture);
  servers.push(s);
  return s;
}
after(async () => { for (const s of servers) await s.close(); });

const silence = (name, fn) => async () => {
  const saved = console[name];
  console[name] = () => {};
  try { return await fn(); } finally { console[name] = saved; }
};

const FIXTURE = {
  projects: [{ id: 'p-alpha', name: 'Alpha' }, { id: 'p-beta', name: 'Beta' }],
  repos: {
    Alpha: [{ id: 'r-web', name: 'web' }, { id: 'r-api', name: 'api' }],
    Beta: [{ id: 'r-mob', name: 'mobile' }],
  },
  prs: {
    'r-web': [
      adoPr({ id: 1, title: 'older', repoId: 'r-web', repoName: 'web', project: 'Alpha', created: '2026-01-01T00:00:00Z', reviewers: [{ vote: 10 }] }),
      adoPr({ id: 2, title: 'newest', repoId: 'r-web', repoName: 'web', project: 'Alpha', created: '2026-03-01T00:00:00Z', reviewers: [{ vote: -10 }], description: '<p>Body</p>' }),
    ],
    'r-mob': [adoPr({ id: 3, title: 'middle', repoId: 'r-mob', repoName: 'mobile', project: 'Beta', created: '2026-02-01T00:00:00Z' })],
  },
  threads: {
    2: [
      { id: 11, status: 1, publishedDate: '2026-03-02T00:00:00Z', comments: [{ content: 'Rename this', commentType: 1, author: { displayName: 'Ada' } }] },
      { id: 12, status: 4, comments: [{ content: 'Ada voted 10', commentType: 2, author: { displayName: 'System' } }] },
    ],
  },
  policies: {
    1: [{ status: 2, configuration: { isEnabled: true, isBlocking: true } }],
  },
};

test('The_SDK_authenticates_every_call_with_Basic_PAT_and_discovers_routes_from_the_org_URL', async () => {
  const s = await ado(FIXTURE);
  const client = new DevOpsClient(s.pat, s.orgUrl);
  const me = await client.getMe();
  assert.deepEqual(me, { id: 'user-1', displayName: 'Test User', email: 'test@example.com' });
  const expected = `Basic ${Buffer.from(`PAT:${s.pat}`).toString('base64')}`;
  assert.deepEqual(s.authHeaders(), [expected]);
  assert.ok(s.paths().some((p) => p.startsWith('OPTIONS /_apis/Location')), 'route discovery happened');
  assert.ok(s.paths().some((p) => /GET \/_apis\/ConnectionData/i.test(p)));
});

test('Open_PRs_across_projects_come_back_newest_first_in_the_renderer_shape_with_review_and_policy_status', silence('error', async () => {
  const s = await ado(FIXTURE);
  const client = new DevOpsClient(s.pat, s.orgUrl);
  const prs = await client.getAllOpenPRs();
  assert.deepEqual(prs.map((p) => p.id), [2, 3, 1]);
  const one = prs.find((p) => p.id === 1);
  assert.equal(one.repo, 'web');
  assert.equal(one.project, 'Alpha');
  assert.equal(one.reviewStatus, 'approved');
  assert.equal(one.isApproved, true);
  assert.equal(one.createdDate, '2026-01-01T00:00:00.000Z');
  assert.equal(one.webUrl, `${s.orgUrl}/Alpha/_git/web/pullrequest/1`);
  assert.equal(prs.find((p) => p.id === 2).reviewStatus, 'rejected');
  assert.equal(prs.find((p) => p.id === 3).isApproved, false, 'no policy evaluations is not approved');
}));

test('A_project_in_the_org_URL_filters_the_scan_and_an_on_prem_collection_path_with_a_port_is_honoured', silence('error', async () => {
  const s = await ado({ ...FIXTURE, basePath: '/tfs/DefaultCollection' });
  const client = new DevOpsClient(s.pat, `${s.orgUrl}/Beta`);
  assert.equal(client.orgUrl, `${s.origin}/tfs/DefaultCollection`);
  assert.equal(client.projectFilter, 'Beta');
  const prs = await client.getAllOpenPRs();
  assert.deepEqual(prs.map((p) => p.id), [3]);
  assert.ok(s.paths().every((p) => p.includes('/tfs/DefaultCollection/')), `every call went to the collection path: ${s.paths()}`);
  assert.ok(!s.paths().some((p) => p.includes('/Alpha/')), 'the other project was never scanned');
}));

test('One_repo_that_fails_to_list_PRs_does_not_hide_the_PRs_of_the_others', silence('error', async () => {
  const s = await ado({
    ...FIXTURE,
    intercept: (req) => (/\/r-api\/pullRequests/i.test(req.url) ? { status: 500, body: { message: 'TF400898 internal' } } : undefined),
  });
  const prs = await new DevOpsClient(s.pat, s.orgUrl).getAllOpenPRs();
  assert.deepEqual(prs.map((p) => p.id), [2, 3, 1]);
}));

test('PR_threads_and_the_full_PR_body_map_to_the_shapes_the_prompt_builder_reads', async () => {
  const s = await ado(FIXTURE);
  const client = new DevOpsClient(s.pat, s.orgUrl);
  const threads = await client.getPrThreads('Alpha', 'r-web', 2);
  assert.deepEqual(threads, [
    { id: 11, status: 1, isDeleted: false, publishedDate: '2026-03-02T00:00:00.000Z', comments: [{ content: 'Rename this', author: 'Ada', commentType: 1 }] },
    { id: 12, status: 4, isDeleted: false, publishedDate: '', comments: [{ content: 'Ada voted 10', author: 'System', commentType: 2 }] },
  ]);
  const full = await client.getPullRequest('Alpha', 'r-web', 2);
  assert.deepEqual(full, { id: 2, title: 'newest', description: '<p>Body</p>', sourceBranch: 'refs/heads/feature', targetBranch: 'refs/heads/main', repoId: 'r-web' });
});

test('Attachments_are_downloaded_with_Basic_auth_and_the_content_type_is_reported', async () => {
  const s = await ado({ ...FIXTURE, attachments: { '/_apis/wit/attachments/9': { contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } } });
  const client = new DevOpsClient(s.pat, s.orgUrl);
  const dest = path.join(tempDir(), 'img.bin');
  const result = await client.downloadAttachment(`${s.orgUrl}/_apis/wit/attachments/9`, dest);
  assert.deepEqual(result, { contentType: 'image/png', bytes: 4 });
  assert.deepEqual([...fs.readFileSync(dest)], [0x89, 0x50, 0x4e, 0x47]);
  const raw = s.requests.find((r) => r.url.includes('/attachments/9'));
  assert.equal(raw.headers.authorization, `Basic ${Buffer.from(`:${s.pat}`).toString('base64')}`);
});

// ── Status contract through validatePat (the validate-pat IPC body) ──

const validate = (s, pat = s.pat, orgUrl = s.orgUrl) => validatePat({ pat, orgUrl, createClient: (p, u) => new DevOpsClient(p, u), timeoutMs: 5000 });

test('A_working_PAT_validates_with_the_project_names_and_the_filter_note', async () => {
  const s = await ado(FIXTURE);
  assert.deepEqual(await validate(s), { success: true, projects: ['Alpha', 'Beta'], filterNote: '' });
  // A project segment is only recognised behind a known host or a collection
  // path, so the on-prem shape is the one that carries a filter here.
  const onPrem = await ado({ ...FIXTURE, basePath: '/tfs/Coll' });
  assert.deepEqual(await validate(onPrem, onPrem.pat, `${onPrem.orgUrl}/Alpha`), { success: true, projects: ['Alpha', 'Beta'], filterNote: ' Filtered to project "Alpha".' });
});

// Regression: the handler read `err.response.status` (axios); the SDK
// throws `err.statusCode`, so a 401 surfaced as the raw body text.
test('A_rejected_PAT_401_or_403_says_the_PAT_was_rejected', async () => {
  const s = await ado(FIXTURE);
  const wrong = await validate(s, 'not-the-pat');
  assert.equal(wrong.success, false);
  assert.match(wrong.error, /401 — PAT was rejected/);

  const forbidden = await ado({ ...FIXTURE, intercept: () => ({ status: 403, body: { message: 'forbidden' } }) });
  assert.match((await validate(forbidden)).error, /403 — PAT was rejected/);
});

// Regression: typed-rest-client turns a 404 into a null result, so the
// handler said "PAT valid but no projects found" for a wrong org URL.
test('A_404_from_a_wrong_org_URL_says_to_check_the_org_URL', async () => {
  const s = await ado({ ...FIXTURE, intercept: () => ({ status: 404, body: { message: 'Page not found' } }) });
  const result = await validate(s);
  assert.equal(result.success, false);
  assert.match(result.error, /Check the org URL|Check your org URL/);
  assert.ok(!/no projects found/.test(result.error));
});

test('A_sign_in_page_203_with_HTML_is_a_rejection_that_names_the_URL_and_the_PAT_not_a_crash', async () => {
  const s = await ado({ ...FIXTURE, intercept: () => ({ status: 203, raw: '<html><body>Sign in to Azure DevOps</body></html>' }) });
  const result = await validate(s);
  assert.equal(result.success, false);
  assert.match(result.error, /did not answer like Azure DevOps|sign-in page/);
});

test('An_org_with_a_valid_PAT_but_no_projects_is_told_so', async () => {
  const s = await ado({ ...FIXTURE, projects: [] });
  assert.deepEqual(await validate(s), { success: false, error: 'PAT valid but no projects found.' });
});

test('Garbage_in_the_org_URL_box_is_refused_before_any_network_call', async () => {
  const result = await validatePat({ pat: 'x', orgUrl: 'myorg', createClient: () => { throw new Error('must not be called'); } });
  assert.equal(result.success, false);
  assert.match(result.error, /is not a URL/);
});

test('A_server_that_never_answers_is_reported_as_a_timeout_naming_the_org', async () => {
  const s = await ado({ ...FIXTURE });
  s.setIntercept(() => new Promise(() => {})); // never responds
  const hanging = await startFakeAdo({});
  servers.push(hanging);
  hanging.setIntercept(() => ({ status: 200, body: {} }));
  const result = await validatePat({
    pat: 'x', orgUrl: s.orgUrl, timeoutMs: 100,
    createClient: () => ({ getProjects: () => new Promise(() => {}) }),
  });
  assert.equal(result.success, false);
  assert.match(result.error, /timed out after 100ms/);
});

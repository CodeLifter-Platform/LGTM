'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DevOpsClient } = require('../../src/main/devops-client');
const { applyPrFilter } = require('../../src/main/core/pr-filter');
const { describeValidationError } = require('../../src/main/core/validate-pat');

// A WebApi-shaped connection whose API clients are plain objects, so the
// mapping and sorting in DevOpsClient run without the SDK's HTTP layer.
function connectionWith(apis) {
  return {
    getCoreApi: async () => apis.core,
    getGitApi: async () => apis.git,
    getWorkItemTrackingApi: async () => apis.wit,
    getLocationsApi: async () => apis.loc,
    getPolicyApi: async () => apis.policy,
  };
}

const client = (apis, orgUrl = 'https://dev.azure.com/myorg') => new DevOpsClient('pat', orgUrl, { connection: connectionWith(apis) });

test('Review_status_is_rejected_over_waiting_over_approved_and_pending_when_nobody_voted', () => {
  const c = client({});
  assert.equal(c._reviewStatus({ reviewers: [{ vote: 10 }, { vote: -10 }, { vote: -5 }] }), 'rejected');
  assert.equal(c._reviewStatus({ reviewers: [{ vote: 10 }, { vote: -5 }] }), 'waiting');
  assert.equal(c._reviewStatus({ reviewers: [{ vote: 10 }, { vote: 5 }] }), 'approved');
  assert.equal(c._reviewStatus({ reviewers: [{ vote: 10 }, { vote: 0 }] }), 'pending');
  assert.equal(c._reviewStatus({ reviewers: [] }), 'pending');
  assert.equal(c._reviewStatus({}), 'pending');
});

test('A_PR_passes_policies_only_when_every_enabled_blocking_policy_is_approved_and_there_is_at_least_one', async () => {
  const evals = { current: [] };
  const c = client({ policy: { getPolicyEvaluations: async () => evals.current } });
  const Approved = 2;
  evals.current = [{ status: Approved, configuration: { isEnabled: true, isBlocking: true } }];
  assert.equal(await c._isPassingAllPolicies('p', 1), true);
  evals.current = [{ status: Approved, configuration: { isEnabled: true, isBlocking: true } }, { status: 1, configuration: { isEnabled: true, isBlocking: true } }];
  assert.equal(await c._isPassingAllPolicies('p', 1), false);
  evals.current = [{ status: 1, configuration: { isEnabled: false, isBlocking: true } }, { status: 1, configuration: { isBlocking: false } }, { status: Approved, configuration: {} }];
  assert.equal(await c._isPassingAllPolicies('p', 1), true, 'disabled and non-blocking policies are ignored');
  evals.current = [{ status: 1, configuration: { isEnabled: false } }];
  assert.equal(await c._isPassingAllPolicies('p', 1), false, 'no blocking policy at all is not a pass');
  evals.current = [];
  assert.equal(await c._isPassingAllPolicies('p', 1), false);
});

test('A_policy_lookup_that_throws_is_not_a_pass', async () => {
  const c = client({ policy: { getPolicyEvaluations: async () => { throw new Error('boom'); } } });
  const warn = console.error;
  console.error = () => {};
  try { assert.equal(await c._isPassingAllPolicies('p', 1), false); } finally { console.error = warn; }
});

test('Open_PRs_are_mapped_to_the_renderer_shape_sorted_newest_first_and_one_failing_repo_does_not_hide_the_others', async () => {
  const warn = console.error;
  console.error = () => {};
  try {
    const projects = [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }];
    const repos = { Alpha: [{ id: 'r1', name: 'web' }, { id: 'r2', name: 'api' }], Beta: [{ id: 'r3', name: 'mobile' }] };
    const prs = {
      r1: [{ pullRequestId: 1, title: 'old', creationDate: new Date('2026-01-01T00:00:00Z'), sourceRefName: 'refs/heads/a', targetRefName: 'refs/heads/main', createdBy: { displayName: 'Ada' }, reviewers: [{ vote: 10 }], url: 'u1' }],
      r3: [{ pullRequestId: 3, title: 'new', creationDate: '2026-03-01T00:00:00Z', sourceRefName: 'refs/heads/c', targetRefName: 'refs/heads/main', createdBy: null, reviewers: [], url: 'u3' }],
    };
    const c = client({
      core: { getProjects: async () => projects },
      git: {
        getRepositories: async (project) => repos[project],
        getPullRequests: async (repoId) => { if (repoId === 'r2') throw new Error('TF401019 repo gone'); return prs[repoId] || []; },
      },
      policy: { getPolicyEvaluations: async () => [{ status: 2, configuration: {} }] },
    });
    const list = await c.getAllOpenPRs();
    assert.deepEqual(list.map((p) => p.id), [3, 1]);
    assert.deepEqual(list[1], {
      id: 1, title: 'old', status: 'active', repo: 'web', project: 'Alpha', repoId: 'r1',
      sourceBranch: 'refs/heads/a', targetBranch: 'refs/heads/main', createdBy: 'Ada',
      createdDate: '2026-01-01T00:00:00.000Z', url: 'u1',
      webUrl: 'https://dev.azure.com/myorg/Alpha/_git/web/pullrequest/1',
      reviewStatus: 'approved', isApproved: true,
    });
    assert.equal(list[0].createdBy, '');
  } finally {
    console.error = warn;
  }
});

test('A_project_filter_in_the_org_URL_limits_the_scan_to_that_project_case_insensitively', async () => {
  const seen = [];
  const c = client({
    core: { getProjects: async () => [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }] },
    git: { getRepositories: async (project) => { seen.push(project); return []; } },
  }, 'https://dev.azure.com/myorg/beta');
  await c.getAllOpenPRs();
  assert.deepEqual(seen, ['Beta']);
});

test('Bugs_are_fetched_in_chunks_of_200_ids_flagged_with_PR_links_and_sorted_by_priority_then_newest', async () => {
  const chunks = [];
  const ids = Array.from({ length: 450 }, (_, i) => ({ id: i + 1 }));
  const c = client({
    core: { getProjects: async () => [{ id: 'p1', name: 'Alpha' }] },
    wit: {
      queryByWiql: async (q) => { assert.match(q.query, /\[System\.AssignedTo\] = @Me/); return { workItems: ids }; },
      getWorkItems: async (chunk) => {
        chunks.push(chunk.length);
        return chunk.map((id) => ({
          id,
          fields: {
            'System.Title': `b${id}`, 'System.State': 'Active', 'System.TeamProject': 'Alpha',
            'Microsoft.VSTS.Common.Priority': id === 450 ? 1 : (id === 1 ? undefined : 2),
            'System.CreatedDate': `2026-01-${String((id % 28) + 1).padStart(2, '0')}T00:00:00Z`,
          },
          relations: id === 2 ? [{ rel: 'ArtifactLink', attributes: { name: 'Pull Request' } }] : [],
        }));
      },
    },
  });
  const bugs = await c.getOpenBugs();
  assert.deepEqual(chunks, [200, 200, 50]);
  assert.equal(bugs.length, 450);
  assert.equal(bugs[0].id, 450, 'priority 1 first');
  assert.equal(bugs.at(-1).id, 1, 'no priority sorts last');
  assert.equal(bugs.find((b) => b.id === 2).hasLinkedPR, true);
  assert.equal(bugs.find((b) => b.id === 3).hasLinkedPR, false);
  assert.equal(bugs[0].webUrl, 'https://dev.azure.com/myorg/Alpha/_workitems/edit/450');
});

test('The_all_scope_asks_for_any_assignee_and_a_project_that_refuses_the_query_is_skipped', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const c = client({
      core: { getProjects: async () => [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }] },
      wit: {
        queryByWiql: async (q, ctx) => {
          assert.match(q.query, /\[System\.AssignedTo\] <> ''/);
          if (ctx.project === 'Beta') throw new Error('TF51005 no Bug type');
          return { workItems: [{ id: 1 }] };
        },
        getWorkItems: async (chunk) => chunk.map((id) => ({ id, fields: { 'System.Title': 't' } })),
      },
    });
    const bugs = await c.getOpenBugs({ assignedToMeOnly: false });
    assert.deepEqual(bugs.map((b) => b.id), [1]);
  } finally {
    console.warn = warn;
  }
});

test('The_PR_linkage_filter_keeps_items_with_or_without_a_linked_PR_as_asked', () => {
  const items = [{ id: 1, hasLinkedPR: true }, { id: 2, hasLinkedPR: false }, { id: 3 }];
  assert.deepEqual(applyPrFilter(items, 'has').map((i) => i.id), [1]);
  assert.deepEqual(applyPrFilter(items, 'none').map((i) => i.id), [2, 3]);
  assert.deepEqual(applyPrFilter(items, 'all'), items);
  assert.deepEqual(applyPrFilter(null, 'has'), []);
});

test('Every_way_validation_can_fail_maps_to_a_sentence_naming_what_to_check', () => {
  const org = 'https://dev.azure.com/myorg';
  assert.match(describeValidationError({ statusCode: 401 }, org), /401 — PAT was rejected/);
  assert.match(describeValidationError({ response: { status: 403 } }, org), /403 — PAT was rejected/);
  assert.match(describeValidationError({ statusCode: 404 }, org), /https:\/\/dev\.azure\.com\/myorg\/_apis\/projects failed\. Check your org URL/);
  assert.match(describeValidationError({ statusCode: 203 }, org), /sign-in page/);
  assert.match(describeValidationError(new Error('Failed to find api location for area: core id: x'), org), /did not answer like Azure DevOps/);
  assert.match(describeValidationError(new Error('getProjects timed out after 20000ms'), org), /did not answer in time/);
  assert.equal(describeValidationError(new Error('ECONNRESET'), org), 'ECONNRESET');
});

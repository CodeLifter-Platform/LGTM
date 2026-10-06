const test = require('node:test');
const assert = require('node:assert/strict');
const { DevOpsClient } = require('../src/main/devops-client');

test('parseOrgUrl: dev.azure.com, visualstudio.com, on-prem, and junk', () => {
  assert.deepEqual(DevOpsClient.parseOrgUrl('https://dev.azure.com/acme'), { orgUrl: 'https://dev.azure.com/acme', project: null });
  assert.deepEqual(DevOpsClient.parseOrgUrl('https://dev.azure.com/acme/Proj/'), { orgUrl: 'https://dev.azure.com/acme', project: 'Proj' });
  assert.deepEqual(DevOpsClient.parseOrgUrl('https://acme.visualstudio.com'), { orgUrl: 'https://acme.visualstudio.com', project: null });
  assert.deepEqual(DevOpsClient.parseOrgUrl('https://acme.visualstudio.com/Proj/_git/repo'), { orgUrl: 'https://acme.visualstudio.com', project: 'Proj' });
  assert.deepEqual(DevOpsClient.parseOrgUrl('https://tfs.corp/DefaultCollection/Proj'), { orgUrl: 'https://tfs.corp/DefaultCollection', project: 'Proj' });
  assert.deepEqual(DevOpsClient.parseOrgUrl('not a url'), { orgUrl: 'not a url', project: null });
});

test('_reviewStatus maps reviewer votes: reject beats wait beats approved beats pending', () => {
  const c = Object.create(DevOpsClient.prototype);
  assert.equal(c._reviewStatus({ reviewers: [] }), 'pending');
  assert.equal(c._reviewStatus({ reviewers: [{ vote: 10 }, { vote: 5 }] }), 'approved');
  assert.equal(c._reviewStatus({ reviewers: [{ vote: 10 }, { vote: 0 }] }), 'pending');
  assert.equal(c._reviewStatus({ reviewers: [{ vote: 10 }, { vote: -5 }] }), 'waiting');
  assert.equal(c._reviewStatus({ reviewers: [{ vote: -5 }, { vote: -10 }] }), 'rejected');
});

test('_hasLinkedPullRequest only counts Pull Request artifact links', () => {
  assert.equal(DevOpsClient._hasLinkedPullRequest({ relations: [{ rel: 'ArtifactLink', attributes: { name: 'Pull Request' } }] }), true);
  assert.equal(DevOpsClient._hasLinkedPullRequest({ relations: [{ rel: 'ArtifactLink', attributes: { name: 'Branch' } }] }), false);
  assert.equal(DevOpsClient._hasLinkedPullRequest({ relations: [{ rel: 'System.LinkTypes.Hierarchy-Forward' }] }), false);
  assert.equal(DevOpsClient._hasLinkedPullRequest({}), false, 'no relations expanded means false, never a throw');
});

test('orgHost is derived from the parsed org URL', () => {
  const c = new DevOpsClient('pat', 'https://dev.azure.com/acme/Proj');
  assert.equal(c.orgHost, 'dev.azure.com');
  assert.equal(c.projectFilter, 'Proj');
});

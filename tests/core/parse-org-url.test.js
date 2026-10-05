'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOrgUrl } = require('../../src/main/core/org-url');
const { DevOpsClient } = require('../../src/main/devops-client');

// One fixture per real-world shape a user pastes into the org URL box.
const CASES = [
  ['https://dev.azure.com/myorg', 'https://dev.azure.com/myorg', null],
  ['https://dev.azure.com/myorg/', 'https://dev.azure.com/myorg', null],
  ['https://dev.azure.com/myorg/MyProject', 'https://dev.azure.com/myorg', 'MyProject'],
  ['https://dev.azure.com/myorg/My%20Project/_git/repo', 'https://dev.azure.com/myorg', 'My Project'],
  ['https://dev.azure.com/myorg/MyProject/_git/repo/pullrequest/12', 'https://dev.azure.com/myorg', 'MyProject'],
  ['https://myorg.visualstudio.com', 'https://myorg.visualstudio.com', null],
  ['https://myorg.visualstudio.com/MyProject', 'https://myorg.visualstudio.com', 'MyProject'],
  ['https://myorg.visualstudio.com/MyProject/_git/repo', 'https://myorg.visualstudio.com', 'MyProject'],
  ['https://ado.corp.example/DefaultCollection', 'https://ado.corp.example/DefaultCollection', null],
  ['https://ado.corp.example/DefaultCollection/Proj', 'https://ado.corp.example/DefaultCollection', 'Proj'],
  ['https://ado.corp.example/DefaultCollection/Proj/_git/repo', 'https://ado.corp.example/DefaultCollection', 'Proj'],
  ['http://127.0.0.1:9999', 'http://127.0.0.1:9999', null],
];

for (const [input, orgUrl, project] of CASES) {
  test(`parses ${input}`, () => {
    assert.deepEqual(parseOrgUrl(input), { orgUrl, project });
  });
}

// Regression: `hostname` dropped the port, so an on-prem server on :8080
// was contacted on :80, and the `tfs` virtual directory was mistaken for
// the collection, making "DefaultCollection" the project filter.
test('On_prem_URL_with_a_port_and_the_tfs_virtual_directory_keeps_both_and_takes_the_third_segment_as_the_project', () => {
  assert.deepEqual(
    parseOrgUrl('http://tfs.corp:8080/tfs/DefaultCollection/Proj'),
    { orgUrl: 'http://tfs.corp:8080/tfs/DefaultCollection', project: 'Proj' },
  );
  assert.deepEqual(
    parseOrgUrl('http://tfs.corp:8080/tfs/DefaultCollection'),
    { orgUrl: 'http://tfs.corp:8080/tfs/DefaultCollection', project: null },
  );
});

test('Garbage_that_is_not_a_URL_comes_back_as_typed_with_no_project', () => {
  assert.deepEqual(parseOrgUrl('not a url'), { orgUrl: 'not a url', project: null });
  assert.deepEqual(parseOrgUrl(''), { orgUrl: '', project: null });
  assert.deepEqual(parseOrgUrl(undefined), { orgUrl: '', project: null });
});

test('Surrounding_whitespace_and_trailing_slashes_are_ignored', () => {
  assert.deepEqual(parseOrgUrl('  https://dev.azure.com/myorg/Proj///  '), { orgUrl: 'https://dev.azure.com/myorg', project: 'Proj' });
});

test('DevOpsClient_parseOrgUrl_is_the_same_function', () => {
  assert.deepEqual(DevOpsClient.parseOrgUrl('http://tfs.corp:8080/tfs/Coll/P'), parseOrgUrl('http://tfs.corp:8080/tfs/Coll/P'));
});

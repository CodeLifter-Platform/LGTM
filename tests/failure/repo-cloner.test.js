'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RepoCloner } = require('../../src/main/repo-cloner');
const { hasGit, makeBareRepo, tempDir } = require('../helpers/fakes');

// git is a runtime dependency of the app itself; a machine without it
// cannot run these, and says so instead of passing.
const gitless = hasGit() ? false : 'git is not installed on this machine';
const quiet = () => {};
const PAT = 'secret-pat-value';

const PR = (branch = 'feature/x') => ({ project: 'Alpha', repo: 'web', id: 7, sourceBranch: `refs/heads/${branch}`, targetBranch: 'refs/heads/main' });

function clonerFor(repo, extra = {}) {
  return new RepoCloner(PAT, 'https://dev.azure.com/o', { cloneUrlFor: () => repo.url, tmpDir: tempDir('lgtm-clones-'), log: quiet, ...extra });
}

test('A_PR_clone_checks_out_the_source_branch_fetches_the_target_branch_and_cleanup_removes_the_directory', { skip: gitless }, async () => {
  const repo = makeBareRepo();
  try {
    const cloner = clonerFor(repo);
    const { clonePath, cleanup } = await cloner.clone(PR());
    assert.ok(fs.existsSync(path.join(clonePath, 'feature.txt')), 'source branch is checked out');
    assert.ok(fs.existsSync(path.join(clonePath, '.lgtm', 'review-prompt.md')));
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: clonePath, encoding: 'utf8' }).trim();
    assert.equal(branch, 'feature/x');
    execFileSync('git', ['rev-parse', '--verify', 'main'], { cwd: clonePath, stdio: 'ignore' });
    cleanup();
    assert.equal(fs.existsSync(clonePath), false);
    cleanup(); // idempotent
  } finally { repo.remove(); }
});

test('A_default_branch_clone_for_a_work_item_lands_on_main', { skip: gitless }, async () => {
  const repo = makeBareRepo();
  try {
    const { clonePath, cleanup } = await clonerFor(repo).cloneRepo('Alpha', 'web', 42);
    assert.ok(fs.existsSync(path.join(clonePath, 'README.md')));
    assert.equal(fs.existsSync(path.join(clonePath, 'feature.txt')), false);
    assert.match(path.basename(clonePath), /^lgtm-wi-Alpha-web-42-/);
    cleanup();
  } finally { repo.remove(); }
});

test('A_missing_source_branch_rejects_with_the_branch_named_and_leaves_no_directory_behind', { skip: gitless }, async () => {
  const repo = makeBareRepo();
  try {
    const cloner = clonerFor(repo);
    await assert.rejects(cloner.clone(PR('does-not-exist')), /Clone failed: git clone exited with code \d+: [\s\S]*does-not-exist/);
    assert.deepEqual(fs.readdirSync(cloner.tmpDir), []);
  } finally { repo.remove(); }
});

test('A_clone_that_exceeds_its_timeout_is_killed_and_rejected_as_a_timeout', { skip: gitless }, async () => {
  const repo = makeBareRepo();
  try {
    const cloner = clonerFor(repo, { cloneTimeoutMs: 1 });
    await assert.rejects(cloner.clone(PR()), /git clone timed out after 1ms/);
    assert.deepEqual(fs.readdirSync(cloner.tmpDir), []);
  } finally { repo.remove(); }
});

test('Killing_the_git_child_handed_to_onChild_aborts_the_clone_and_cleans_up', { skip: gitless }, async () => {
  const repo = makeBareRepo();
  try {
    const cloner = clonerFor(repo);
    let seen = 0;
    await assert.rejects(cloner.clone(PR(), { onChild: (c) => { seen += 1; c.kill('SIGKILL'); } }), /killed by SIGKILL|exited with code/);
    assert.equal(seen, 1);
    assert.deepEqual(fs.readdirSync(cloner.tmpDir), []);
  } finally { repo.remove(); }
});

test('The_PAT_is_embedded_in_the_clone_URL_with_the_port_and_collection_kept_but_never_appears_in_an_error', { skip: gitless }, async () => {
  const onPrem = new RepoCloner(PAT, 'http://tfs.corp:8080/tfs/Coll/', { log: quiet });
  assert.equal(onPrem._buildCloneUrlFromParts('My Proj', 'web'), `http://pat:${PAT}@tfs.corp:8080/tfs/Coll/My%20Proj/_git/web`);
  const cloud = new RepoCloner(PAT, 'https://dev.azure.com/o', { log: quiet });
  assert.equal(cloud._buildCloneUrl({ project: 'A', repo: 'r' }), `https://pat:${PAT}@dev.azure.com/o/A/_git/r`);

  // A port nothing listens on: git fails instantly with the URL in its message.
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  const cloner = new RepoCloner(PAT, `http://127.0.0.1:${port}`, { tmpDir: tempDir('lgtm-clones-'), log: quiet, cloneTimeoutMs: 20000 });
  let message = '';
  try { await cloner.clone(PR()); } catch (err) { message = err.message; }
  assert.match(message, /^Clone failed: /);
  assert.ok(!message.includes(PAT), `PAT leaked into: ${message}`);
  assert.equal(cloner._redact(`url http://pat:${PAT}@h/x and ${PAT}`), 'url http://pat:***@h/x and ***');
});

test('Cleanup_removes_a_directory_whose_name_carries_shell_characters_and_leaves_its_neighbours_alone', () => {
  const root = tempDir('lgtm-clean-');
  const victim = path.join(root, 'lgtm-review-A-r"$(touch pwned)`-1');
  const neighbour = path.join(root, 'keep');
  fs.mkdirSync(victim);
  fs.mkdirSync(neighbour);
  fs.writeFileSync(path.join(victim, 'f.txt'), 'x');
  const cloner = new RepoCloner('p', 'https://dev.azure.com/o', { log: quiet });
  cloner._cleanup(victim);
  assert.equal(fs.existsSync(victim), false);
  assert.equal(fs.existsSync(neighbour), true);
  assert.equal(fs.existsSync(path.join(root, 'pwned')), false);
  cloner._cleanup(path.join(root, 'never-existed')); // no throw
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PromptResolver } = require('../../src/main/prompt-resolver');
const { MemoryStore, tempDir } = require('../helpers/fakes');

const pr = { project: 'Alpha', repo: 'web' };
const quiet = () => {};

function cloneWith(files) {
  const dir = tempDir('lgtm-clone-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('A_configured_custom_path_wins_when_the_file_exists', () => {
  const custom = path.join(tempDir(), 'custom.md');
  fs.writeFileSync(custom, 'custom');
  const config = new MemoryStore({ repoConfigs: { 'Alpha/web': { mode: 'custom', customPath: custom } } });
  const resolver = new PromptResolver(config);
  const clone = cloneWith({ '.lgtm/review-prompt.md': 'convention' });
  assert.deepEqual(resolver.resolve(pr, clone), { path: custom, source: 'custom' });
});

test('A_configured_custom_path_that_no_longer_exists_falls_through_to_the_convention_file', () => {
  const config = new MemoryStore({ repoConfigs: { 'Alpha/web': { mode: 'custom', customPath: '/nowhere/custom.md' } } });
  const resolver = new PromptResolver(config);
  const clone = cloneWith({ 'PR_REVIEW_PROMPT.md': 'convention' });
  assert.deepEqual(resolver.resolve(pr, clone), { path: path.join(clone, 'PR_REVIEW_PROMPT.md'), source: 'discovered' });
});

test('A_repo_file_configured_per_repo_is_read_from_the_clone', () => {
  const config = new MemoryStore({ repoConfigs: { 'Alpha/web': { mode: 'repo', repoFile: 'docs/review.md' } } });
  const resolver = new PromptResolver(config);
  const clone = cloneWith({ 'docs/review.md': 'repo', '.lgtm/review-prompt.md': 'convention' });
  assert.deepEqual(resolver.resolve(pr, clone), { path: path.join(clone, 'docs/review.md'), source: 'repo-configured' });
});

test('Convention_files_are_searched_in_the_documented_order', () => {
  const resolver = new PromptResolver(new MemoryStore({}));
  const clone = cloneWith({ '.github/pr-review-prompt.md': 'b', 'PR_REVIEW_PROMPT.md': 'c', 'NYLE_PR_PROMPT.md': 'd' });
  assert.equal(resolver.resolve(pr, clone).path, path.join(clone, '.github/pr-review-prompt.md'));
  assert.deepEqual(PromptResolver.getConventionPaths(), ['.lgtm/review-prompt.md', '.github/pr-review-prompt.md', 'PR_REVIEW_PROMPT.md', 'NYLE_PR_PROMPT.md']);
});

test('With_nothing_in_the_clone_the_global_prompt_path_is_used_then_the_bundled_template', () => {
  const globalPrompt = path.join(tempDir(), 'global.md');
  fs.writeFileSync(globalPrompt, 'global');
  const clone = cloneWith({});
  assert.deepEqual(new PromptResolver(new MemoryStore({ promptPath: globalPrompt })).resolve(pr, clone), { path: globalPrompt, source: 'global-custom' });

  const bundled = new PromptResolver(new MemoryStore({ promptPath: '/nowhere.md' })).resolve(pr, clone);
  assert.equal(bundled.source, 'bundled');
  assert.ok(bundled.path.endsWith(path.join('resources', 'REPO_REVIEW_TEMPLATE.md')));
  assert.ok(fs.existsSync(bundled.path));
});

test('Without_a_clone_only_custom_and_global_sources_apply', () => {
  const config = new MemoryStore({ repoConfigs: { 'Alpha/web': { mode: 'repo', repoFile: 'docs/review.md' } } });
  const r = new PromptResolver(config).resolve(pr, null);
  assert.equal(r.source, 'bundled');
});

void quiet;

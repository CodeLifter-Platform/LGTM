'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../../src/renderer/logic');

const {
  escHtml, renderMarkdownToHtml, isTerminalStatus, isActiveStatus,
  resolvePrMode, cyclePrMode, actionModeFor, buildAutoReviewQueue, sortRepoKeys, prAgeDays,
} = logic;

test('Agent_output_containing_markup_is_shown_as_text_never_executed', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script> & done';
  assert.equal(escHtml(evil), '&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt; &amp; done');
  const html = renderMarkdownToHtml('# Title <b>\n**bold** `code` ```js\nlet x = "<i>";\n```');
  assert.ok(!html.includes('<b>'), 'raw tags are escaped');
  assert.ok(!html.includes('<i>'), 'tags inside code fences are escaped');
  assert.ok(html.includes('<h2>Title &lt;b&gt;</h2>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<pre><code class="lang-js">let x = &quot;'.replace('&quot;', '"') + '&lt;i&gt;";'));
  assert.equal(escHtml(null), '');
});

// Regression: 'cancelled' was missing from the terminal set, so an
// auto-review run whose current review was cancelled waited forever.
test('Completed_failed_and_cancelled_are_terminal_and_running_and_cloning_are_active', () => {
  for (const s of ['completed', 'failed', 'cancelled']) assert.equal(isTerminalStatus(s), true, s);
  for (const s of ['running', 'cloning', undefined, null, 'queued']) assert.equal(isTerminalStatus(s), false, String(s));
  assert.equal(isActiveStatus('running'), true);
  assert.equal(isActiveStatus('cloning'), true);
  assert.equal(isActiveStatus('completed'), false);
});

const me = { displayName: 'Ada', id: 'a' };
const mine = { project: 'P', repo: 'r', id: 1, createdBy: 'Ada', isApproved: false };
const theirs = { project: 'P', repo: 'r', id: 2, createdBy: 'Bob', isApproved: false };
const approved = { project: 'P', repo: 'r', id: 3, createdBy: 'Bob', isApproved: true };

test('My_own_PR_defaults_to_resolve_someone_elses_to_review_and_an_approved_PR_shows_approved', () => {
  assert.equal(resolvePrMode(mine, {}, me), 'resolve');
  assert.equal(resolvePrMode(theirs, {}, me), 'review');
  assert.equal(resolvePrMode(mine, {}, null), 'review', 'unknown user: nothing is mine');
  assert.equal(resolvePrMode(approved, {}, me), 'approved');
  assert.equal(resolvePrMode(theirs, { 'P/r/2': 'resolve' }, me), 'resolve', 'an override wins');
});

test('Clicking_the_chip_cycles_approved_to_review_to_resolve_and_back_by_clearing_the_override_and_toggles_otherwise', () => {
  let o = {};
  o = cyclePrMode(approved, o, me); assert.equal(resolvePrMode(approved, o, me), 'review');
  o = cyclePrMode(approved, o, me); assert.equal(resolvePrMode(approved, o, me), 'resolve');
  o = cyclePrMode(approved, o, me); assert.equal(resolvePrMode(approved, o, me), 'approved');
  assert.deepEqual(o, {}, 'back to approved means no override stored');

  let t = {};
  t = cyclePrMode(theirs, t, me); assert.equal(resolvePrMode(theirs, t, me), 'resolve');
  t = cyclePrMode(theirs, t, me); assert.equal(resolvePrMode(theirs, t, me), 'review');
  const original = { 'P/r/9': 'review' };
  cyclePrMode(theirs, original, me);
  assert.deepEqual(original, { 'P/r/9': 'review' }, 'the input map is not mutated');
});

test('Pressing_play_on_an_approved_PR_falls_back_to_the_author_based_action', () => {
  assert.equal(actionModeFor(approved, {}, me), 'review');
  assert.equal(actionModeFor({ ...approved, createdBy: 'Ada' }, {}, me), 'resolve');
  assert.equal(actionModeFor(approved, { 'P/r/3': 'resolve' }, me), 'resolve');
});

test('The_auto_review_queue_skips_old_PRs_and_active_or_completed_ones_retries_failed_and_cancelled_and_puts_starred_repos_first', () => {
  const now = Date.parse('2026-03-10T00:00:00Z');
  const day = (n) => new Date(now - n * 86400000).toISOString();
  const prs = [
    { project: 'P', repo: 'zeta', id: 1, createdDate: day(1) },
    { project: 'P', repo: 'alpha', id: 2, createdDate: day(2) },
    { project: 'P', repo: 'star', id: 3, createdDate: day(3) },
    { project: 'P', repo: 'alpha', id: 4, createdDate: day(30) },       // too old
    { project: 'P', repo: 'alpha', id: 5 },                             // undated: kept
    { project: 'P', repo: 'alpha', id: 6, createdDate: day(1) },        // running
    { project: 'P', repo: 'alpha', id: 7, createdDate: day(1) },        // completed
    { project: 'P', repo: 'alpha', id: 8, createdDate: day(1) },        // failed → retry
    { project: 'P', repo: 'alpha', id: 9, createdDate: day(1) },        // cancelled → retry
    { project: 'P', repo: 'alpha', id: 10, createdDate: day(1) },       // cloning
  ];
  const reviewStatuses = {
    'P/alpha/6': { status: 'running' }, 'P/alpha/7': { status: 'completed' },
    'P/alpha/8': { status: 'failed' }, 'P/alpha/9': { status: 'cancelled' }, 'P/alpha/10': { status: 'cloning' },
  };
  const queue = buildAutoReviewQueue(prs, { starredRepos: new Set(['P/star']), maxPrAgeDays: 7, reviewStatuses, now });
  assert.deepEqual(queue.map((p) => p.id), [3, 2, 5, 8, 9, 1]);
  assert.deepEqual(buildAutoReviewQueue([], { starredRepos: new Set(), maxPrAgeDays: 7, reviewStatuses: {}, now }), []);
});

test('Repo_groups_sort_starred_first_then_alphabetically_and_PR_age_is_whole_days', () => {
  assert.deepEqual(sortRepoKeys(['P/zeta', 'P/alpha', 'P/star'], new Set(['P/star'])), ['P/star', 'P/alpha', 'P/zeta']);
  const now = Date.parse('2026-03-10T12:00:00Z');
  assert.equal(prAgeDays({ createdDate: '2026-03-10T01:00:00Z' }, now), 0);
  assert.equal(prAgeDays({ createdDate: '2026-03-08T13:00:00Z' }, now), 1);
  assert.equal(prAgeDays({}, now), 0);
});

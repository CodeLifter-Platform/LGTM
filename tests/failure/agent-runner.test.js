'use strict';
/**
 * AgentRunner driven in a plain Node process: a fake cloner, a fake
 * DevOps client, the real scenario prompts, and the fake agent fixture
 * spawned as a real child process. Every failure path the user can hit
 * ends in a status they can see and a message they can act on.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AgentRunner } = require('../../src/main/agent-runner');
const { MemoryStore, collectNotify, fakeRegistry, realScenarioPrompts, tempDir, fakeConnection } = require('../helpers/fakes');

const scenarioPrompts = realScenarioPrompts();
const PR = { project: 'Alpha', repo: 'web', id: 7, title: 'T', repoId: 'r1', sourceBranch: 'refs/heads/feature/x', targetBranch: 'refs/heads/main', webUrl: 'https://u/7', createdBy: 'Ada', createdDate: '2026-01-01T00:00:00Z' };
const KEY = 'Alpha/web/7';

function fakeCloner({ cleanups } = {}) {
  return {
    pat: 'secret-pat',
    cloned: [],
    async clone(pr, { onChild } = {}) {
      const clonePath = tempDir('lgtm-fake-clone-');
      this.cloned.push(clonePath);
      if (onChild) onChild(null);
      const cleanup = () => { if (cleanups) cleanups.push(clonePath); fs.rmSync(clonePath, { recursive: true, force: true }); };
      return { clonePath, cleanup };
    },
  };
}

const fakeDevops = () => ({
  orgHost: 'dev.azure.com',
  async getPullRequest() { return { description: '<p>Please review</p>' }; },
  async getPrThreads() { return []; },
  async downloadAttachment() { throw new Error('no attachments in this test'); },
});

function runner({ mode = 'ok', registry, cloner, killGraceMs = 300, ...deps } = {}) {
  const notify = collectNotify();
  const theCloner = cloner || fakeCloner(deps);
  const r = new AgentRunner(new MemoryStore({ repoConfigs: {}, promptPath: '' }), {
    notify,
    registry: registry || fakeRegistry({ mode }),
    scenarioPrompts,
    promptResolver: { resolve: () => ({ path: null, source: 'none' }) },
    createCloner: () => theCloner,
    cleanupDelayMs: 0,
    killGraceMs,
    ...deps,
  });
  r.setConnection(fakeConnection({ token: 'secret-pat', client: fakeDevops() }));
  r.setIdentity('azure-devops', { displayName: 'Rev', id: 'rev-1' });
  const saveLog = console.log; console.log = () => {};
  const saveWarn = console.warn; console.warn = () => {};
  r.restoreConsole = () => { console.log = saveLog; console.warn = saveWarn; };
  return { runner: r, notify, cloner: theCloner };
}

test('An_agent_binary_that_does_not_exist_fails_the_review_with_an_actionable_message_and_cleans_the_clone', async () => {
  const cleanups = [];
  const { runner: r, notify, cloner } = runner({ registry: fakeRegistry({ command: '/nonexistent/agent-bin' }), cleanups });
  try {
    const started = await r.startReview(PR, 'claude', null, 'review');
    assert.deepEqual(started, { success: true });
    await notify.waitForStatus(KEY, 'failed');
    const detail = r.getReviewDetail(KEY);
    assert.match(detail.output, /Failed to spawn claude: spawn \/nonexistent\/agent-bin ENOENT \(is "\/nonexistent\/agent-bin" on your PATH\?\)/);
    assert.deepEqual(detail.timeline.map((t) => t.status), ['cloning', 'running', 'failed']);
    assert.deepEqual(cleanups, cloner.cloned);
    assert.equal(fs.existsSync(cloner.cloned[0]), false);
  } finally { r.restoreConsole(); }
});

test('A_non_zero_exit_marks_the_review_failed_and_keeps_the_agent_stderr_for_the_user', async () => {
  const { runner: r, notify } = runner({ mode: 'fail' });
  try {
    await r.startReview(PR, 'claude', null, 'review');
    await notify.waitForStatus(KEY, 'failed');
    const detail = r.getReviewDetail(KEY);
    assert.match(detail.output, /simulated crash: API key missing/);
    assert.match(detail.output, /claude finished — exit code 3/);
    assert.equal(detail.reportStatus, 'report_unparseable');
    assert.ok(detail.finishedAt >= detail.startedAt);
  } finally { r.restoreConsole(); }
});

test('An_agent_that_exits_cleanly_without_a_JSON_report_is_completed_but_flagged_report_unparseable_with_the_raw_log_kept', async () => {
  const { runner: r, notify } = runner({ mode: 'garbage' });
  try {
    await r.startReview(PR, 'claude', null, 'review');
    const final = await notify.waitForStatus(KEY, 'completed');
    assert.equal(final.reportStatus, 'report_unparseable');
    assert.match(final.reportError, /no JSON block/);
    assert.equal(final.report, null);
    assert.match(r.getReviewOutput(KEY), /No JSON for you/);
  } finally { r.restoreConsole(); }
});

test('A_clean_run_parses_the_final_report_and_the_dispatched_prompt_carries_the_PR_context_and_identity', async () => {
  const { runner: r, notify } = runner({ mode: 'ok' });
  try {
    await r.startReview(PR, 'claude', 'claude-opus-4-6', 'review');
    const final = await notify.waitForStatus(KEY, 'completed');
    assert.equal(final.reportStatus, 'parsed');
    assert.deepEqual(final.report, { pr_id: 7, comments_posted: 1, summary: 'fake review' });
    const detail = r.getReviewDetail(KEY);
    assert.match(detail.prompt, /^PR_ID: 7$/m);
    assert.match(detail.prompt, /^REVIEWER_IDENTITY: Rev \(rev-1\)$/m);
    assert.match(detail.prompt, /^SOURCE_BRANCH: feature\/x$/m);
    assert.match(detail.prompt, /## PR Description\nPlease review/);
    assert.match(detail.output, /\[LGTM\] Launching claude \(model: claude-opus-4-6\)/);
    assert.match(detail.output, /prompt: [\d,]+ chars via stdin/);
    assert.deepEqual(detail.timeline.map((t) => t.status), ['cloning', 'running', 'completed']);
    const snapshot = r.getActiveReviews()[KEY];
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.outputLength, detail.output.length);
  } finally { r.restoreConsole(); }
});

test('Cancelling_while_the_clone_is_in_flight_kills_the_git_child_and_lands_in_cancelled_without_spawning_the_agent', async () => {
  const gitChild = { exitCode: null, killed: false, signals: [], kill(sig) { this.signals.push(sig); this.killed = true; this.reject(new Error(`git clone killed by ${sig}`)); } };
  const cloner = {
    pat: 'p',
    async clone(pr, { onChild }) {
      return new Promise((_, reject) => { gitChild.reject = reject; onChild(gitChild); });
    },
  };
  const { runner: r, notify } = runner({ cloner });
  try {
    const pending = r.startReview(PR, 'claude', null, 'review');
    await notify.waitForStatus(KEY, 'cloning');
    assert.deepEqual(r.cancelReview(KEY), { success: true });
    assert.deepEqual(gitChild.signals, ['SIGTERM']);
    assert.deepEqual(await pending, { success: true, error: null, cancelled: true });
    assert.equal(r.getReviewDetail(KEY).status, 'cancelled');
    assert.match(r.getReviewOutput(KEY), /Review cancelled by user/);
    assert.ok(!r.getReviewOutput(KEY).includes('Launching'), 'the agent was never spawned');
  } finally { r.restoreConsole(); }
});

// Regression: the SIGKILL escalation was guarded by `!child.killed`, which
// is true the moment SIGTERM was *sent*, so an agent that ignored SIGTERM
// was never killed.
test('Cancelling_a_running_agent_sends_SIGTERM_then_SIGKILL_after_the_grace_period_when_it_ignores_SIGTERM', async () => {
  const { runner: r, notify } = runner({ mode: 'hang', killGraceMs: 300 });
  try {
    await r.startReview(PR, 'claude', null, 'review');
    await notify.waitForStatus(KEY, 'running');
    await new Promise((resolve) => {
      const tick = () => (r.getReviewOutput(KEY).includes('[fake-agent] hanging') ? resolve() : setTimeout(tick, 20));
      tick();
    });
    const t0 = Date.now();
    assert.deepEqual(r.cancelReview(KEY), { success: true });
    await notify.waitForStatus(KEY, 'cancelled', 5000);
    const output = r.getReviewOutput(KEY);
    assert.match(output, /ignoring SIGTERM/);
    assert.match(output, /claude finished — signal SIGKILL/);
    assert.ok(Date.now() - t0 >= 250, 'waited the grace period before SIGKILL');
    assert.equal(r.getReviewDetail(KEY).reportStatus, null, 'no report parsing for a cancelled run');
  } finally { r.restoreConsole(); }
});

test('A_second_start_for_the_same_PR_is_refused_while_one_is_running_and_so_is_a_rerun_and_a_cancel_of_a_finished_run', async () => {
  const { runner: r, notify } = runner({ mode: 'slow' });
  try {
    await r.startReview(PR, 'claude', null, 'review');
    await notify.waitForStatus(KEY, 'running');
    assert.deepEqual(await r.startReview(PR, 'claude', null, 'review'), { success: false, error: 'Review already in progress for this PR.' });
    assert.deepEqual(await r.rerunReview(KEY), { success: false, error: 'Cannot re-run while the previous run is still in progress.' });
    await notify.waitForStatus(KEY, 'completed');
    assert.deepEqual(r.cancelReview(KEY), { success: false, error: 'Cannot cancel review in status "completed".' });
    assert.deepEqual(r.cancelReview('nope'), { success: false, error: 'Review not found.' });
  } finally { r.restoreConsole(); }
});

test('An_unknown_or_uninstalled_agent_and_a_service_that_is_not_connected_are_refused_before_anything_is_cloned', async () => {
  const { runner: r, cloner } = runner({ registry: fakeRegistry({ available: false }) });
  try {
    assert.deepEqual(await r.startReview(PR, 'claude', null), { success: false, error: 'Fake claude is not installed.' });
    assert.deepEqual(await r.startReview(PR, 'nope', null), { success: false, error: 'Unknown agent: nope' });
    assert.deepEqual(cloner.cloned, []);

    // The ADO connection is gone (disconnect-provider) but the row is an ADO row.
    const disconnected = runner({ mode: 'ok' });
    disconnected.runner.removeConnection('azure-devops');
    assert.equal(disconnected.runner.hasConnection, false);
    const res = await disconnected.runner.startReview(PR, 'claude', null);
    assert.equal(res.success, false);
    assert.match(res.error, /Not connected to Azure DevOps — connect it in Settings first/);
    assert.equal(disconnected.runner.getReviewDetail(KEY).status, 'failed');

    // A GitHub row while only ADO is connected names the missing service.
    const adoOnly = runner({ mode: 'ok' });
    const gh = await adoOnly.runner.startReview({ ...PR, provider: 'github' }, 'claude', null);
    assert.match(gh.error, /Not connected to GitHub/);
    assert.equal(adoOnly.cloner.cloned.length, 0, 'nothing cloned for a service that is not connected');
    disconnected.runner.restoreConsole();
    adoOnly.runner.restoreConsole();
  } finally { r.restoreConsole(); }
});

test('The_silence_watchdog_nudges_once_when_no_output_arrives_then_every_silence_window_and_stops_when_cancelled', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { runner: r, notify } = runner({});
  try {
    const review = { status: 'running', output: '' };
    // First-output nudge after 1s; ongoing nudges after 45s of silence, checked on a 30s poll.
    const wd = r._armSilenceWatchdog('k', review, 'claude', 1000, 45000);
    t.mock.timers.tick(999);
    assert.equal(review.output, '');
    t.mock.timers.tick(1);
    assert.match(review.output, /No output from claude after 1s/);
    assert.equal(notify.chunks.length, 1);

    t.mock.timers.tick(30000); // t=31s: silent 31s < 45s → nothing
    assert.equal(review.output.match(/Still waiting/g), null);
    t.mock.timers.tick(30000); // t=61s: silent 61s → nudge
    assert.match(review.output, /Still waiting on claude — no output for ~1 min/);
    wd.onOutput();             // output arrives at t=61s
    t.mock.timers.tick(30000); // t=91s: silent 30s → nothing
    assert.equal(review.output.match(/Still waiting/g).length, 1);
    t.mock.timers.tick(30000); // t=121s: silent 60s → second nudge
    assert.equal(review.output.match(/Still waiting/g).length, 2);
    review.status = 'completed';
    wd.cancel();
    t.mock.timers.tick(600000);
    assert.equal(review.output.match(/Still waiting/g).length, 2);
  } finally { r.restoreConsole(); }
});

test('A_first_output_chunk_disarms_the_first_output_watchdog', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { runner: r } = runner({});
  try {
    const review = { status: 'running', output: '' };
    const wd = r._armSilenceWatchdog('k', review, 'claude', 1000, 5000);
    wd.onOutput();
    t.mock.timers.tick(1000);
    assert.equal(review.output, '');
    wd.cancel();
  } finally { r.restoreConsole(); }
});

void path;

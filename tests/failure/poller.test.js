'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PrPoller } = require('../../src/main/pr-poller');
const { DevOpsSession } = require('../../src/main/devops-session');
const { ScriptedDevOpsClient } = require('../helpers/fakes');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const INTERVAL = 60000;

function recorder() {
  const lists = [];
  const errors = [];
  return { lists, errors, onList: (p) => lists.push(p), onError: (m) => errors.push(m) };
}

test('A_poll_that_throws_is_reported_the_last_good_list_is_kept_and_the_next_success_clears_the_error', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new ScriptedDevOpsClient({ script: [[{ id: 1 }], new Error('TF400813 boom'), [{ id: 2 }]] });
  const rec = recorder();
  const poller = new PrPoller({ fetch: () => client.getAllOpenPRs(), intervalMs: INTERVAL, ...rec });

  await poller.start();
  assert.deepEqual(rec.lists, [[{ id: 1 }]]);
  assert.deepEqual(poller.lastPrs, [{ id: 1 }]);

  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.deepEqual(rec.errors, ['TF400813 boom']);
  assert.deepEqual(rec.lists, [[{ id: 1 }]], 'no empty list was pushed over the good one');
  assert.deepEqual(poller.lastPrs, [{ id: 1 }]);
  assert.equal(poller.lastError, 'TF400813 boom');

  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.deepEqual(rec.lists.at(-1), [{ id: 2 }]);
  assert.equal(poller.lastError, null);

  poller.stop();
  t.mock.timers.tick(INTERVAL * 3);
  await flush();
  assert.equal(client.calls, 3, 'nothing polls after stop');
  assert.equal(poller.running, false);
});

test('Ticks_that_land_while_a_poll_is_still_in_flight_do_not_stack_a_second_fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release;
  let calls = 0;
  const poller = new PrPoller({ fetch: () => { calls += 1; return new Promise((r) => { release = r; }); }, intervalMs: INTERVAL, ...recorder() });
  poller.start();
  t.mock.timers.tick(INTERVAL);
  t.mock.timers.tick(INTERVAL);
  assert.equal(calls, 1);
  release([]);
  await flush();
  t.mock.timers.tick(INTERVAL);
  assert.equal(calls, 2);
  poller.stop();
});

test('Starting_a_poller_twice_replaces_the_interval_instead_of_adding_one', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new ScriptedDevOpsClient({ script: [[]] });
  const poller = new PrPoller({ fetch: () => client.getAllOpenPRs(), intervalMs: INTERVAL, ...recorder() });
  await poller.start();
  await poller.start();
  assert.equal(client.calls, 2, 'each start polls once immediately');
  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.equal(client.calls, 3, 'one interval, one poll per tick');
  poller.stop();
});

// ── The session: what validate-pat and clear-pat drive ────────────────

function fakeWebhookFactory() {
  const instances = [];
  const create = (port, onEvent, opts) => {
    const w = { port, opts, started: 0, stopped: 0, onEvent, async start() { this.started += 1; return port || 9999; }, async stop() { this.stopped += 1; } };
    instances.push(w);
    return w;
  };
  return { instances, create };
}

function session({ clients, webhooks, events }) {
  let i = 0;
  return new DevOpsSession({
    onUser: (u) => events.push(['user', u]),
    onPrList: (prs) => events.push(['list', prs]),
    onPrError: (m) => events.push(['error', m]),
    onWebhookEvent: (e) => events.push(['hook', e]),
    createClient: () => clients[i++],
    createWebhook: webhooks.create,
    log: () => {},
  });
}

// Regression: validate-pat called initDevOps again on every re-validation,
// adding a second setInterval(pollPrs) and a second WebhookServer on the
// same port (EADDRINUSE) each time.
test('Re_validating_a_PAT_replaces_the_poller_and_the_webhook_server_rather_than_stacking_them', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const first = new ScriptedDevOpsClient({ script: [[{ id: 1 }]] });
  const second = new ScriptedDevOpsClient({ script: [[{ id: 2 }]] });
  const webhooks = fakeWebhookFactory();
  const events = [];
  const s = session({ clients: [first, second], webhooks, events });
  const opts = { pat: 'p', orgUrl: 'https://dev.azure.com/o', pollingIntervalMs: INTERVAL, webhookPort: 3847, webhookHost: '127.0.0.1', webhookSecret: '' };

  await s.connect(opts);
  await s.connect(opts);
  await flush();

  assert.equal(webhooks.instances.length, 2);
  assert.equal(webhooks.instances[0].stopped, 1, 'the first webhook server was stopped');
  assert.equal(webhooks.instances[1].started, 1);
  assert.deepEqual(webhooks.instances[1].opts, { host: '127.0.0.1', secret: '', log: webhooks.instances[1].opts.log });

  const before = { first: first.calls, second: second.calls };
  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.equal(first.calls, before.first, 'the old poller is dead');
  assert.equal(second.calls, before.second + 1, 'exactly one poll per tick');
  assert.deepEqual(events.filter((e) => e[0] === 'list').at(-1), ['list', [{ id: 2 }]]);
  await s.disconnect();
});

// Regression: clear-pat nulled devopsClient but left setInterval(pollPrs)
// running, so every tick threw TypeError on `devopsClient.getAllOpenPRs`.
test('Clearing_the_PAT_stops_polling_and_the_webhook_server_and_a_later_poll_request_is_a_no_op', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const client = new ScriptedDevOpsClient({ script: [[{ id: 1 }]] });
  const webhooks = fakeWebhookFactory();
  const events = [];
  const s = session({ clients: [client], webhooks, events });
  await s.connect({ pat: 'p', orgUrl: 'https://dev.azure.com/o', pollingIntervalMs: INTERVAL, webhookPort: 0 });
  assert.equal(s.connected, true);
  assert.deepEqual(events[0], ['user', { id: 'u1', displayName: 'Test User', email: 't@example.com' }]);

  await s.disconnect();
  assert.equal(s.connected, false);
  assert.equal(s.user, null);
  assert.equal(webhooks.instances[0].stopped, 1);
  const calls = client.calls;
  t.mock.timers.tick(INTERVAL * 5);
  await flush();
  await s.pollNow();
  assert.equal(client.calls, calls, 'no poll after disconnect');
  assert.ok(!events.some((e) => e[0] === 'error'), 'no TypeError surfaced as a PR error');
  await s.disconnect();
});

test('A_failing_getMe_or_a_webhook_port_in_use_does_not_stop_the_PR_list_from_loading', async () => {
  const client = new ScriptedDevOpsClient({ script: [[{ id: 1 }]] });
  client.getMe = async () => { throw new Error('403'); };
  const webhooks = fakeWebhookFactory();
  const events = [];
  const s = session({ clients: [client], webhooks, events });
  webhooks.create = ((orig) => (port, onEvent, opts) => { const w = orig(port, onEvent, opts); w.start = async () => { throw new Error('EADDRINUSE'); }; return w; })(webhooks.create);
  s.createWebhook = webhooks.create;
  const result = await s.connect({ pat: 'p', orgUrl: 'https://dev.azure.com/o', pollingIntervalMs: INTERVAL, webhookPort: 3847 });
  await flush();
  assert.equal(result.user, null);
  assert.deepEqual(events.find((e) => e[0] === 'user'), ['user', null]);
  assert.deepEqual(events.find((e) => e[0] === 'list'), ['list', [{ id: 1 }]]);
  await s.disconnect();
});

test('A_webhook_event_reaches_the_handler_the_session_was_given', async () => {
  const webhooks = fakeWebhookFactory();
  const events = [];
  const s = session({ clients: [new ScriptedDevOpsClient()], webhooks, events });
  await s.connect({ pat: 'p', orgUrl: 'https://dev.azure.com/o', pollingIntervalMs: INTERVAL, webhookPort: 0 });
  webhooks.instances[0].onEvent({ eventType: 'git.pullrequest.updated' });
  assert.deepEqual(events.at(-1), ['hook', { eventType: 'git.pullrequest.updated' }]);
  await s.disconnect();
});

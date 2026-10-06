'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PrPoller } = require('../../src/main/pr-poller');
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

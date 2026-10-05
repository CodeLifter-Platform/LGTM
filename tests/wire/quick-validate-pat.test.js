'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { quickValidatePat } = require('../../src/main/quick-validate-pat');
const { startFakeAdo } = require('../helpers/fakes');

const servers = [];
async function ado(fixture) { const s = await startFakeAdo(fixture); servers.push(s); return s; }
after(async () => { for (const s of servers) await s.close(); });
const quiet = { log: () => {} };

test('The_startup_check_accepts_a_PAT_the_org_answers_ConnectionData_for_using_Basic_auth_with_an_empty_user', async () => {
  const s = await ado({});
  assert.deepEqual(await quickValidatePat(s.pat, s.orgUrl, quiet), { ok: true });
  const req = s.requests.find((r) => /connectiondata/i.test(r.url));
  assert.equal(req.headers.authorization, `Basic ${Buffer.from(`:${s.pat}`).toString('base64')}`);
  assert.match(req.url, /connectOptions=none/);
});

test('A_401_403_or_the_203_sign_in_page_means_rejected_so_the_user_must_re_enter_the_PAT', async () => {
  const s = await ado({});
  assert.deepEqual(await quickValidatePat('wrong', s.orgUrl, quiet), { ok: false, reason: 'rejected' });
  const signIn = await ado({ intercept: () => ({ status: 203, raw: '<html>sign in</html>' }) });
  assert.deepEqual(await quickValidatePat(signIn.pat, signIn.orgUrl, quiet), { ok: false, reason: 'rejected' });
  const forbidden = await ado({ intercept: () => ({ status: 403, body: {} }) });
  assert.deepEqual(await quickValidatePat(forbidden.pat, forbidden.orgUrl, quiet), { ok: false, reason: 'rejected' });
});

test('A_200_without_an_authenticated_user_or_a_5xx_is_unreachable_and_does_not_lock_the_user_out', async () => {
  const empty = await ado({ intercept: () => ({ status: 200, body: {} }) });
  assert.deepEqual(await quickValidatePat(empty.pat, empty.orgUrl, quiet), { ok: false, reason: 'unreachable' });
  const down = await ado({ intercept: () => ({ status: 503, body: {} }) });
  assert.deepEqual(await quickValidatePat(down.pat, down.orgUrl, quiet), { ok: false, reason: 'unreachable' });
});

test('A_connection_refused_or_a_timeout_is_unreachable', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  assert.deepEqual(await quickValidatePat('x', `http://127.0.0.1:${port}`, quiet), { ok: false, reason: 'unreachable' });

  const slow = await ado({});
  slow.setIntercept(() => new Promise(() => {}));
  assert.deepEqual(await quickValidatePat(slow.pat, slow.orgUrl, { ...quiet, timeoutMs: 100 }), { ok: false, reason: 'unreachable' });
});

test('Garbage_in_the_org_URL_is_rejected_without_a_network_call', async () => {
  const http = { get: async () => { throw new Error('must not be called'); } };
  assert.deepEqual(await quickValidatePat('x', 'nope', { http, ...quiet }), { ok: false, reason: 'rejected' });
});

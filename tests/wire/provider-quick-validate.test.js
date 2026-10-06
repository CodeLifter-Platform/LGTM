'use strict';
/**
 * The startup token check main.js runs for every stored connection:
 * `provider.quickValidate(token, url, rawHttp)`, the real axios adapter
 * against the fake Azure DevOps server. The reason matters: a rejected
 * token forces re-entry, a network blip lets the user in with the cache.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { PROVIDERS } = require('../../src/main/providers');
const { rawHttp } = require('../../src/main/raw-http');
const { startFakeAdo } = require('../helpers/fakes');

const ado = PROVIDERS['azure-devops'];
const servers = [];
async function fake(fixture) { const s = await startFakeAdo(fixture); servers.push(s); return s; }
after(async () => { for (const s of servers) await s.close(); });

test('The_startup_check_accepts_a_PAT_the_org_answers_ConnectionData_for_using_Basic_auth_with_an_empty_user', async () => {
  const s = await fake({});
  assert.deepEqual(await ado.quickValidate(s.pat, s.orgUrl, rawHttp), { ok: true });
  const req = s.requests.find((r) => /connectiondata/i.test(r.url));
  assert.equal(req.headers.authorization, `Basic ${Buffer.from(`:${s.pat}`).toString('base64')}`);
  assert.match(req.url, /connectOptions=none/);
});

test('A_401_403_or_the_203_sign_in_page_means_rejected_so_the_user_must_re_enter_the_token', async () => {
  const s = await fake({});
  assert.deepEqual(await ado.quickValidate('wrong', s.orgUrl, rawHttp), { ok: false, reason: 'rejected' });
  const signIn = await fake({ intercept: () => ({ status: 203, raw: '<html>sign in</html>' }) });
  assert.deepEqual(await ado.quickValidate(signIn.pat, signIn.orgUrl, rawHttp), { ok: false, reason: 'rejected' });
  const forbidden = await fake({ intercept: () => ({ status: 403, body: {} }) });
  assert.deepEqual(await ado.quickValidate(forbidden.pat, forbidden.orgUrl, rawHttp), { ok: false, reason: 'rejected' });
});

test('A_200_without_an_authenticated_user_a_5xx_or_a_dead_port_is_unreachable_and_does_not_lock_the_user_out', async () => {
  const empty = await fake({ intercept: (r) => (/connectiondata/i.test(r.url) ? { status: 200, body: {} } : undefined) });
  assert.deepEqual(await ado.quickValidate(empty.pat, empty.orgUrl, rawHttp), { ok: false, reason: 'unreachable' });
  const down = await fake({ intercept: () => ({ status: 503, body: {} }) });
  assert.deepEqual(await ado.quickValidate(down.pat, down.orgUrl, rawHttp), { ok: false, reason: 'unreachable' });

  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  assert.deepEqual(await ado.quickValidate('t', `http://127.0.0.1:${port}`, rawHttp), { ok: false, reason: 'unreachable' });
});

test('A_URL_that_is_not_a_URL_is_rejected_before_any_request_is_made', async () => {
  let called = 0;
  const result = await ado.quickValidate('t', '', async () => { called += 1; return { status: 200, data: {} }; });
  assert.deepEqual(result, { ok: false, reason: 'rejected' });
  assert.equal(called, 0);
});

'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebhookServer, secretsMatch, SECRET_HEADER } = require('../../src/main/webhook-server');

const servers = [];
async function start(opts = {}, onEvent = () => {}) {
  const events = [];
  const server = new WebhookServer(0, (e) => { events.push(e); onEvent(e); }, { log: () => {}, ...opts });
  const port = await server.start();
  servers.push(server);
  return { server, port, events };
}
after(async () => { for (const s of servers) await s.stop(); });

function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    // agent: false — a fresh socket per request, so a connection the server
    // closed on purpose (413) is never reused by the next request.
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('start_resolves_the_port_actually_bound_and_binds_to_loopback_by_default', async () => {
  const { server, port } = await start();
  assert.ok(port > 0);
  assert.equal(server.port, port);
  assert.equal(server.host, '127.0.0.1');
  assert.equal(await server.start(), port, 'a second start is the same server');
  const health = await request(port, { path: '/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok', app: 'lgtm' });
});

test('A_valid_JSON_event_is_delivered_exactly_once_and_acknowledged', async () => {
  const { port, events } = await start();
  const res = await request(port, { method: 'POST', path: '/webhook', body: JSON.stringify({ eventType: 'git.pullrequest.created', id: 1 }) });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { received: true });
  assert.deepEqual(events, [{ eventType: 'git.pullrequest.created', id: 1 }]);
});

test('Bad_JSON_is_a_400_an_unknown_route_a_404_and_neither_reaches_the_handler', async () => {
  const { port, events } = await start();
  assert.equal((await request(port, { method: 'POST', path: '/webhook', body: '{not json' })).status, 400);
  assert.equal((await request(port, { path: '/webhook' })).status, 404);
  assert.equal((await request(port, { method: 'POST', path: '/other', body: '{}' })).status, 404);
  assert.deepEqual(events, []);
});

test('A_body_over_the_limit_is_refused_with_413_and_never_parsed', async () => {
  const { port, events } = await start({ maxBodyBytes: 64 });
  const res = await request(port, { method: 'POST', path: '/webhook', body: JSON.stringify({ pad: 'x'.repeat(200) }) });
  assert.equal(res.status, 413);
  assert.match(res.body, /exceeds 64 bytes/);
  assert.deepEqual(events, []);
  const ok = await request(port, { method: 'POST', path: '/webhook', body: '{"a":1}' });
  assert.equal(ok.status, 200, 'the server is still serving after refusing a body');
});

test('With_a_secret_configured_the_webhook_refuses_a_missing_and_a_wrong_secret_and_accepts_the_exact_one_while_health_stays_open', async () => {
  const { port, events } = await start({ secret: 'hunter2' });
  assert.equal((await request(port, { path: '/health' })).status, 200);
  const missing = await request(port, { method: 'POST', path: '/webhook', body: '{}' });
  assert.equal(missing.status, 401);
  const wrong = await request(port, { method: 'POST', path: '/webhook', body: '{}', headers: { [SECRET_HEADER]: 'hunter3' } });
  assert.equal(wrong.status, 401);
  // A longer value that starts with the secret: exact match, not prefix.
  const prefix = await request(port, { method: 'POST', path: '/webhook', body: '{}', headers: { [SECRET_HEADER]: 'hunter2x' } });
  assert.equal(prefix.status, 401);
  assert.deepEqual(events, []);
  const right = await request(port, { method: 'POST', path: '/webhook', body: '{"ok":1}', headers: { [SECRET_HEADER]: 'hunter2' } });
  assert.equal(right.status, 200);
  assert.deepEqual(events, [{ ok: 1 }]);
});

test('Secrets_are_compared_exactly_in_constant_time_regardless_of_length', () => {
  assert.equal(secretsMatch('abc', 'abc'), true);
  assert.equal(secretsMatch('abc', 'abd'), false);
  assert.equal(secretsMatch('abc', 'abcd'), false);
  assert.equal(secretsMatch('abc', ''), false);
  assert.equal(secretsMatch('abc', null), false);
  assert.equal(secretsMatch('', ''), true);
});

test('A_handler_that_throws_does_not_take_the_server_down', async () => {
  const { port } = await start({}, () => { throw new Error('handler bug'); });
  assert.equal((await request(port, { method: 'POST', path: '/webhook', body: '{}' })).status, 200);
  assert.equal((await request(port, { path: '/health' })).status, 200);
});

test('A_port_already_in_use_rejects_start_instead_of_logging_and_pretending', async () => {
  const { port } = await start();
  const second = new WebhookServer(port, () => {}, { log: () => {} });
  await assert.rejects(second.start(), /EADDRINUSE/);
  assert.equal(second.server, null);
});

test('stop_closes_the_listener_so_the_port_is_free_again', async () => {
  const { server, port } = await start();
  await server.stop();
  servers.splice(servers.indexOf(server), 1);
  await assert.rejects(request(port, { path: '/health' }), /ECONNREFUSED/);
  await server.stop();
});

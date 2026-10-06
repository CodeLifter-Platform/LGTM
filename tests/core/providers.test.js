const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, PROVIDER_IDS, getProvider, describeProvider, Connection } = require('../../src/main/providers');
const { RepoCloner } = require('../../src/main/repo-cloner');
const { scriptedHttp } = require('../helpers/scripted-http');

test('registry: both providers are registered and describable without functions', () => {
  assert.deepEqual(PROVIDER_IDS, ['azure-devops', 'github']);
  for (const id of PROVIDER_IDS) {
    const d = describeProvider(id);
    assert.equal(d.id, id);
    assert.ok(d.label && d.urlLabel && d.tokenLabel && d.scopes.length);
    for (const v of Object.values(d)) assert.notEqual(typeof v, 'function');
  }
  assert.throws(() => getProvider('gitlab'), /Unknown provider/);
});

test('cloneUrl embeds the credential in the service-specific URL shape', () => {
  const ado = PROVIDERS['azure-devops'].cloneUrl('p@t', 'https://dev.azure.com/acme/Proj', 'Proj', 'My Repo');
  assert.equal(ado, 'https://pat:p%40t@dev.azure.com/acme/Proj/_git/My%20Repo');
  const vsts = PROVIDERS['azure-devops'].cloneUrl('tok', 'https://acme.visualstudio.com', 'Proj', 'repo');
  assert.equal(vsts, 'https://pat:tok@acme.visualstudio.com/Proj/_git/repo');

  const gh = PROVIDERS.github.cloneUrl('ghp_x', 'https://github.com/acme', 'acme', 'widgets');
  assert.equal(gh, 'https://x-access-token:ghp_x@github.com/acme/widgets.git');
  const ghe = PROVIDERS.github.cloneUrl('t', 'https://ghe.corp.com/platform', 'platform', 'core');
  assert.equal(ghe, 'https://x-access-token:t@ghe.corp.com/platform/core.git');
});

test('agentEnv hands the token to the agent under each service\'s conventional names', () => {
  const ado = new Connection('azure-devops', 'p', 'https://dev.azure.com/acme');
  assert.deepEqual(ado.agentEnv(), { AZURE_DEVOPS_PAT: 'p', AZURE_DEVOPS_EXT_PAT: 'p', SYSTEM_ACCESSTOKEN: 'p' });
  const gh = new Connection('github', 'g', 'https://github.com/acme');
  assert.deepEqual(gh.agentEnv(), { GITHUB_TOKEN: 'g', GH_TOKEN: 'g' });
});

test('Connection: parsed display, attachment hosts, and a status row that never carries the token', () => {
  const ado = new Connection('azure-devops', 'secret', 'https://dev.azure.com/acme/Proj');
  assert.equal(ado.display, 'acme/Proj');
  assert.deepEqual(ado.attachmentHosts, ['dev.azure.com']);
  const gh = new Connection('github', 'secret', 'https://github.com/acme');
  assert.equal(gh.display, 'acme');
  assert.deepEqual(gh.attachmentHosts, ['github.com', 'githubusercontent.com', 'objects.githubusercontent.com']);
  for (const c of [ado, gh]) {
    const row = JSON.stringify(c.toStatus());
    assert.ok(!row.includes('secret'), 'status row leaks the token');
    assert.equal(c.toStatus().connected, true);
  }
});

test('isWebhookEvent routes ADO service hooks and GitHub webhooks to the right provider', () => {
  const ado = PROVIDERS['azure-devops'];
  const gh = PROVIDERS.github;
  assert.equal(ado.isWebhookEvent({ eventType: 'git.pullrequest.updated' }, {}), true);
  assert.equal(ado.isWebhookEvent({ eventType: 'build.complete' }, {}), false);
  assert.equal(gh.isWebhookEvent({ eventType: 'git.pullrequest.updated' }, {}), false);
  assert.equal(gh.isWebhookEvent({ action: 'opened', pull_request: {}, repository: {} }, { 'x-github-event': 'pull_request' }), true);
  assert.equal(gh.isWebhookEvent({ zen: 'keep it simple' }, { 'x-github-event': 'ping' }), false);
  assert.equal(gh.isWebhookEvent({ pull_request: {}, repository: {} }, {}), true, 'body shape alone is enough');
  assert.equal(ado.isWebhookEvent({ pull_request: {}, repository: {} }, {}), false);
});

test('quickValidate: ok / rejected / unreachable for both services', async () => {
  const gh = PROVIDERS.github;
  assert.deepEqual(await gh.quickValidate('t', 'https://github.com', scriptedHttp([{ match: '/user', data: { login: 'a' } }])), { ok: true });
  assert.deepEqual(await gh.quickValidate('t', 'https://github.com', scriptedHttp([{ match: '/user', status: 401, data: {} }])), { ok: false, reason: 'rejected' });
  assert.deepEqual(await gh.quickValidate('t', 'https://github.com', scriptedHttp([{ match: '/user', status: 503, data: {} }])), { ok: false, reason: 'unreachable' });
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.deepEqual(await gh.quickValidate('t', 'https://github.com', scriptedHttp([{ match: '/user', throws: refused }])), { ok: false, reason: 'unreachable' });

  const ado = PROVIDERS['azure-devops'];
  assert.deepEqual(await ado.quickValidate('t', 'https://dev.azure.com/acme', scriptedHttp([{ match: '_apis/ConnectionData', data: { authenticatedUser: { id: 'u1' } } }])), { ok: true });
  assert.deepEqual(await ado.quickValidate('t', 'https://dev.azure.com/acme', scriptedHttp([{ match: '_apis/ConnectionData', status: 203, data: '<html>sign in</html>' }])), { ok: false, reason: 'rejected' }, 'ADO signals a bad PAT with a 203 sign-in page');
  assert.deepEqual(await ado.quickValidate('t', 'https://dev.azure.com/acme', scriptedHttp([{ match: '_apis/ConnectionData', status: 500, data: {} }])), { ok: false, reason: 'unreachable' });
});

test('RepoCloner delegates clone URLs to the connection and refuses to build without one', () => {
  assert.throws(() => new RepoCloner(null), /cloneUrl/);
  assert.throws(() => new RepoCloner({}), /cloneUrl/);
  const conn = new Connection('github', 'g', 'https://github.com/acme');
  const cloner = new RepoCloner(conn);
  assert.equal(cloner._buildCloneUrl({ project: 'acme', repo: 'widgets' }), 'https://x-access-token:g@github.com/acme/widgets.git');
  assert.equal(cloner.pat, 'g');
});

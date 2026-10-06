const test = require('node:test');
const assert = require('node:assert/strict');
const { TokenStore, ENTRIES } = require('../src/main/token-store');
const { MemoryStore, silentLogger } = require('./helpers');

function fakeKeytar(record) {
  return {
    async setPassword(service, account, value) { record.push(['set', service, account, value]); },
    async deletePassword(service, account) { record.push(['del', service, account]); },
  };
}

test('tokens round-trip per provider under distinct keys, and delete clears them', async () => {
  const fallback = new MemoryStore();
  const calls = [];
  const store = new TokenStore({ fallbackStore: fallback, keytar: fakeKeytar(calls), logger: silentLogger });

  await store.set('azure-devops', 'ado-pat');
  await store.set('github', 'gh-token');
  assert.equal(await store.get('azure-devops'), 'ado-pat');
  assert.equal(await store.get('github'), 'gh-token');

  // The ADO entry keeps the pre-multi-provider names so an existing install
  // keeps its PAT across the upgrade.
  assert.equal(ENTRIES['azure-devops'].key, 'pat');
  assert.equal(ENTRIES['azure-devops'].service, 'com.lgtm.azuredevops');
  assert.deepEqual(Object.keys(fallback.data).sort(), ['github-token', 'pat']);
  assert.deepEqual(calls, [
    ['set', 'com.lgtm.azuredevops', 'pat', 'ado-pat'],
    ['set', 'com.lgtm.github', 'token', 'gh-token'],
  ]);

  await store.delete('github');
  assert.equal(await store.get('github'), null);
  assert.equal(await store.get('azure-devops'), 'ado-pat', 'deleting one provider leaves the other');
  assert.deepEqual(calls[2], ['del', 'com.lgtm.github', 'token']);
});

test('a refusing keychain is reported and worked around: the encrypted fallback still holds the token', async () => {
  const fallback = new MemoryStore();
  const warnings = [];
  const keytar = {
    async setPassword() { throw new Error('The user name or passphrase you entered is not correct.'); },
    async deletePassword() { throw new Error('nope'); },
  };
  const store = new TokenStore({ fallbackStore: fallback, keytar, logger: { log() {}, warn: (...a) => warnings.push(a.join(' ')) } });
  await store.set('github', 'gh-token');
  assert.equal(await store.get('github'), 'gh-token');
  assert.ok(warnings.some((w) => /keytar.setPassword skipped/.test(w)));
  await store.delete('github');
  assert.equal(await store.get('github'), null);
});

test('a hanging keychain cannot wedge save: set() resolves after the timeout', async () => {
  const fallback = new MemoryStore();
  const keytar = { setPassword: () => new Promise(() => {}), deletePassword: () => new Promise(() => {}) };
  const store = new TokenStore({ fallbackStore: fallback, keytar, logger: silentLogger });
  const t0 = Date.now();
  await store.set('azure-devops', 'p');
  assert.ok(Date.now() - t0 < 5000, 'returned within the keytar timeout');
  assert.equal(await store.get('azure-devops'), 'p');
});

test('no keytar at all still works, and bad input is refused', async () => {
  const store = new TokenStore({ fallbackStore: new MemoryStore(), keytar: null, logger: silentLogger });
  await store.set('github', 'x');
  assert.equal(await store.get('github'), 'x');
  await assert.rejects(store.set('github', ''), /non-empty/);
  await assert.rejects(store.set('gitlab', 'x'), /unknown provider/);
  assert.deepEqual(TokenStore.providers(), ['azure-devops', 'github']);
});

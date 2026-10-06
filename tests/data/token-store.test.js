'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TokenStore, ENTRIES } = require('../../src/main/token-store');
const { FakeKeychain, MemoryStore } = require('../helpers/fakes');

const quiet = () => {};
const store = (keychain, legacyStore = new MemoryStore(), timeoutMs = 50) => new TokenStore({ keychain, legacyStore, timeoutMs, log: quiet });
const ADO = `${ENTRIES['azure-devops'].service}/${ENTRIES['azure-devops'].account}`;
const GH = `${ENTRIES.github.service}/${ENTRIES.github.account}`;

test('Tokens_reach_the_OS_keychain_under_one_entry_per_provider_and_nothing_else_and_read_back_from_it', async () => {
  const keychain = new FakeKeychain();
  const legacy = new MemoryStore();
  const s = store(keychain, legacy);

  assert.deepEqual(await s.set('azure-devops', 'ado-pat'), { ok: true, error: null });
  assert.deepEqual(await s.set('github', 'gh-token'), { ok: true, error: null });
  assert.equal(keychain.entries.get(ADO), 'ado-pat');
  assert.equal(keychain.entries.get(GH), 'gh-token');
  assert.equal(legacy.writes, 0, 'no file write');

  const again = store(keychain, legacy);
  assert.deepEqual(await again.get('azure-devops'), { token: 'ado-pat', source: 'keychain', error: null });
  assert.deepEqual(await again.get('github'), { token: 'gh-token', source: 'keychain', error: null });

  // Deleting one provider leaves the other.
  assert.deepEqual(await s.delete('github'), { ok: true, error: null });
  assert.equal((await s.get('github')).token, null);
  assert.equal((await s.get('azure-devops')).token, 'ado-pat');
});

test('The_Azure_DevOps_entry_keeps_the_pre_multi_provider_names_so_an_existing_install_keeps_its_PAT', () => {
  assert.equal(ENTRIES['azure-devops'].service, 'com.lgtm.azuredevops');
  assert.equal(ENTRIES['azure-devops'].account, 'pat');
  assert.equal(ENTRIES['azure-devops'].key, 'pat');
  assert.notEqual(ENTRIES.github.service, ENTRIES['azure-devops'].service);
  assert.deepEqual(TokenStore.providers(), ['azure-devops', 'github']);
});

// Regression: the old store wrote the file first, logged success, and only
// then tried the keychain; a refused keychain was a console line and the
// token lived in an obfuscated JSON file. Now the refusal is the result.
test('A_refusing_keychain_is_reported_as_a_failed_save_and_the_token_is_written_nowhere', async () => {
  const keychain = new FakeKeychain({ mode: 'refuse', error: 'User denied access' });
  const legacy = new MemoryStore();
  const result = await store(keychain, legacy).set('github', 'gh-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /refused the token \(User denied access\)/);
  assert.match(result.error, /in memory for this session only/);
  assert.equal(keychain.entries.size, 0);
  assert.equal(legacy.writes, 0);
  assert.deepEqual(await store(keychain, legacy).get('github'), { token: null, source: null, error: 'User denied access' });
});

test('A_hanging_keychain_times_out_and_the_timeout_is_reported_not_swallowed', async () => {
  const keychain = new FakeKeychain({ mode: 'hang' });
  const s = store(keychain, new MemoryStore(), 30);
  const t0 = Date.now();
  const result = await s.set('azure-devops', 'pat-123');
  assert.ok(Date.now() - t0 < 1000, 'bounded by the timeout, not the hang');
  assert.equal(result.ok, false);
  assert.match(result.error, /keychain\.setPassword timed out after 30ms/);
  const read = await s.get('azure-devops');
  assert.equal(read.token, null);
  assert.match(read.error, /keychain\.getPassword timed out/);
});

test('No_keychain_backend_at_all_is_reported_as_unavailable_rather_than_silently_succeeding', async () => {
  const s = store(null);
  const result = await s.set('github', 'x');
  assert.equal(result.ok, false);
  assert.match(result.error, /not available/);
  assert.match((await s.get('github')).error, /not available/);
});

test('Delete_removes_the_token_from_the_keychain_and_the_legacy_file_and_reports_a_refusal', async () => {
  const keychain = new FakeKeychain();
  const legacy = new MemoryStore({ pat: 'old' });
  const s = store(keychain, legacy);
  await s.set('azure-devops', 'pat-123');
  legacy.set('pat', 'stale-copy');
  assert.deepEqual(await s.delete('azure-devops'), { ok: true, error: null });
  assert.equal(keychain.entries.size, 0);
  assert.equal(legacy.has('pat'), false);
  assert.deepEqual(await s.get('azure-devops'), { token: null, source: null, error: null });

  const refusing = new FakeKeychain({ mode: 'refuse', error: 'locked' });
  const r = await store(refusing, new MemoryStore()).delete('azure-devops');
  assert.equal(r.ok, false);
  assert.match(r.error, /locked/);
});

test('A_PAT_left_in_the_legacy_file_by_an_older_version_is_moved_into_the_keychain_on_first_read', async () => {
  const keychain = new FakeKeychain();
  const legacy = new MemoryStore({ pat: 'legacy-pat' });
  const read = await store(keychain, legacy).get('azure-devops');
  assert.deepEqual(read, { token: 'legacy-pat', source: 'keychain', error: null });
  assert.equal(keychain.entries.get(ADO), 'legacy-pat');
  assert.equal(legacy.has('pat'), false, 'the file copy is drained');
  assert.equal((await store(keychain, legacy).get('github')).token, null, 'the ADO file entry is not mistaken for a GitHub token');
});

test('When_the_keychain_refuses_the_legacy_PAT_is_still_returned_but_flagged_with_the_refusal', async () => {
  const keychain = new FakeKeychain({ mode: 'refuse', error: 'no secret service' });
  const legacy = new MemoryStore({ pat: 'legacy-pat' });
  const read = await store(keychain, legacy).get('azure-devops');
  assert.equal(read.token, 'legacy-pat');
  assert.equal(read.source, 'legacy-file');
  assert.match(read.error, /no secret service/);
  assert.equal(legacy.get('pat'), 'legacy-pat', 'not deleted until the keychain has it');
});

test('An_empty_token_is_refused_and_an_unknown_provider_is_a_bug_that_throws', async () => {
  const s = store(new FakeKeychain());
  assert.equal((await s.set('github', '')).ok, false);
  await assert.rejects(s.set('gitlab', 'x'), /unknown provider "gitlab"/);
  await assert.rejects(s.get('gitlab'), /unknown provider/);
});

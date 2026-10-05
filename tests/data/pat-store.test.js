'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PatStore, SERVICE_NAME, ACCOUNT_NAME } = require('../../src/main/pat-store');
const { FakeKeychain, MemoryStore } = require('../helpers/fakes');

const quiet = () => {};
const store = (keychain, legacyStore = new MemoryStore(), timeoutMs = 50) => new PatStore({ keychain, legacyStore, timeoutMs, log: quiet });

test('The_PAT_reaches_the_OS_keychain_and_nothing_else_and_reads_back_from_it', async () => {
  const keychain = new FakeKeychain();
  const legacy = new MemoryStore();
  const s = store(keychain, legacy);

  assert.deepEqual(await s.set('pat-123'), { ok: true, error: null });
  assert.equal(keychain.entries.get(`${SERVICE_NAME}/${ACCOUNT_NAME}`), 'pat-123');
  assert.equal(legacy.writes, 0, 'no file write');
  assert.equal(legacy.has('pat'), false);

  assert.deepEqual(await store(keychain, legacy).get(), { pat: 'pat-123', source: 'keychain', error: null });
});

// Regression: the old store wrote the file first, logged success, and only
// then tried the keychain; a refused keychain was a console line and the
// PAT lived in an obfuscated JSON file. Now the refusal is the result.
test('A_refusing_keychain_is_reported_as_a_failed_save_and_the_PAT_is_written_nowhere', async () => {
  const keychain = new FakeKeychain({ mode: 'refuse', error: 'User denied access' });
  const legacy = new MemoryStore();
  const result = await store(keychain, legacy).set('pat-123');
  assert.equal(result.ok, false);
  assert.match(result.error, /refused the PAT \(User denied access\)/);
  assert.match(result.error, /in memory for this session only/);
  assert.equal(keychain.entries.size, 0);
  assert.equal(legacy.writes, 0);
  assert.deepEqual(await store(keychain, legacy).get(), { pat: null, source: null, error: 'User denied access' });
});

test('A_hanging_keychain_times_out_and_the_timeout_is_reported_not_swallowed', async () => {
  const keychain = new FakeKeychain({ mode: 'hang' });
  const s = store(keychain, new MemoryStore(), 30);
  const t0 = Date.now();
  const result = await s.set('pat-123');
  assert.ok(Date.now() - t0 < 1000, 'bounded by the timeout, not the hang');
  assert.equal(result.ok, false);
  assert.match(result.error, /keychain\.setPassword timed out after 30ms/);
  const read = await s.get();
  assert.equal(read.pat, null);
  assert.match(read.error, /keychain\.getPassword timed out/);
});

test('No_keychain_backend_at_all_is_reported_as_unavailable_rather_than_silently_succeeding', async () => {
  const s = store(null);
  const result = await s.set('pat-123');
  assert.equal(result.ok, false);
  assert.match(result.error, /not available/);
  assert.match((await s.get()).error, /not available/);
});

test('Delete_removes_the_PAT_from_the_keychain_and_the_legacy_file_and_reports_a_refusal', async () => {
  const keychain = new FakeKeychain();
  const legacy = new MemoryStore({ pat: 'old' });
  const s = store(keychain, legacy);
  await s.set('pat-123');
  legacy.set('pat', 'stale-copy');
  assert.deepEqual(await s.delete(), { ok: true, error: null });
  assert.equal(keychain.entries.size, 0);
  assert.equal(legacy.has('pat'), false);
  assert.deepEqual(await s.get(), { pat: null, source: null, error: null });

  const refusing = new FakeKeychain({ mode: 'refuse', error: 'locked' });
  const r = await store(refusing, new MemoryStore()).delete();
  assert.equal(r.ok, false);
  assert.match(r.error, /locked/);
});

test('A_PAT_left_in_the_legacy_file_by_an_older_version_is_moved_into_the_keychain_on_first_read', async () => {
  const keychain = new FakeKeychain();
  const legacy = new MemoryStore({ pat: 'legacy-pat' });
  const read = await store(keychain, legacy).get();
  assert.deepEqual(read, { pat: 'legacy-pat', source: 'keychain', error: null });
  assert.equal(keychain.entries.get(`${SERVICE_NAME}/${ACCOUNT_NAME}`), 'legacy-pat');
  assert.equal(legacy.has('pat'), false, 'the file copy is drained');
});

test('When_the_keychain_refuses_the_legacy_PAT_is_still_returned_but_flagged_with_the_refusal', async () => {
  const keychain = new FakeKeychain({ mode: 'refuse', error: 'no secret service' });
  const legacy = new MemoryStore({ pat: 'legacy-pat' });
  const read = await store(keychain, legacy).get();
  assert.equal(read.pat, 'legacy-pat');
  assert.equal(read.source, 'legacy-file');
  assert.match(read.error, /no secret service/);
  assert.equal(legacy.get('pat'), 'legacy-pat', 'not deleted until the keychain has it');
});

test('Saving_an_empty_PAT_is_refused', async () => {
  assert.equal((await store(new FakeKeychain()).set('')).ok, false);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Conf = require('conf'); // electron-store's base class; same options, no Electron
const {
  SETTINGS_DEFAULTS, SETTINGS_KEYS, SAVEABLE_KEYS, createSettingsStore, readSettings, writeSettings,
} = require('../../src/main/settings');
const { tempDir } = require('../helpers/fakes');

const open = (cwd) => createSettingsStore(Conf, { cwd, configName: 'config' });

test('Every_setting_round_trips_through_the_file_and_reads_back_identical_after_reopening', () => {
  const cwd = tempDir();
  const store = open(cwd);
  const values = {
    orgUrl: 'https://dev.azure.com/o',
    providerUrls: { github: 'https://github.com/acme' },
    activeProvider: 'github',
    webhookPort: 4000,
    webhookHost: '0.0.0.0',
    webhookSecret: 's3',
    promptPath: '/p.md',
    pollingIntervalMs: 5000,
    defaultAgent: 'augment',
    agentModels: { claude: 'claude-opus-4-6' },
    repoConfigs: { 'A/r': { mode: 'repo', repoFile: 'x.md' } },
    starredRepos: ['A/r'],
    maxPrAgeDays: 3,
    lastUsedRepos: { A: 'r' },
    bugsAgent: 'codex',
    bugsAgentModels: { codex: 'o3' },
    bugsRepoConfigs: { 'A/r': 'bugs.md' },
    ticketsAgent: 'claude',
    ticketsAgentModels: { claude: 'x' },
    ticketsRepoConfigs: { 'A/r': 'tickets.md' },
    bugsFilters: { scope: 'all', prFilter: 'has' },
    ticketsFilters: { scope: 'all', prFilter: 'all' },
  };
  assert.deepEqual(Object.keys(values).sort(), [...SETTINGS_KEYS].sort(), 'this test covers every key');
  for (const [k, v] of Object.entries(values)) store.set(k, v);

  const reopened = open(cwd);
  assert.deepEqual(readSettings(reopened), values);
  assert.ok(fs.existsSync(path.join(cwd, 'config.json')));
});

test('A_config_written_by_an_older_version_loads_the_new_keys_defaults_instead_of_undefined', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({ orgUrl: 'https://dev.azure.com/old', webhookPort: 3847 }));
  const settings = readSettings(open(cwd));
  assert.equal(settings.orgUrl, 'https://dev.azure.com/old');
  assert.deepEqual(settings.bugsFilters, { scope: 'mine', prFilter: 'none' });
  assert.equal(settings.webhookHost, '127.0.0.1');
  assert.deepEqual(settings.starredRepos, []);
  for (const key of SETTINGS_KEYS) assert.notEqual(settings[key], undefined, `${key} is undefined`);
});

// Regression: electron-store's default is clearInvalidConfig: false, so a
// truncated or hand-edited config.json threw a SyntaxError at module load,
// before app.whenReady — the app died with nothing on screen.
test('A_corrupt_config_file_never_blocks_a_launch_it_is_reset_to_defaults', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'config.json'), '{"orgUrl": "https://dev.azure.com/o", "webhookPo');
  let store;
  assert.doesNotThrow(() => { store = open(cwd); });
  assert.deepEqual(readSettings(store), SETTINGS_DEFAULTS);
  store.set('orgUrl', 'https://dev.azure.com/again');
  assert.equal(open(cwd).get('orgUrl'), 'https://dev.azure.com/again');
});

test('The_settings_screen_can_write_every_key_except_the_org_URL_and_ignores_keys_it_did_not_send', () => {
  const store = open(tempDir());
  store.set('orgUrl', 'https://dev.azure.com/keep');
  const written = writeSettings(store, { orgUrl: 'https://evil', maxPrAgeDays: 14, unknownKey: 1, promptPath: undefined });
  assert.deepEqual(written, ['maxPrAgeDays']);
  assert.equal(store.get('orgUrl'), 'https://dev.azure.com/keep');
  assert.equal(store.get('maxPrAgeDays'), 14);
  assert.equal(store.get('promptPath'), '');
  assert.ok(!SAVEABLE_KEYS.includes('orgUrl'));
  assert.deepEqual(writeSettings(store, null), []);
});

test('Defaults_handed_to_the_store_are_a_copy_so_a_mutation_through_the_store_cannot_bleed_into_the_next_store', () => {
  const a = open(tempDir());
  const filters = a.get('bugsFilters');
  filters.scope = 'all';
  a.set('bugsFilters', filters);
  const b = open(tempDir());
  assert.deepEqual(b.get('bugsFilters'), { scope: 'mine', prFilter: 'none' });
  assert.deepEqual(SETTINGS_DEFAULTS.bugsFilters, { scope: 'mine', prFilter: 'none' });
});

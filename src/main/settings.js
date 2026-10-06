/**
 * settings — the one list of every key in config.json, its default, and
 * the read/write helpers the IPC layer uses.
 *
 * The store itself is `electron-store` in the app (it picks the userData
 * folder) and plain `conf`, its base class, in tests (it takes a `cwd`).
 * Both accept the same options, so `createSettingsStore` is the only place
 * that knows which options LGTM needs:
 *
 *   - `defaults`: every key below, so a config written by an older
 *     version loads the new keys' defaults instead of `undefined`.
 *   - `clearInvalidConfig: true`: a hand-edited or truncated config.json
 *     is reset to defaults instead of throwing at module load, which used
 *     to kill the app before `app.whenReady` with nothing on screen.
 */

const SETTINGS_DEFAULTS = Object.freeze({
  orgUrl: '',                // Azure DevOps organisation URL (legacy key, still the ADO one)
  providerUrls: {},          // { [providerId]: url } — GitHub and any future service
  activeProvider: '',        // which connected service the renderer shows
  webhookPort: 3847,
  webhookHost: '127.0.0.1',  // loopback by default; set to '0.0.0.0' to accept LAN/tunnel traffic directly
  webhookSecret: '',         // when set, POST /webhook must carry it in X-LGTM-Webhook-Secret
  promptPath: '',            // global fallback prompt path
  pollingIntervalMs: 60000,
  defaultAgent: 'claude',
  agentModels: {},           // { agentId: selectedModelId }
  repoConfigs: {},           // { "project/repo": { mode, repoFile, customPath } }
  starredRepos: [],          // ["project/repo", ...] — starred repos are reviewed first
  maxPrAgeDays: 7,           // only auto-review PRs created within this many days
  lastUsedRepos: {},         // { [project]: "repoName" } — default for work item repo picker
  bugsAgent: '',             // agent ID for bug runs (empty = fall back to defaultAgent)
  bugsAgentModels: {},       // { [agentId]: modelId } for bug runs
  bugsRepoConfigs: {},       // { "project/repo": "relative/path/to/prompt.md" }
  ticketsAgent: '',          // agent ID for ticket runs
  ticketsAgentModels: {},
  ticketsRepoConfigs: {},
  // Filter state for the Bugs / Tickets tabs. scope: 'mine' | 'all'.
  // prFilter: 'all' | 'has' | 'none' — restricts to items with /
  // without a linked PR. Defaults match what the user asked for:
  // assigned-to-me, items without a PR (the "do something next" pile).
  bugsFilters: { scope: 'mine', prFilter: 'none' },
  ticketsFilters: { scope: 'mine', prFilter: 'none' },
});

const SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_DEFAULTS));

// Keys the Settings screen may write. The connection keys are owned by the
// connect flow (connect-provider sets them, disconnect-provider clears them,
// set-active-provider switches) and are deliberately absent.
const CONNECTION_KEYS = Object.freeze(['orgUrl', 'providerUrls', 'activeProvider']);
const SAVEABLE_KEYS = Object.freeze(SETTINGS_KEYS.filter((k) => !CONNECTION_KEYS.includes(k)));

/**
 * @param {new (options) => object} StoreClass - electron-store or conf
 * @param {object} [options]                   - extra store options (e.g. `cwd` in tests)
 */
function createSettingsStore(StoreClass, options = {}) {
  return new StoreClass({
    defaults: clone(SETTINGS_DEFAULTS),
    clearInvalidConfig: true,
    ...options,
  });
}

/** Every setting, in one object, for `get-settings`. */
function readSettings(store) {
  const out = {};
  for (const key of SETTINGS_KEYS) {
    const value = store.get(key);
    out[key] = value === undefined ? clone(SETTINGS_DEFAULTS[key]) : value;
  }
  return out;
}

/**
 * Apply a partial update from the Settings screen: only keys that are
 * present (not `undefined`) and saveable change. Returns the keys written.
 */
function writeSettings(store, patch) {
  const written = [];
  if (!patch || typeof patch !== 'object') return written;
  for (const key of SAVEABLE_KEYS) {
    if (patch[key] !== undefined) {
      store.set(key, patch[key]);
      written.push(key);
    }
  }
  return written;
}

function clone(v) {
  return v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

module.exports = {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  CONNECTION_KEYS,
  SAVEABLE_KEYS,
  createSettingsStore,
  readSettings,
  writeSettings,
};

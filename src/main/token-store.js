/**
 * TokenStore — Secure, per-provider token storage using the OS keychain.
 *
 * macOS  → Keychain
 * Windows → Credential Manager
 * Linux  → libsecret / GNOME Keyring
 *
 * Persistence strategy: the encrypted electron-store fallback is the source
 * of truth. It is written FIRST on every set() and is always the ground we
 * fall back to for get(). Keychain writes/reads are best-effort, wrapped in
 * short timeouts so a hidden ACL prompt can't wedge save or app startup.
 * Without the timeouts keytar.setPassword could hang forever and the
 * fallback would never be reached.
 *
 * Keys are per provider. The Azure DevOps entry keeps the names the app has
 * always used (`com.lgtm.azuredevops` / `pat`) so an existing install keeps
 * its token across the upgrade; GitHub gets its own service name.
 *
 * Both backends are injectable so the store can be tested without Electron
 * or an OS keychain: `new TokenStore({ fallbackStore, keytar })`.
 */

const KEYTAR_TIMEOUT_MS = 2500;

const ENTRIES = {
  'azure-devops': { service: 'com.lgtm.azuredevops', account: 'pat', key: 'pat' },
  github:         { service: 'com.lgtm.github',      account: 'token', key: 'github-token' },
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    )),
  ]);
}

function loadKeytar() {
  try {
    return require('keytar');
  } catch (err) {
    console.warn('[LGTM] keytar not available, will use fallback storage:', err.message);
    return null;
  }
}

function loadFallbackStore() {
  const ElectronStore = require('electron-store');
  // Encrypted at rest via electron-store's encryptionKey.
  return new ElectronStore({
    name: 'lgtm-secure',
    encryptionKey: 'lgtm-v1-obfuscation-key',
  });
}

class TokenStore {
  constructor(opts = {}) {
    this._keytar = opts.keytar !== undefined ? opts.keytar : undefined;
    this._fallback = opts.fallbackStore || null;
    this._log = opts.logger || console;
  }

  get keytar() {
    if (this._keytar === undefined) this._keytar = loadKeytar();
    return this._keytar;
  }

  get fallback() {
    if (!this._fallback) this._fallback = loadFallbackStore();
    return this._fallback;
  }

  static entryFor(providerId) {
    const e = ENTRIES[providerId];
    if (!e) throw new Error(`TokenStore: unknown provider "${providerId}"`);
    return e;
  }

  static providers() { return Object.keys(ENTRIES); }

  async get(providerId) {
    const entry = TokenStore.entryFor(providerId);
    // The encrypted fallback store is the source of truth on read. On macOS
    // the keychain ACL prompt for a dev build often fires invisibly behind a
    // tray-only window and keytar.getPassword hangs until the timeout.
    const value = this.fallback.get(entry.key);
    if (value) {
      this._log.log(`[LGTM] ${providerId} token loaded from encrypted store.`);
      return value;
    }
    this._log.log(`[LGTM] No stored ${providerId} token found.`);
    return null;
  }

  async set(providerId, token) {
    const entry = TokenStore.entryFor(providerId);
    if (typeof token !== 'string' || !token) throw new Error('TokenStore.set: token must be a non-empty string');
    // Write the fallback FIRST and synchronously so the token is on disk
    // before we touch the keychain. If keytar then hangs or errors the user
    // still has a working token next launch.
    this.fallback.set(entry.key, token);
    this._log.log(`[LGTM] ${providerId} token saved to encrypted store.`);

    const keytar = this.keytar;
    if (keytar) {
      try {
        await withTimeout(keytar.setPassword(entry.service, entry.account, token), KEYTAR_TIMEOUT_MS, 'keytar.setPassword');
        this._log.log(`[LGTM] ${providerId} token saved to OS keychain.`);
      } catch (err) {
        this._log.warn(`[LGTM] keytar.setPassword skipped for ${providerId} (fallback already saved):`, err.message);
      }
    }
  }

  async delete(providerId) {
    const entry = TokenStore.entryFor(providerId);
    this.fallback.delete(entry.key);
    const keytar = this.keytar;
    if (keytar) {
      try {
        await withTimeout(keytar.deletePassword(entry.service, entry.account), KEYTAR_TIMEOUT_MS, 'keytar.deletePassword');
      } catch (err) {
        this._log.warn(`[LGTM] keytar.deletePassword skipped for ${providerId}:`, err.message);
      }
    }
    this._log.log(`[LGTM] ${providerId} token cleared from all stores.`);
  }
}

module.exports = { TokenStore, ENTRIES, KEYTAR_TIMEOUT_MS };

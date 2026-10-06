/**
 * TokenStore — one token per connected git service, in the OS keychain and
 * nowhere else.
 *
 * macOS   → Keychain
 * Windows → Credential Manager
 * Linux   → libsecret / GNOME Keyring
 *
 * Contract (the Secrets row of Platform-Standards/process/testing.md):
 *   - `set()` reports success only after the keychain write returned. A
 *     refusing or hanging keychain is reported to the caller, not worked
 *     around with a file.
 *   - `get()` reads the keychain back. Nothing else is consulted for a
 *     token saved by this version.
 *   - `delete()` removes the token from the keychain and from the legacy
 *     file described below.
 *
 * Keys are per provider. The Azure DevOps entry keeps the names the app has
 * always used (`com.lgtm.azuredevops` / `pat`) so an existing install keeps
 * its PAT across the upgrade; GitHub gets its own service name.
 *
 * Legacy file store (read-only, drained on sight): versions up to 0.5.x
 * kept the Azure DevOps PAT in an electron-store file (`lgtm-secure.json`)
 * obfuscated with a key hard-coded in this file, and treated that file as
 * the source of truth. On the first `get()` that finds a token there, it is
 * moved into the keychain and the file entry deleted. If the keychain
 * refuses, the legacy value is still returned (the user already had it on
 * disk) with `source: 'legacy-file'` and the keychain error, so the UI can
 * say so. New tokens are never written to that file.
 *
 * Every keychain call is capped by a timeout so a hidden ACL prompt (an
 * unsigned dev build on macOS) cannot wedge startup; the timeout is
 * reported like any other refusal.
 *
 * Both backends are injectable so the store can be tested without Electron
 * or an OS keychain: `new TokenStore({ keychain, legacyStore })`.
 */

const KEYTAR_TIMEOUT_MS = 2500;
const LEGACY_STORE_NAME = 'lgtm-secure';
const LEGACY_STORE_KEY = 'lgtm-v1-obfuscation-key';

const ENTRIES = {
  'azure-devops': { service: 'com.lgtm.azuredevops', account: 'pat', key: 'pat' },
  github:         { service: 'com.lgtm.github',      account: 'token', key: 'github-token' },
};

function defaultKeychain(log) {
  try {
    return require('keytar');
  } catch (err) {
    log(`[LGTM] keytar not available: ${err.message}`);
    return null;
  }
}

function defaultLegacyStore(log) {
  try {
    const ElectronStore = require('electron-store');
    return new ElectronStore({ name: LEGACY_STORE_NAME, encryptionKey: LEGACY_STORE_KEY, clearInvalidConfig: true });
  } catch (err) {
    log(`[LGTM] legacy token store unavailable: ${err.message}`);
    return null;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

class TokenStore {
  /**
   * @param {object} [deps]
   * @param {object|null} [deps.keychain]    - keytar-shaped: getPassword/setPassword/deletePassword(service, account)
   * @param {object|null} [deps.legacyStore] - get/set/delete(key) store holding the pre-keychain copy; null to skip migration
   * @param {number} [deps.timeoutMs]
   * @param {(line: string) => void} [deps.log]
   */
  constructor({ keychain, legacyStore, timeoutMs = KEYTAR_TIMEOUT_MS, log = console.log } = {}) {
    this.log = log;
    this.keychain = keychain === undefined ? defaultKeychain(log) : keychain;
    this.legacyStore = legacyStore === undefined ? defaultLegacyStore(log) : legacyStore;
    this.timeoutMs = timeoutMs;
  }

  static entryFor(providerId) {
    const e = ENTRIES[providerId];
    if (!e) throw new Error(`TokenStore: unknown provider "${providerId}"`);
    return e;
  }

  static providers() { return Object.keys(ENTRIES); }

  /**
   * @returns {Promise<{ token: string|null, source: 'keychain'|'legacy-file'|null, error: string|null }>}
   */
  async get(providerId) {
    const entry = TokenStore.entryFor(providerId);
    let keychainError = null;
    if (this.keychain) {
      try {
        const token = await withTimeout(
          this.keychain.getPassword(entry.service, entry.account),
          this.timeoutMs,
          'keychain.getPassword',
        );
        if (token) {
          this.log(`[LGTM] ${providerId} token loaded from OS keychain.`);
          return { token, source: 'keychain', error: null };
        }
      } catch (err) {
        keychainError = err.message;
        this.log(`[LGTM] keychain read failed for ${providerId}: ${err.message}`);
      }
    } else {
      keychainError = 'OS keychain is not available on this machine.';
    }

    const legacy = this._readLegacy(entry);
    if (legacy) {
      if (!keychainError) {
        const moved = await this.set(providerId, legacy);
        if (moved.ok) {
          this.log(`[LGTM] ${providerId} token migrated from the legacy file store into the OS keychain.`);
          return { token: legacy, source: 'keychain', error: null };
        }
        keychainError = moved.error;
      }
      this.log(`[LGTM] ${providerId} token loaded from the legacy file store; keychain unavailable: ${keychainError}`);
      return { token: legacy, source: 'legacy-file', error: keychainError };
    }

    this.log(`[LGTM] No stored ${providerId} token found.`);
    return { token: null, source: null, error: keychainError };
  }

  /**
   * Write the token to the keychain. Resolves `{ ok: true }` only once the
   * keychain has confirmed the write; `{ ok: false, error }` otherwise.
   * Never throws for a keychain problem; an unknown provider is a bug and
   * does throw.
   */
  async set(providerId, token) {
    const entry = TokenStore.entryFor(providerId);
    if (typeof token !== 'string' || !token) return { ok: false, error: 'No token to store.' };
    if (!this.keychain) {
      return { ok: false, error: 'OS keychain is not available on this machine; the token is kept in memory for this session only.' };
    }
    try {
      await withTimeout(
        this.keychain.setPassword(entry.service, entry.account, token),
        this.timeoutMs,
        'keychain.setPassword',
      );
    } catch (err) {
      this.log(`[LGTM] keychain write failed for ${providerId}: ${err.message}`);
      return { ok: false, error: `OS keychain refused the token (${err.message}); it is kept in memory for this session only.` };
    }
    this.log(`[LGTM] ${providerId} token saved to OS keychain.`);
    this._deleteLegacy(entry);
    return { ok: true, error: null };
  }

  /** Remove the token from the keychain and the legacy file. Never throws for a keychain problem. */
  async delete(providerId) {
    const entry = TokenStore.entryFor(providerId);
    this._deleteLegacy(entry);
    if (!this.keychain) return { ok: true, error: null };
    try {
      await withTimeout(
        this.keychain.deletePassword(entry.service, entry.account),
        this.timeoutMs,
        'keychain.deletePassword',
      );
      this.log(`[LGTM] ${providerId} token cleared from OS keychain.`);
      return { ok: true, error: null };
    } catch (err) {
      this.log(`[LGTM] keychain delete failed for ${providerId}: ${err.message}`);
      return { ok: false, error: `OS keychain refused to delete the token: ${err.message}` };
    }
  }

  _readLegacy(entry) {
    if (!this.legacyStore) return null;
    try { return this.legacyStore.get(entry.key) || null; } catch { return null; }
  }

  _deleteLegacy(entry) {
    if (!this.legacyStore) return;
    try { this.legacyStore.delete(entry.key); } catch { /* best effort */ }
  }
}

module.exports = { TokenStore, ENTRIES, KEYTAR_TIMEOUT_MS, LEGACY_STORE_NAME };

/**
 * PatStore — the Azure DevOps PAT lives in the OS keychain and nowhere else.
 *
 * macOS   → Keychain
 * Windows → Credential Manager
 * Linux   → libsecret / GNOME Keyring
 *
 * Contract (the Secrets row of Platform-Standards/process/testing.md):
 *   - `set()` reports success only after the keychain write returned. A
 *     refusing or hanging keychain is reported to the caller, not worked
 *     around with a file.
 *   - `get()` reads the keychain back. Nothing else is consulted for a PAT
 *     saved by this version.
 *   - `delete()` removes the PAT from the keychain and from the legacy
 *     file described below.
 *
 * Legacy file store (read-only, drained on sight): versions up to 0.5.x
 * kept the PAT in an electron-store file (`lgtm-secure.json`) obfuscated
 * with a key hard-coded in this file, and treated that file as the source
 * of truth. On the first `get()` that finds a PAT there, it is moved into
 * the keychain and the file entry deleted. If the keychain refuses, the
 * legacy value is still returned (the user already had it on disk) with
 * `source: 'legacy-file'` and the keychain error, so the UI can say so.
 * New PATs are never written to that file.
 *
 * Every keychain call is capped by a timeout so a hidden ACL prompt
 * (an unsigned dev build on macOS) cannot wedge startup; the timeout is
 * reported like any other refusal.
 */

const SERVICE_NAME = 'com.lgtm.azuredevops';
const ACCOUNT_NAME = 'pat';
const LEGACY_STORE_NAME = 'lgtm-secure';
const LEGACY_STORE_KEY = 'lgtm-v1-obfuscation-key';
const KEYTAR_TIMEOUT_MS = 2500;

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
    log(`[LGTM] legacy PAT store unavailable: ${err.message}`);
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

class PatStore {
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

  /**
   * @returns {Promise<{ pat: string|null, source: 'keychain'|'legacy-file'|null, error: string|null }>}
   */
  async get() {
    let keychainError = null;
    if (this.keychain) {
      try {
        const pat = await withTimeout(
          this.keychain.getPassword(SERVICE_NAME, ACCOUNT_NAME),
          this.timeoutMs,
          'keychain.getPassword',
        );
        if (pat) {
          this.log('[LGTM] PAT loaded from OS keychain.');
          return { pat, source: 'keychain', error: null };
        }
      } catch (err) {
        keychainError = err.message;
        this.log(`[LGTM] keychain read failed: ${err.message}`);
      }
    } else {
      keychainError = 'OS keychain is not available on this machine.';
    }

    const legacy = this._readLegacy();
    if (legacy) {
      if (!keychainError) {
        const moved = await this.set(legacy);
        if (moved.ok) {
          this.log('[LGTM] PAT migrated from the legacy file store into the OS keychain.');
          return { pat: legacy, source: 'keychain', error: null };
        }
        keychainError = moved.error;
      }
      this.log(`[LGTM] PAT loaded from the legacy file store; keychain unavailable: ${keychainError}`);
      return { pat: legacy, source: 'legacy-file', error: keychainError };
    }

    this.log('[LGTM] No stored PAT found.');
    return { pat: null, source: null, error: keychainError };
  }

  /**
   * Write the PAT to the keychain. Resolves `{ ok: true }` only once the
   * keychain has confirmed the write; `{ ok: false, error }` otherwise.
   * Never throws.
   */
  async set(pat) {
    if (!pat) return { ok: false, error: 'No PAT to store.' };
    if (!this.keychain) {
      return { ok: false, error: 'OS keychain is not available on this machine; the PAT is kept in memory for this session only.' };
    }
    try {
      await withTimeout(
        this.keychain.setPassword(SERVICE_NAME, ACCOUNT_NAME, pat),
        this.timeoutMs,
        'keychain.setPassword',
      );
    } catch (err) {
      this.log(`[LGTM] keychain write failed: ${err.message}`);
      return { ok: false, error: `OS keychain refused the PAT (${err.message}); it is kept in memory for this session only.` };
    }
    this.log('[LGTM] PAT saved to OS keychain.');
    this._deleteLegacy();
    return { ok: true, error: null };
  }

  /** Remove the PAT from the keychain and the legacy file. Never throws. */
  async delete() {
    this._deleteLegacy();
    if (!this.keychain) return { ok: true, error: null };
    try {
      await withTimeout(
        this.keychain.deletePassword(SERVICE_NAME, ACCOUNT_NAME),
        this.timeoutMs,
        'keychain.deletePassword',
      );
      this.log('[LGTM] PAT cleared from OS keychain.');
      return { ok: true, error: null };
    } catch (err) {
      this.log(`[LGTM] keychain delete failed: ${err.message}`);
      return { ok: false, error: `OS keychain refused to delete the PAT: ${err.message}` };
    }
  }

  _readLegacy() {
    if (!this.legacyStore) return null;
    try { return this.legacyStore.get('pat') || null; } catch { return null; }
  }

  _deleteLegacy() {
    if (!this.legacyStore) return;
    try { this.legacyStore.delete('pat'); } catch { /* best effort */ }
  }
}

module.exports = { PatStore, SERVICE_NAME, ACCOUNT_NAME, LEGACY_STORE_NAME };

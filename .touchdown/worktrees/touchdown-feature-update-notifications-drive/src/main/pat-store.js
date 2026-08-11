/**
 * PatStore — Secure PAT storage using OS keychain.
 *
 * macOS  → Keychain
 * Windows → Credential Manager
 * Linux  → libsecret / GNOME Keyring
 *
 * Persistence strategy: the encrypted electron-store fallback is the
 * source of truth — it's written FIRST on every set() and is always
 * the ground we can fall back to for get(). Keychain writes/reads are
 * best-effort, wrapped in short timeouts so a hidden ACL prompt can't
 * wedge save or app startup. Without the timeouts, keytar.setPassword
 * could hang forever and the fallback would never be reached, leaving
 * the user with a "validate every launch" experience.
 */

let keytar;
try {
  keytar = require('keytar');
} catch (err) {
  console.warn('[LGTM] keytar not available, will use fallback storage:', err.message);
  keytar = null;
}

const ElectronStore = require('electron-store');

const SERVICE_NAME = 'com.lgtm.azuredevops';
const ACCOUNT_NAME = 'pat';

// Cap any keychain interaction so a stuck prompt can't block forever.
const KEYTAR_TIMEOUT_MS = 2500;

// Fallback store — encrypted at rest via electron-store's encryptionKey
const fallbackStore = new ElectronStore({
  name: 'lgtm-secure',
  encryptionKey: 'lgtm-v1-obfuscation-key',
});

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    )),
  ]);
}

class PatStore {
  async get() {
    // The encrypted fallback store is the source of truth on read.
    // We used to consult keytar first, but on macOS the keychain
    // ACL prompt for an Electron dev build often fires invisibly
    // behind a tray-only window — keytar.getPassword then hangs
    // until our 2.5s timeout, by which point the renderer has
    // already finished loading and missed the pat-status event.
    // The fallback store is encrypted at rest with electron-store
    // and is set on every successful save, so it's always current.
    const fallback = fallbackStore.get('pat');
    if (fallback) {
      console.log('[LGTM] PAT loaded from fallback encrypted store.');
      return fallback;
    }
    console.log('[LGTM] No stored PAT found.');
    return null;
  }

  async set(pat) {
    // Write the fallback FIRST and synchronously so the PAT is on
    // disk before we touch the keychain. If keytar then hangs or
    // errors the user still has a working PAT next launch.
    fallbackStore.set('pat', pat);
    console.log('[LGTM] PAT saved to fallback encrypted store.');

    if (keytar) {
      try {
        await withTimeout(
          keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, pat),
          KEYTAR_TIMEOUT_MS,
          'keytar.setPassword',
        );
        console.log('[LGTM] PAT saved to OS keychain.');
      } catch (err) {
        console.warn('[LGTM] keytar.setPassword skipped (fallback already saved):', err.message);
      }
    }
  }

  async delete() {
    fallbackStore.delete('pat');
    if (keytar) {
      try {
        await withTimeout(
          keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME),
          KEYTAR_TIMEOUT_MS,
          'keytar.deletePassword',
        );
      } catch (err) {
        console.warn('[LGTM] keytar.deletePassword skipped:', err.message);
      }
    }
    console.log('[LGTM] PAT cleared from all stores.');
  }
}

module.exports = { PatStore };

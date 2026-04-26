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
    // Read the fallback synchronously up front. If we get a hit here
    // we'll return it even if keytar holds a (theoretically newer)
    // value — they're written together, so they should match.
    const fallback = fallbackStore.get('pat');

    if (keytar) {
      try {
        const pat = await withTimeout(
          keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME),
          KEYTAR_TIMEOUT_MS,
          'keytar.getPassword',
        );
        if (pat) {
          console.log('[LGTM] PAT loaded from OS keychain.');
          return pat;
        }
      } catch (err) {
        console.warn('[LGTM] keytar.getPassword skipped:', err.message);
      }
    }

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
